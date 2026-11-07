import { PieceTable } from './PieceTable.js';

const ROW = 16;          // bytes per row
const ROW_HEIGHT = 18;   // px, the line height of `.hex__row`
const BLOCK = 64 * 1024; // bytes read from the host at once
const BLOCKS_KEPT = 128;
const MAX_HEIGHT = 8_000_000; // taller scroll areas break in browsers: larger files scale the scrollbar
const SLACK = 1024 * 1024;    // free space wanted beyond the file's size (BinDocument's REWRITE_SLACK)

/**
 * @typedef {import('./PieceTable.js').Piece} Piece
 * @typedef {import('./HostRequests.js').HostRequests} HostRequests
 */

/**
 * The hex view of one file, any size, like Midnight Commander's hex editor (ported from
 * Claude-AI's file viewer): virtual rows in a native scroller (the scrollbar scaled past
 * MAX_HEIGHT), bytes read from the host in 64 KB blocks as rows come into view, edits in a
 * `PieceTable` — overwrite, insert (when the disk has room to rewrite the file) and delete. Each
 * edit is posted to the host as an undoable edit of VS Code, which owns undo / redo and saving:
 * the undo and redo stacks here only follow its commands.
 */
export class HexView {

    /**
     * @param {HTMLElement} root
     * @param {object} options
     * @param {HostRequests} options.host
     * @param {Record<string, string>} options.strings texts of the user's language (`BinEditor._strings`)
     * @param {string} options.locale for numbers
     */
    constructor(root, { host, strings, locale }) {
        this._host = host;
        this._s = strings;
        this._locale = locale;
        /** @type {{ pieces: Piece[], cursor: number }[]} */
        this._undo = [];
        /** @type {{ pieces: Piece[], cursor: number }[]} */
        this._redo = [];
        /** Undo stopped at a save: VS Code still has older edits, they refer to the file before it. */
        this._stale = false;
        this._top = 0;
        /** The scrollTop our own scrollToRow left, so the scroll event it causes doesn't move the rows again. */
        this._expectedScroll = null;
        this._gotoOpen = false;
        this._state(null);
        this._build(root);
    }

    /**
     * A fresh state (the file is read again), keeping where the cursor was.
     * @param {{ cursor: number, col: string, insert: boolean } | null} keep
     */
    _state(keep) {
        this.h = {
            size: null, mtime: null, blocks: new Map(),
            /** @type {PieceTable | null} */ table: null,
            cursor: keep?.cursor ?? 0, col: keep?.col ?? 'hex', nibble: 0, insert: keep?.insert ?? false,
            free: null, canResize: true,
            /** @type {'disk' | 'deleted' | null} */ conflict: null,
            /** @type {string | null} */ message: null,
            /** @type {Piece[] | null} the pieces handed to the host for saving */ saving: null,
        };
    }

    /** @param {HTMLElement} root */
    _build(root) {
        this._el = root;
        root.classList.add('hex');
        root.tabIndex = 0;
        this._scroll = Object.assign(document.createElement('div'), { className: 'hex__scroll' });
        this._rows = Object.assign(document.createElement('div'), { className: 'hex__rows' });
        this._spacer = document.createElement('div');
        this._status = Object.assign(document.createElement('div'), { className: 'hex__status' });
        this._scroll.append(this._rows, this._spacer);
        root.append(this._scroll, this._status);
        this._scroll.addEventListener('scroll', () => {
            if (this._expectedScroll != null && Math.abs(this._scroll.scrollTop - this._expectedScroll) < 48) return;
            this._expectedScroll = null;
            this._top = this._topFromScroll();
            this.draw();
        }, { passive: true });
        root.addEventListener('focus', () => root.classList.add('hex--focus'));
        root.addEventListener('blur', () => root.classList.remove('hex--focus'));
        root.addEventListener('keydown', e => this._key(e));
        this._rows.addEventListener('mousedown', (e) => {
            const cell = /** @type {HTMLElement} */ (e.target).closest('[data-o]');
            if (!cell) return;
            this.h.cursor = Number(cell.dataset.o);
            this.h.col = cell.parentElement.classList.contains('hex__chars') ? 'text' : 'hex';
            this.h.nibble = 0;
            this.draw();
        });
        new ResizeObserver(() => { this._layout(); this.draw(); }).observe(root);
    }

