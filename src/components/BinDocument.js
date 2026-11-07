import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** One read asks for at most this much (the webview reads 64 KB blocks). */
const READ_MAX = 1024 * 1024;
/** Free space kept beyond the size of a file being rewritten. */
export const REWRITE_SLACK = 1024 * 1024;
const COPY_CHUNK = 1024 * 1024;
/** How many first bytes of a file VS Code looks at to tell binary from text (`ZERO_BYTE_DETECTION_BUFFER_MAX_LEN`). */
const BINARY_PROBE = 512;

/**
 * @typedef {import('../editor/PieceTable.js').Piece} Piece
 * @typedef {{ size: number, mtime: number }} FileStamp a file's size and modification time (ms)
 */

/**
 * A local file open in the bin editor (the `CustomDocument` of `BinEditor`), and its disk work —
 * what the server of Claude-AI's hex view did: reading byte ranges of a file of any size, the
 * free space of its disk, writing new bytes in place, rebuilding the file from pieces through a
 * temporary copy, and backups of unsaved pieces. The edits themselves live in the webview.
 * Nothing here uses the VS Code API.
 */
export class BinDocument {

    /**
     * @param {import('vscode').Uri} uri
     * @param {string} file its path
     * @param {FileStamp} stamp
     */
    constructor(uri, file, stamp) {
        this.uri = uri;
        this.file = file;
        /** @type {FileStamp} the file as last read or written here (an event of the watcher with it is our own) */
        this.stamp = stamp;
        /** @type {{ size: number, mtime: number, pieces: Piece[] } | null} unsaved pieces of a backup, for the webview */
        this.restored = null;
        /** VS Code takes the file for binary: its text editor shows nothing of it (`BinDocument.seemsBinary`) */
        this.binary = false;
        /** @type {(() => void)[]} */
        this._onDispose = [];
    }

    /**
     * @param {import('vscode').Uri} uri
     * @param {string} file
     * @returns {Promise<BinDocument>}
     */
    static async open(uri, file) {
        return new BinDocument(uri, file, await BinDocument.stampOf(file));
    }

    /**
     * @param {string} file
     * @returns {Promise<FileStamp>}
     */
    static async stampOf(file) {
        const st = await fs.promises.stat(file);
        if (!st.isFile()) throw new Error(`${file}: not a file`);
        return { size: st.size, mtime: st.mtimeMs };
    }

    /**
     * Whether VS Code takes the file for binary, so that its text editor shows nothing of it and
     * opens it in `workbench.editor.defaultBinaryEditor` instead (see `bytesSeemBinary`).
     * @param {string} file
     * @returns {Promise<boolean>}
     */
    static async seemsBinary(file) {
        const fh = await fs.promises.open(file, 'r');
        try {
            const head = new Uint8Array(BINARY_PROBE);
            const { bytesRead } = await fh.read(head, 0, BINARY_PROBE, 0);
            return bytesSeemBinary(head.subarray(0, bytesRead));
        } finally {
            await fh.close();
        }
    }

    /** @param {() => void} fn runs when VS Code no longer needs the document */
    onDispose(fn) {
        this._onDispose.push(fn);
    }

    dispose() {
        for (const fn of this._onDispose.splice(0)) fn();
    }

    /**
     * Bytes of the file on disk.
     * @param {number} offset
     * @param {number} length at most READ_MAX
     * @param {boolean} [free] also tell the free space of its disk
     * @returns {Promise<FileStamp & { data: Uint8Array, free?: number | null }>}
     */
    async read(offset, length, free = false) {
        const fh = await fs.promises.open(this.file, 'r');
        try {
            const st = await fh.stat();
            const from = Math.min(st.size, Math.max(0, Math.floor(offset) || 0));
            const n = Math.min(READ_MAX, st.size - from, Math.max(0, Math.floor(length) || 0));
            const data = new Uint8Array(n);
            const { bytesRead } = n ? await fh.read(data, 0, n, from) : { bytesRead: 0 };
            this.stamp = { size: st.size, mtime: st.mtimeMs };
            return { data: data.subarray(0, bytesRead), ...this.stamp, ...(free ? { free: await diskFree(this.file) } : {}) };
        } finally {
            await fh.close();
        }
    }

    /**
     * Overwrites bytes in place: the file never grows or shrinks, so a file of any size is patched
     * without rewriting it.
     * @param {{ offset: number, data: Uint8Array }[]} patches
     * @returns {Promise<FileStamp>}
     */
    async writePatches(patches) {
        const { size } = await BinDocument.stampOf(this.file);
        if (patches.some(p => !Number.isInteger(p.offset) || p.offset < 0 || p.offset + p.data.length > size)) {
            throw new Error('A patch is outside the file');
        }
        const fh = await fs.promises.open(this.file, 'r+');
        try {
            for (const p of patches) await fh.write(p.data, 0, p.data.length, p.offset);
            await fh.sync();
        } finally {
            await fh.close();
        }
        return (this.stamp = await BinDocument.stampOf(this.file));
    }

