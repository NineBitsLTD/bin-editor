/**
 * @typedef {{ d: number, n: number } | { a: Uint8Array }} Piece `n` bytes of the file on disk from
 * offset `d`, or new bytes `a`
 */

/**
 * The edited file as a piece table (ported from Claude-AI's hex view): a list of pieces — ranges of
 * the file on disk and new bytes — so overwriting, inserting and deleting never need the file in
 * memory, whatever its size. Every edit makes a new `pieces` array and never changes a piece, so an
 * array is a snapshot (the undo and redo stacks keep them). `size` is the size of the file on disk
 * the ranges refer to, `len` the length of the edited file.
 */
export class PieceTable {

    /**
     * @param {number} size the size of the file on disk
     * @param {Piece[]} [pieces] the edited file (default: the file as it is)
     */
    constructor(size, pieces) {
        this.size = size;
        this.set(pieces ?? (size ? [{ d: 0, n: size }] : []));
    }

    /**
     * @param {Piece} piece
     * @returns {number} its length
     */
    static length(piece) {
        return 'a' in piece ? piece.a.length : piece.n;
    }

    /**
     * @param {Piece[]} pieces
     * @param {number} offset a logical offset
     * @returns {[Piece[], Piece[]]} the pieces before `offset` and from it on
     */
    static split(pieces, offset) {
        const left = [], right = [];
        let pos = 0;
        for (const p of pieces) {
            const n = PieceTable.length(p);
            if (pos + n <= offset) left.push(p);
            else if (pos >= offset) right.push(p);
            else {
                const k = offset - pos;
                if ('a' in p) {
                    left.push({ a: p.a.subarray(0, k) });
                    right.push({ a: p.a.subarray(k) });
                } else {
                    left.push({ d: p.d, n: k });
                    right.push({ d: p.d + k, n: n - k });
                }
            }
            pos += n;
        }
        return [left, right];
    }

    /**
     * @param {Piece[]} pieces
     * @returns {Piece[]} without empty pieces, neighbouring new bytes and contiguous ranges joined
     */
    static normalize(pieces) {
        const out = [];
        for (const p of pieces) {
            if (!PieceTable.length(p)) continue;
            const q = out[out.length - 1];
            if (q && 'a' in q && 'a' in p) {
                const a = new Uint8Array(q.a.length + p.a.length);
                a.set(q.a);
                a.set(p.a, q.a.length);
                out[out.length - 1] = { a };
            } else if (q && !('a' in q) && !('a' in p) && q.d + q.n === p.d) {
                out[out.length - 1] = { d: q.d, n: q.n + p.n };
            } else {
                out.push(p);
            }
        }
        return out;
    }

    /**
     * Takes another snapshot (undo, redo, a restored backup).
     * @param {Piece[]} pieces
     */
    set(pieces) {
        this.pieces = pieces;
        this.len = pieces.reduce((sum, p) => sum + PieceTable.length(p), 0);
    }

    /** @param {number} offset @param {number} value overwrites one byte */
    replace(offset, value) {
        const [left, right] = PieceTable.split(this.pieces, offset);
        this._edit([...left, { a: Uint8Array.of(value) }, ...PieceTable.split(right, 1)[1]]);
    }

    /** @param {number} offset @param {number} value inserts one byte before `offset` */
    insert(offset, value) {
        const [left, right] = PieceTable.split(this.pieces, offset);
        this._edit([...left, { a: Uint8Array.of(value) }, ...right]);
    }

    /** @param {number} offset deletes one byte */
    delete(offset) {
        const [left, right] = PieceTable.split(this.pieces, offset);
        this._edit([...left, ...PieceTable.split(right, 1)[1]]);
    }

    /** @param {Piece[]} pieces */
    _edit(pieces) {
        this.set(PieceTable.normalize(pieces));
    }

    /** @returns {boolean} unsaved: the pieces are no longer just the whole file */
    get dirty() {
        if (!this.size) return this.pieces.length > 0;
        const [p] = this.pieces;
        return !(this.pieces.length === 1 && !('a' in p) && p.d === 0 && p.n === this.size);
    }

    /** @returns {boolean} every kept byte is still at its offset and the size is the same: saving can patch in place */
    get patchable() {
        if (this.len !== this.size) return false;
        let pos = 0;
        for (const p of this.pieces) {
            if (!('a' in p) && p.d !== pos) return false;
            pos += PieceTable.length(p);
        }
        return true;
    }

    /** @returns {{ added: number, delta: number }} new bytes (overwritten or inserted) and the change of size */
    changes() {
        let added = 0;
        for (const p of this.pieces) if ('a' in p) added += p.a.length;
        return { added, delta: this.len - this.size };
    }

    /** @returns {{ offset: number, data: Uint8Array }[]} the new bytes at their offsets (for a patchable table) */
    patches() {
        const out = [];
        let pos = 0;
        for (const p of this.pieces) {
            if ('a' in p) out.push({ offset: pos, data: p.a });
            pos += PieceTable.length(p);
        }
        return out;
    }

    /**
     * `count` bytes from logical offset `start`.
     * @param {number} start
     * @param {number} count
     * @param {(offset: number) => number | undefined} diskByte a byte of the file on disk (undefined while loading)
     * @returns {{ vals: (number | undefined)[], mods: boolean[] }} the values and which of them are new
     */
    read(start, count, diskByte) {
        const vals = new Array(count), mods = new Array(count).fill(false);
        let pos = 0;
        for (const p of this.pieces) {
            const n = PieceTable.length(p);
            if (pos + n <= start) {
                pos += n;
                continue;
            }
            for (let i = Math.max(0, start - pos); i < n; i++) {
                const at = pos + i - start;
                if (at >= count) break;
                if ('a' in p) {
                    vals[at] = p.a[i];
                    mods[at] = true;
                } else {
                    vals[at] = diskByte(p.d + i);
                }
            }
            pos += n;
            if (pos >= start + count) break;
        }
        return { vals, mods };
    }
}