    /**
     * Starts showing the file; `restored` are unsaved pieces of a backup (hot exit), checked by the
     * host against the file on disk.
     * @param {{ size: number, mtime: number, pieces: Piece[] } | null} [restored]
     */
    start(restored) {
        if (restored) {
            this.h.size = restored.size;
            this.h.mtime = restored.mtime;
            this.h.table = new PieceTable(restored.size);
            // Undoing the restore goes back to the file on disk
            this._undo.push({ pieces: this.h.table.pieces, cursor: 0 });
            this.h.table.set(restored.pieces);
            this._host.send('edit', { label: this._s.restoreEdits });
        }
        this._loadBlock(0);
        this._layout();
        this._scrollToRow(Math.floor(this.h.cursor / ROW) - Math.floor(this._visible() / 2));
        this.draw();
        this._el.focus({ preventScroll: true });
    }

    // ----- commands of VS Code -----

    undo() {
        const u = this._undo.pop();
        if (!u) {
            if (this._stale) this._host.send('staleUndo');
            return;
        }
        this._redo.push({ pieces: this.h.table.pieces, cursor: this.h.cursor });
        this._restore(u);
    }

    redo() {
        const r = this._redo.pop();
        if (!r) return;
        this._undo.push({ pieces: this.h.table.pieces, cursor: this.h.cursor });
        this._restore(r);
    }

    /** @param {{ pieces: Piece[], cursor: number }} snapshot */
    _restore(snapshot) {
        this.h.table.set(snapshot.pieces);
        this.h.cursor = Math.max(0, Math.min(this._last(), snapshot.cursor));
        this.h.nibble = 0;
        this._layout();
        this._reveal();
        this.draw();
    }

    /**
     * @returns {{ loaded: boolean, dirty: boolean, size: number, mtime: number, pieces: Piece[] }}
     * the edits, for saving or a backup (new bytes copied, so the message carries no larger
     * buffers); `loaded: false` before the file was read (no edits then)
     */
    edits() {
        const { table, size, mtime } = this.h;
        if (!table) return { loaded: false, dirty: false, size: 0, mtime: 0, pieces: [] };
        this.h.saving = table.pieces;
        return { loaded: true, dirty: table.dirty, size, mtime, pieces: table.pieces.map(p => ('a' in p ? { a: p.a.slice() } : p)) };
    }

    /** The host saved the file: read it again; edits made before can no longer be undone here. */
    saved() {
        const typed = this.h.table && this.h.saving && this.h.table.pieces !== this.h.saving;
        this._reload();
        if (typed) this.h.message = this._s.savedTyped;
        this.draw();
    }

    /** VS Code reverted the file (or the user chose to reload it): read it again. */
    reverted() {
        this._reload();
    }

    /** @param {boolean} exists the host saw the file change (or vanish) on disk */
    diskChanged(exists) {
        if (!exists) {
            this.h.conflict = 'deleted';
            return this.draw();
        }
        if (this.h.table?.dirty) {
            this.h.conflict = 'disk';
            return this.draw();
        }
        this._reload();
    }

    _reload() {
        const { cursor, col, insert } = this.h;
        this._state({ cursor, col, insert });
        this._stale ||= this._undo.length > 0;
        this._undo = [];
        this._redo = [];
        this.start(null);
    }

    toggleInsert() {
        const h = this.h;
        if (!h.canResize || !h.table) return;
        h.insert = !h.insert;
        h.nibble = 0;
        h.cursor = Math.min(h.cursor, this._last());
        this._layout();
        this.draw();
    }