    /**
     * Writes the edited file — ranges of this file and new bytes — to `target` (this file: a save
     * with bytes inserted or deleted; another: Save As) through a temporary file next to it, then
     * renames it over the target, so a failure midway leaves the target intact.
     * @param {Piece[]} pieces ranges refer to this file as it is now
     * @param {string} [target]
     * @returns {Promise<FileStamp>} of the target
     */
    async writeTo(pieces, target = this.file) {
        const source = await fs.promises.stat(this.file);
        let total = 0;
        for (const p of pieces) {
            if ('a' in p) total += p.a.length;
            else if (!Number.isInteger(p.d) || !Number.isInteger(p.n) || p.d < 0 || p.n < 0 || p.d + p.n > source.size) throw new Error('A piece is outside the file');
            else total += p.n;
        }
        const free = await diskFree(target);
        if (free != null && free < total + REWRITE_SLACK) throw Object.assign(new Error('Not enough disk space'), { code: 'ENOSPC', needed: total + REWRITE_SLACK, free });
        const mode = target === this.file ? source.mode : await fs.promises.stat(target).then(s => s.mode, () => 0o666);
        const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(4).toString('hex')}.bin-editor-tmp`);
        let src = null, out = null;
        try {
            src = await fs.promises.open(this.file, 'r');
            out = await fs.promises.open(tmp, 'wx', mode & 0o7777);
            const buf = Buffer.alloc(COPY_CHUNK);
            let pos = 0;
            for (const p of pieces) {
                if ('a' in p) {
                    await out.write(p.a, 0, p.a.length, pos);
                    pos += p.a.length;
                    continue;
                }
                for (let done = 0; done < p.n;) {
                    const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, p.n - done), p.d + done);
                    if (!bytesRead) throw new Error('The file got shorter while being written');
                    await out.write(buf, 0, bytesRead, pos);
                    pos += bytesRead;
                    done += bytesRead;
                }
            }
            await out.sync();
            await out.close();
            out = null;
            await src.close();
            src = null;
            await fs.promises.chmod(tmp, mode & 0o7777);
            await fs.promises.rename(tmp, target);
        } catch (e) {
            await out?.close().catch(() => {});
            await src?.close().catch(() => {});
            await fs.promises.unlink(tmp).catch(() => {});
            throw e;
        }
        const stamp = await BinDocument.stampOf(target);
        if (target === this.file) this.stamp = stamp;
        return stamp;
    }

    /**
     * A backup of unsaved pieces (hot exit): the ranges refer to the file as it was at `stamp`.
     * @param {string} file where VS Code wants it
     * @param {FileStamp & { pieces: Piece[] }} edits
     */
    static async writeBackup(file, edits) {
        const json = {
            version: 1,
            size: edits.size,
            mtime: edits.mtime,
            pieces: edits.pieces.map(p => ('a' in p ? { a: Buffer.from(p.a).toString('base64') } : { d: p.d, n: p.n })),
        };
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, JSON.stringify(json));
    }

    /**
     * @param {string} file
     * @returns {Promise<FileStamp & { pieces: Piece[] }>}
     */
    static async readBackup(file) {
        const json = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (json?.version !== 1 || !Array.isArray(json.pieces)) throw new Error('Not a backup of the bin editor');
        return {
            size: json.size,
            mtime: json.mtime,
            pieces: json.pieces.map(p => ('a' in p ? { a: new Uint8Array(Buffer.from(p.a, 'base64')) } : { d: p.d, n: p.n })),
        };
    }
}

/**
 * VS Code's test of binary files (`detectEncodingFromBuffer`, kept as it is): a zero byte among the
 * first 512 bytes, unless a UTF-16 byte order mark comes first or the zero bytes look like UTF-16
 * text — every byte at an odd offset zero and every other not (LE), or the reverse (BE).
 * @param {Uint8Array} bytes the start of a file
 * @returns {boolean}
 */
export function bytesSeemBinary(bytes) {
    if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))) return false;
    let zero = false, le = true, be = true;
    for (let i = 0; i < bytes.length && i < BINARY_PROBE; i++) {
        const odd = i % 2 === 1, isZero = bytes[i] === 0;
        if (isZero) zero = true;
        if (odd !== isZero) le = false;
        if (odd === isZero) be = false;
        if (isZero && !le && !be) return true;
    }
    return zero && !le && !be;
}

/**
 * @param {string} file
 * @returns {Promise<number | null>} free bytes (for an unprivileged user) on the disk holding `file`, null if unknown
 */
export async function diskFree(file) {
    try {
        const s = await fs.promises.statfs(path.dirname(file));
        return s.bavail * s.bsize;
    } catch {
        return null;
    }
}