    askGoto() {
        if (!this.h.table) return;
        this._gotoOpen = true;
        this._status.replaceChildren();
        const input = Object.assign(document.createElement('input'), { className: 'hex__input', placeholder: this._s.gotoPlaceholder, title: this._s.gotoHint });
        this._status.append(Object.assign(document.createElement('span'), { textContent: this._s.gotoLabel }), input);
        const done = (go) => {
            this._gotoOpen = false;
            if (go) this._goto(input.value);
            this.draw();
            this._el.focus({ preventScroll: true });
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); done(true); }
            if (e.key === 'Escape') { e.preventDefault(); done(false); }
        });
        input.addEventListener('blur', () => { if (this._gotoOpen) done(false); });
        input.focus();
    }

    /** @param {string} text hexadecimal with 0x (or an h at the end) or decimal; +/- from the cursor */
    _goto(text) {
        const raw = text.trim().toLowerCase(), rel = /^[+-]/.test(raw) ? raw[0] : '';
        const num = raw.replace(/^[+-]/, '');
        const n = /^0x[0-9a-f]+$/.test(num) ? parseInt(num, 16) : /^[0-9]+$/.test(num) ? Number(num) : /^[0-9a-f]+h$/.test(num) ? parseInt(num, 16) : NaN;
        if (!Number.isFinite(n)) return;
        const h = this.h, target = rel === '+' ? h.cursor + n : rel === '-' ? h.cursor - n : n;
        h.cursor = Math.max(0, Math.min(this._last(), target));
        h.nibble = 0;
        this._scrollToRow(Math.floor(h.cursor / ROW) - Math.floor(this._visible() / 2));
    }

    // ----- reading -----

    /** @param {number} offset @returns {number | undefined} a byte of the file on disk, undefined while its block loads (the load is started) */
    _diskByte(offset) {
        const b = Math.floor(offset / BLOCK), block = this.h.blocks.get(b);
        if (block instanceof Uint8Array) return block[offset - b * BLOCK];
        if (!block) this._loadBlock(b);
        return undefined;
    }

    /** @param {number} offset @returns {number | undefined} a byte of the edited file */
    _byte(offset) {
        return this.h.table.read(offset, 1, o => this._diskByte(o)).vals[0];
    }

    /** @param {number} b the block number */
    async _loadBlock(b) {
        const h = this.h;
        h.blocks.set(b, 'loading');
        try {
            // The first read also asks how much room the disk has (for inserting / deleting)
            const askFree = h.free == null;
            const r = await this._host.request('bytes', { offset: b * BLOCK, length: BLOCK, free: askFree });
            if (this.h !== h) return;
            if (h.mtime != null && (r.mtime !== h.mtime || r.size !== h.size)) {
                h.blocks.delete(b);
                return this.diskChanged(true);
            }
            if (askFree) {
                h.free = r.free ?? -1;
                h.canResize = r.free == null || r.free >= r.size + SLACK;
                if (!h.canResize) h.insert = false;
            }
            h.size = r.size;
            h.mtime = r.mtime;
            if (!h.table) h.table = new PieceTable(r.size);
            h.blocks.set(b, r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data));
            while (h.blocks.size > BLOCKS_KEPT) h.blocks.delete(h.blocks.keys().next().value);
        } catch (e) {
            h.blocks.delete(b);
            h.message = this._format(this._s.readError, e.message);
        }
        if (this.h === h) {
            this._layout();
            this.draw();
        }
    }

    // ----- geometry -----

    /** One more row than the bytes when inserting at the very end needs a place for the cursor. */
    _rowCount() {
        const h = this.h;
        return Math.max(1, Math.ceil(((h.table ? h.table.len : h.size || 0) + (h.insert ? 1 : 0)) / ROW));
    }

    _visible() {
        return Math.max(1, Math.floor((this._scroll.clientHeight - 8) / ROW_HEIGHT));
    }

    _scaled() {
        return this._rowCount() * ROW_HEIGHT > MAX_HEIGHT;
    }

    /** The last offset the cursor may take: one past the end while inserting (to append). */
    _last() {
        const h = this.h;
        return Math.max(0, (h.table?.len ?? 0) - (h.insert ? 0 : 1));
    }

    _layout() {
        const full = Math.min(this._rowCount() * ROW_HEIGHT + 8, MAX_HEIGHT);
        this._spacer.style.height = Math.max(0, full - this._scroll.clientHeight) + 'px';
    }

    _topFromScroll() {
        const max = Math.max(0, this._rowCount() - this._visible());
        if (!this._scaled()) return Math.min(max, Math.floor(this._scroll.scrollTop / ROW_HEIGHT));
        // At these heights browsers stop short of the computed maximum (rounding): the last few
        // dozen pixels mean the end
        const range = this._scroll.scrollHeight - this._scroll.clientHeight - 40;
        return range > 0 ? Math.round(Math.min(1, this._scroll.scrollTop / range) * max) : 0;
    }

    /** @param {number} row the row to show at the top */
    _scrollToRow(row) {
        const max = Math.max(0, this._rowCount() - this._visible());
        this._top = Math.max(0, Math.min(max, row));
        const range = this._scroll.scrollHeight - this._scroll.clientHeight - 40;
        this._scroll.scrollTop = this._scaled() ? (max ? (this._top / max) * range + (this._top === max ? 40 : 0) : 0) : this._top * ROW_HEIGHT;
        this._expectedScroll = this._scroll.scrollTop;
    }

    _reveal() {
        const row = Math.floor(this.h.cursor / ROW), vis = this._visible();
        if (row < this._top) this._scrollToRow(row);
        else if (row >= this._top + vis) this._scrollToRow(row - vis + 1);
    }

    // ----- drawing -----

    draw() {
        const h = this.h;
        this._el.classList.toggle('hex--insert', h.insert);
        const len = h.table ? h.table.len : h.size || 0;
        const digits = Math.max(8, len.toString(16).length);
        const first = this._top * ROW;
        const count = (Math.min(this._rowCount(), this._top + this._visible() + 1) - this._top) * ROW;
        const { vals, mods } = h.table ? h.table.read(first, Math.max(0, Math.min(count, len - first)), o => this._diskByte(o)) : { vals: [], mods: [] };
        const rows = [];
        for (let r = 0; r * ROW < count; r++) {
            const start = first + r * ROW;
            let bytes = '', text = '';
            for (let i = 0; i < ROW; i++) {
                const o = start + i, k = o - first, cur = o === h.cursor;
                if (h.size != null && o >= len) {
                    // Past the end: empty, except the slot where an appended byte would go
                    bytes += cur ? `<span data-o="${o}" class="${cellClass(['cursor', h.col === 'hex' && 'on'])}">  </span>` : `<span class="${cellClass([i === 7 && 'gap'])}">  </span>`;
                    text += cur ? `<span data-o="${o}" class="${cellClass(['cursor', h.col === 'text' && 'on'])}"> </span>` : `<span class="${cellClass([])}"> </span>`;
                    continue;
                }
                const v = vals[k];
                const marks = [mods[k] && 'mod', v === 0 && 'zero', cur && 'cursor'];
                bytes += `<span data-o="${o}" class="${cellClass([i === 7 && 'gap', ...marks, cur && h.col === 'hex' && 'on'])}">${v === undefined ? '··' : hex2(v)}</span>`;
                const ch = v === undefined ? '·' : v >= 0x20 && v < 0x7f ? escapeHtml(String.fromCharCode(v)) : '.';
                text += `<span data-o="${o}" class="${cellClass([...marks, cur && h.col === 'text' && 'on'])}">${ch}</span>`;
            }
            rows.push(`<div class="hex__row"><span class="hex__offset">${start.toString(16).toUpperCase().padStart(digits, '0')}</span><span class="hex__bytes">${bytes}</span><span class="hex__chars">${text}</span></div>`);
        }
        this._rows.innerHTML = rows.join('');
        if (!this._gotoOpen) this._drawStatus();
    }

    _drawStatus() {
        const h = this.h, s = this._s, t = h.table;
        const v = t && h.cursor < t.len ? this._byte(h.cursor) : undefined;
        this._status.replaceChildren();
        const part = (text, cls) => this._status.append(Object.assign(document.createElement('span'), { textContent: text, className: cls ? `hex__part hex__part--${cls}` : 'hex__part' }));
        const button = (text, title, onClick, disabled = false) => {
            const b = Object.assign(document.createElement('button'), { type: 'button', className: 'hex__button', textContent: text, title, disabled });
            b.addEventListener('click', () => { onClick(); this._el.focus({ preventScroll: true }); });
            this._status.append(b);
        };
        if (h.conflict) {
            part(h.conflict === 'deleted' ? s.diskDeleted : s.diskChanged, 'warn');
            if (h.conflict === 'disk') button(s.reload, s.reload, () => this._host.send('revert'));
            button(s.keep, s.keep, () => { h.conflict = null; this.draw(); });
        }
        if (h.message) {
            part(h.message, 'warn');
            button('✕', s.close, () => { h.message = null; this.draw(); });
        }
        if (h.size != null && !h.canResize) part(this._format(s.lowSpace, this._bytes(Math.max(0, h.free)), this._bytes(h.size + SLACK)), 'warn');
        part(h.size == null ? s.loading : this._format(s.offset, h.cursor.toString(16).toUpperCase(), h.cursor.toLocaleString(this._locale)));
        if (v !== undefined) part(this._format(s.byte, hex2(v), v, v >= 0x20 && v < 0x7f ? ` «${String.fromCharCode(v)}»` : ''));
        if (t) part(t.len !== t.size ? this._format(s.sizeWas, this._bytes(t.len), this._bytes(t.size)) : this._bytes(t.len));
        if (t?.dirty) {
            const c = t.changes();
            part(c.delta ? this._format(s.editsDelta, c.added, `${c.delta > 0 ? '+' : '−'}${this._bytes(Math.abs(c.delta))}`) : this._format(s.edits, c.added));
        }
        button(h.insert ? s.modeInsert : s.modeOverwrite, h.canResize ? s.modeTitle : s.modeOff, () => this.toggleInsert(), !h.canResize);
        part(h.col === 'hex' ? s.inputHex : s.inputText);
        button(s.goto, s.gotoTitle, () => this.askGoto());
        part(h.canResize ? s.help : s.helpNoDelete);
    }

    // ----- keys -----

    /** @param {KeyboardEvent} e (⌘S, ⌘Z, ⌘G, ⌘I and Insert are VS Code's commands) */
    _key(e) {
        const h = this.h, t = h.table;
        if (!t) return;
        const mod = e.metaKey || e.ctrlKey, page = this._visible() * ROW;
        const last = this._last();
        let to = null;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (!h.canResize) return;
            const o = e.key === 'Backspace' ? h.cursor - 1 : h.cursor;
            if (o < 0 || o >= t.len) return;
            this._edit(this._s.deleteByte, () => t.delete(o));
            h.nibble = 0;
            h.cursor = Math.max(0, Math.min(this._last(), o));
            this._layout();
            this._reveal();
            return this.draw();
        }
        if (e.key === 'Tab') { h.col = h.col === 'hex' ? 'text' : 'hex'; h.nibble = 0; to = h.cursor; }
        else if (e.key === 'ArrowLeft') to = h.cursor - 1;
        else if (e.key === 'ArrowRight') to = h.cursor + 1;
        else if (e.key === 'ArrowUp') to = mod ? 0 : h.cursor - ROW;
        else if (e.key === 'ArrowDown') to = mod ? last : h.cursor + ROW;
        else if (e.key === 'PageUp') to = h.cursor - page;
        else if (e.key === 'PageDown') to = h.cursor + page;
        else if (e.key === 'Home') to = mod ? 0 : h.cursor - (h.cursor % ROW);
        else if (e.key === 'End') to = mod ? last : Math.min(last, h.cursor - (h.cursor % ROW) + ROW - 1);
        else if (!mod && !e.altKey && e.key.length === 1) return this._type(e);
        else return;
        e.preventDefault();
        if (to !== h.cursor) h.nibble = 0;
        h.cursor = Math.max(0, Math.min(last, to));
        this._reveal();
        this.draw();
    }

    /** @param {KeyboardEvent} e a character: a hex digit in the hex column, a printable one in the text column */
    _type(e) {
        const h = this.h, t = h.table;
        let v;
        if (h.col === 'hex') {
            if (!/^[0-9a-f]$/i.test(e.key)) return;
            const d = parseInt(e.key, 16);
            if (h.insert && h.nibble === 0) v = d << 4; // a new byte, its low half comes next
            else {
                const cur = h.cursor < t.len ? this._byte(h.cursor) : undefined;
                if (cur === undefined) return; // its block isn't loaded yet (or past the end)
                v = h.nibble ? (cur & 0xf0) | d : (d << 4) | (cur & 0x0f);
            }
        } else {
            v = e.key.charCodeAt(0);
            if (v < 0x20 || v > 0x7e) return;
            if (!h.insert && (h.cursor >= t.len || this._byte(h.cursor) === undefined)) return;
        }
        e.preventDefault();
        const at = h.cursor;
        if (h.insert && !(h.col === 'hex' && h.nibble)) this._edit(this._s.insertByte, () => t.insert(at, v));
        else this._edit(this._s.replaceByte, () => t.replace(at, v));
        let to;
        if (h.col === 'hex' && !h.nibble) { h.nibble = 1; to = h.cursor; } else { h.nibble = 0; to = h.cursor + 1; }
        h.cursor = Math.max(0, Math.min(this._last(), to));
        this._layout();
        this._reveal();
        this.draw();
    }

    /**
     * One undoable edit: the snapshot before it goes on the undo stack, VS Code gets an edit.
     * @param {string} label
     * @param {() => void} change
     */
    _edit(label, change) {
        this._undo.push({ pieces: this.h.table.pieces, cursor: this.h.cursor });
        this._redo = [];
        change();
        this.h.message = null;
        this._host.send('edit', { label });
    }

    // ----- texts -----

    /** @param {string} text with {0}, {1}… @param {...any} args */
    _format(text, ...args) {
        return text.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m));
    }

    /** @param {number} n @returns {string} a size in B / KB / MB / GB */
    _bytes(n) {
        const s = this._s, num = x => x.toLocaleString(this._locale, { maximumFractionDigits: 1 });
        if (n < 1024) return `${n} ${s.unitB}`;
        if (n < 1048576) return `${num(n / 1024)} ${s.unitKB}`;
        if (n < 1073741824) return `${num(n / 1048576)} ${s.unitMB}`;
        return `${num(n / 1073741824)} ${s.unitGB}`;
    }
}

/** @param {number} n @returns {string} two hex digits */
function hex2(n) {
    return n.toString(16).toUpperCase().padStart(2, '0');
}

/** @param {(string | false | 0 | undefined)[]} marks @returns {string} the classes of a cell */
function cellClass(marks) {
    return ['hex__cell', ...marks.filter(Boolean).map(m => `hex__cell--${m}`)].join(' ');
}

/** @param {string} s @returns {string} */
function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
