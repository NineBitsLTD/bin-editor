import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createNonce } from '../utils/createNonce';
import { PieceTable } from '../editor/PieceTable.js';
import { BinDocument } from './BinDocument';

export const BinEditorID = 'bin-editor.hex';
/** The context key of the files of open bin editors that VS Code has no other editor for (the menus hide "Open in the Default Editor"). */
const NO_DEFAULT_KEY = 'bin-editor.noDefaultEditor';
/** VS Code's setting of the editor that opens the files its text editor takes for binary (the manifest makes it this one). */
const BINARY_EDITOR_SETTING = 'workbench.editor.defaultBinaryEditor';

const ASK_TIMEOUT = 30_000;
/** How often a visible editor checks its file on disk (VS Code's watcher may refuse the volume). */
const POLL_MS = 2000;
const mac = process.platform === 'darwin';

/**
 * The bin editor (`bin-editor.hex`, a custom editor of any file with priority `option`: files open
 * as usual, "Open in Bin Editor" in the Explorer menu and the editor title switches to it; files
 * VS Code takes for binary open in it, being the default of `workbench.editor.defaultBinaryEditor`). The
 * webview (`src/editor.js`) keeps the edits of the file (a piece table) and its undo stack; the
 * host reads byte ranges for it (`BinDocument`), turns each of its edits into an undoable edit of
 * VS Code whose undo / redo go back to the webview, and saves: in place when every byte kept its
 * offset, else by rewriting the file through a temporary copy. Backups (hot exit) keep the unsaved
 * pieces; a change of the file on disk is told to the webview, which reloads unless it has edits.
 * @implements {vscode.CustomEditorProvider<BinDocument>}
 */
export class BinEditor {

    static openCommand = 'bin-editor.open';
    static textCommand = 'bin-editor.openText';
    static gotoCommand = 'bin-editor.goto';
    static insertCommand = 'bin-editor.toggleInsert';

    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this._context = context;
        /** @type {vscode.EventEmitter<vscode.CustomDocumentEditEvent<BinDocument>>} */
        this._changes = new vscode.EventEmitter();
        this.onDidChangeCustomDocument = this._changes.event;
        /** @type {Map<BinDocument, vscode.WebviewPanel>} one editor per document */
        this._panels = new Map();
        /** @type {Map<number, (result: any) => void>} */
        this._asks = new Map();
        this._nextAsk = 1;
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.window.registerCustomEditorProvider(BinEditorID, this, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }),
            vscode.commands.registerCommand(BinEditor.openCommand, uri => this.open(uri)),
            vscode.commands.registerCommand(BinEditor.textCommand, uri => this.openText(uri)),
            vscode.commands.registerCommand(BinEditor.gotoCommand, () => this._command('goto')),
            vscode.commands.registerCommand(BinEditor.insertCommand, () => this._command('toggleInsert')),
            vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(BINARY_EDITOR_SETTING)) this._updateNoDefault(); }),
            this._changes,
        );
    }

    // ----- commands -----

    /**
     * Opens a file in the bin editor, in place of its tab when the active tab shows it unchanged.
     * @param {vscode.Uri} [uri]
     */
    async open(uri) {
        const target = uri instanceof vscode.Uri ? uri : BinEditor._activeResource();
        if (!target) {
            vscode.window.showWarningMessage(vscode.l10n.t('Select a file to open it in the Bin Editor.'));
            return;
        }
        await BinEditor._switchTo(target, (viewColumn, preview) => vscode.commands.executeCommand('vscode.openWith', target, BinEditorID, { viewColumn, preview }));
    }

    /**
     * Opens the file of the bin editor in VS Code's own editor for it, in place of the bin editor
     * when that has no unsaved edits.
     * @param {vscode.Uri} [uri]
     */
    async openText(uri) {
        const target = uri instanceof vscode.Uri ? uri : BinEditor._activeResource();
        if (!target) return;
        // Hidden in the menus then: VS Code would send the file back here, or show nothing of it
        const document = [...this._panels.keys()].find(d => d.uri.toString() === target.toString());
        if (document && BinEditor._noDefaultEditor(document)) {
            vscode.window.showInformationMessage(vscode.l10n.t('VS Code has no other editor for {0}: it takes the file for binary.', path.basename(document.file)));
            return;
        }
        await BinEditor._switchTo(target, (viewColumn, preview) => vscode.commands.executeCommand('vscode.openWith', target, 'default', { viewColumn, preview }));
    }

    /**
     * Opens another editor of a file; when the active tab shows the file without unsaved changes,
     * the new one takes its place (the editors are separate documents: a dirty tab stays).
     * @param {vscode.Uri} target
     * @param {(viewColumn: vscode.ViewColumn | undefined, preview: boolean) => Thenable<unknown>} openView
     */
    static async _switchTo(target, openView) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const shown = tab?.input instanceof vscode.TabInputText || tab?.input instanceof vscode.TabInputCustom ? tab.input.uri : null;
        const replaced = shown?.toString() === target.toString() && !tab.isDirty ? tab : null;
        await openView(replaced?.group.viewColumn, !!replaced?.isPreview);
        if (replaced && replaced.group.tabs.includes(replaced)) await vscode.window.tabGroups.close(replaced);
    }

    /**
     * @returns {vscode.Uri | undefined} the file of the active tab
     */
    static _activeResource() {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input?.uri ?? vscode.window.activeTextEditor?.document.uri;
    }

    /**
     * Whether VS Code has no editor of the document's file but this one: it takes the file for
     * binary, and its `workbench.editor.defaultBinaryEditor` sends such files here or (when empty)
     * shows nothing of them; another editor there (or `default`: the binary as text) is one.
     * @param {BinDocument} document
     * @returns {boolean}
     */
    static _noDefaultEditor(document) {
        const fallback = vscode.workspace.getConfiguration().get(BINARY_EDITOR_SETTING);
        return document.binary && (!fallback || fallback === BinEditorID);
    }

    /** Tells the menus the files of the open bin editors that have no other editor (NO_DEFAULT_KEY). */
    _updateNoDefault() {
        const uris = [...this._panels.keys()].filter(BinEditor._noDefaultEditor).map(d => d.uri.toString());
        vscode.commands.executeCommand('setContext', NO_DEFAULT_KEY, uris);
    }

    /**
     * Tells again whether VS Code takes the document's file for binary (when opened, written, changed on disk).
     * @param {BinDocument} document
     */
    async _checkBinary(document) {
        const binary = await BinDocument.seemsBinary(document.file).catch(() => false);
        if (binary === document.binary) return;
        document.binary = binary;
        this._updateNoDefault();
    }

    /** @param {string} name a command for the webview of the active bin editor */
    _command(name) {
        for (const panel of this._panels.values()) if (panel.active) panel.webview.postMessage({ type: 'command', name });
    }

    // ----- the custom editor -----

    /**
     * @param {vscode.Uri} uri
     * @param {vscode.CustomDocumentOpenContext} openContext
     * @returns {Promise<BinDocument>}
     */
    async openCustomDocument(uri, openContext) {
        if (uri.scheme !== 'file') throw new Error(vscode.l10n.t('The Bin Editor opens local files only.'));
        const document = await BinDocument.open(uri, uri.fsPath);
        await this._checkBinary(document);
        if (openContext.backupId) await this._restoreBackup(document, vscode.Uri.parse(openContext.backupId).fsPath);
        this._watch(document);
        return document;
    }

    /**
     * Unsaved pieces of a backup, kept for the webview when they still refer to the file on disk.
     * @param {BinDocument} document
     * @param {string} file
     */
    async _restoreBackup(document, file) {
        const name = path.basename(document.file);
        try {
            const backup = await BinDocument.readBackup(file);
            if (backup.size === document.stamp.size && backup.mtime === document.stamp.mtime) document.restored = backup;
            else vscode.window.showWarningMessage(vscode.l10n.t('{0} changed on disk since its unsaved edits were kept, so they were dropped.', name));
        } catch (e) {
            vscode.window.showWarningMessage(vscode.l10n.t('Cannot read the unsaved edits of {0}: {1}', name, e.message));
        }
    }

    /**
     * Tells the webview when the file changes on disk (not by our own writes), once per change. VS
     * Code's watcher refuses volumes it takes for network shares (exFAT disks among them), so while
     * the editor is visible the file's stamp is also checked every POLL_MS.
     * @param {BinDocument} document
     */
    _watch(document) {
        const same = (a, b) => !!a && !!b && a.size === b.size && a.mtime === b.mtime;
        /** @type {import('./BinDocument').FileStamp | 'gone' | null} the last change told */
        let told = null;
        const check = async () => {
            const now = await BinDocument.stampOf(document.file).catch(() => null);
            if (same(now, document.stamp) || (now ? same(now, told) : told === 'gone')) return;
            told = now ?? 'gone';
            this._post(document, { type: 'diskChanged', exists: !!now });
            if (now) this._checkBinary(document);
        };
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), path.basename(document.file)));
        watcher.onDidChange(check);
        watcher.onDidCreate(check);
        watcher.onDidDelete(check);
        const timer = setInterval(() => { if (this._panels.get(document)?.visible) check(); }, POLL_MS);
        document.onDispose(() => {
            watcher.dispose();
            clearInterval(timer);
        });
    }

    /**
     * @param {BinDocument} document
     * @param {vscode.WebviewPanel} panel
     */
    resolveCustomEditor(document, panel) {
        this._panels.set(document, panel);
        this._updateNoDefault();
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'dist')] };
        panel.webview.html = this._html(panel.webview);
        const subscription = panel.webview.onDidReceiveMessage(message => this._onMessage(document, panel, message));
        panel.onDidDispose(() => {
            subscription.dispose();
            if (this._panels.get(document) === panel) this._panels.delete(document);
            this._updateNoDefault();
        });
    }

    /**
     * @param {BinDocument} document
     * @param {vscode.WebviewPanel} panel
     * @param {any} message
     */
    async _onMessage(document, panel, message) {
        switch (message?.type) {
            case 'ready':
                panel.webview.postMessage({ type: 'init', strings: BinEditor._strings(), locale: vscode.env.language, restored: document.restored });
                document.restored = null;
                break;
            case 'bytes':
                try {
                    const result = await document.read(message.offset, message.length, message.free);
                    panel.webview.postMessage({ type: 'hostReply', requestId: message.requestId, result });
                } catch (e) {
                    panel.webview.postMessage({ type: 'hostReply', requestId: message.requestId, error: e.message });
                }
                break;
            case 'edit':
                this._changes.fire({
                    document,
                    label: message.label,
                    undo: () => this._post(document, { type: 'undo' }),
                    redo: () => this._post(document, { type: 'redo' }),
                });
                break;
            case 'reply':
                this._asks.get(message.requestId)?.(message.result);
                this._asks.delete(message.requestId);
                break;
            case 'revert':
                if (panel.active) vscode.commands.executeCommand('workbench.action.files.revert');
                break;
            case 'staleUndo':
                vscode.window.showInformationMessage(vscode.l10n.t('Edits made before the last save cannot be undone: the file on disk has changed since.'));
                break;
        }
    }

    /** @param {BinDocument} document @param {any} message */
    _post(document, message) {
        this._panels.get(document)?.webview.postMessage(message);
    }

    /**
     * @param {BinDocument} document
     * @returns {Promise<{ loaded: boolean, dirty: boolean, size: number, mtime: number, pieces: import('../editor/PieceTable.js').Piece[] }>} the edits of its webview
     */
    _askEdits(document) {
        const panel = this._panels.get(document);
        if (!panel) return Promise.reject(new Error(vscode.l10n.t('The editor of {0} is closed.', path.basename(document.file))));
        const requestId = this._nextAsk++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._asks.delete(requestId);
                reject(new Error(vscode.l10n.t('The editor of {0} did not answer.', path.basename(document.file))));
            }, ASK_TIMEOUT);
            this._asks.set(requestId, (result) => {
                clearTimeout(timer);
                result.pieces = result.pieces.map(p => ('a' in p ? { a: p.a instanceof Uint8Array ? p.a : new Uint8Array(p.a) } : p));
                resolve(result);
            });
            panel.webview.postMessage({ type: 'ask', requestId });
        });
    }

    /** @param {BinDocument} document */
    async saveCustomDocument(document) {
        const edits = await this._askEdits(document);
        const table = new PieceTable(edits.size, edits.pieces);
        if (!table.dirty) return;
        const name = path.basename(document.file);
        const now = await BinDocument.stampOf(document.file);
        const changed = now.size !== edits.size || now.mtime !== edits.mtime;
        if (table.patchable) {
            if (changed) {
                const overwrite = vscode.l10n.t('Overwrite');
                const answer = await vscode.window.showWarningMessage(vscode.l10n.t('{0} changed on disk after it was opened. Write your bytes over it anyway?', name), { modal: true }, overwrite);
                if (answer !== overwrite) throw new vscode.CancellationError();
            }
            await document.writePatches(table.patches());
        } else {
            if (changed) {
                const saveAs = vscode.l10n.t('Save As…'), revert = vscode.l10n.t('Revert');
                const answer = await vscode.window.showErrorMessage(vscode.l10n.t('{0} changed on disk after it was opened, and your edits move bytes, so they cannot be written over the new file. Save them as another file, or revert to the file on disk.', name), { modal: true }, saveAs, revert);
                if (answer) setTimeout(() => vscode.commands.executeCommand(answer === saveAs ? 'workbench.action.files.saveAs' : 'workbench.action.files.revert'), 0);
                throw new vscode.CancellationError();
            }
            await this._writeTo(document, table.pieces, document.file);
        }
        this._post(document, { type: 'saved' });
        await this._checkBinary(document);
    }

    /**
     * @param {BinDocument} document
     * @param {vscode.Uri} destination
     */
    async saveCustomDocumentAs(document, destination) {
        if (destination.scheme !== 'file') throw new Error(vscode.l10n.t('The Bin Editor saves to local files only.'));
        const target = destination.fsPath;
        const edits = await this._askEdits(document);
        const now = await BinDocument.stampOf(document.file);
        if (edits.loaded && edits.dirty && (now.size !== edits.size || now.mtime !== edits.mtime)) {
            throw new Error(vscode.l10n.t('{0} changed on disk after it was opened, so its edits cannot be written. Revert it first.', path.basename(document.file)));
        }
        // Without edits (or before the webview read the file) the copy is the file as it is now
        const table = edits.loaded && edits.dirty ? new PieceTable(edits.size, edits.pieces) : new PieceTable(now.size);
        if (path.resolve(target) === path.resolve(document.file)) {
            await this._writeTo(document, table.pieces, target);
            this._post(document, { type: 'saved' });
            await this._checkBinary(document);
        } else {
            await this._writeTo(document, table.pieces, target);
        }
    }

    /**
     * @param {BinDocument} document
     * @param {import('../editor/PieceTable.js').Piece[]} pieces
     * @param {string} target
     */
    async _writeTo(document, pieces, target) {
        try {
            await document.writeTo(pieces, target);
        } catch (e) {
            if (e.code === 'ENOSPC' && e.needed) {
                throw new Error(vscode.l10n.t('Not enough disk space: {0} MB needed, {1} MB free.', Math.ceil(e.needed / 1048576), Math.floor(e.free / 1048576)));
            }
            throw e;
        }
    }

    /** @param {BinDocument} document */
    async revertCustomDocument(document) {
        document.stamp = await BinDocument.stampOf(document.file);
        document.restored = null;
        this._post(document, { type: 'revert' });
        await this._checkBinary(document);
    }

    /**
     * @param {BinDocument} document
     * @param {vscode.CustomDocumentBackupContext} context
     * @returns {Promise<vscode.CustomDocumentBackup>}
     */
    async backupCustomDocument(document, context) {
        const edits = await this._askEdits(document);
        await BinDocument.writeBackup(context.destination.fsPath, edits);
        return { id: context.destination.toString(), delete: () => fs.promises.rm(context.destination.fsPath, { force: true }).catch(() => {}) };
    }

    // ----- the webview page -----

    /**
     * @param {vscode.Webview} webview
     * @returns {string}
     */
    _html(webview) {
        const nonce = createNonce();
        const dist = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', ...parts));
        const csp = [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${dist('css', 'editor.css')}" rel="stylesheet">
<title>Bin Editor</title>
</head>
<body>
<div class="bin"></div>
<script nonce="${nonce}" src="${dist('js', 'editor.js')}"></script>
</body>
</html>`;
    }

    /**
     * @returns {Record<string, string>} the texts of the webview in the language of VS Code
     */
    static _strings() {
        const t = vscode.l10n.t;
        const key = (k) => (mac ? `⌘${k}` : `Ctrl+${k}`);
        return {
            loading: t('Loading…'),
            offset: t('Offset 0x{0} ({1})'),
            byte: t('byte 0x{0} = {1}{2}'),
            sizeWas: t('{0} (was {1})'),
            edits: t('edits: {0} new bytes'),
            editsDelta: t('edits: {0} new bytes, size {1}'),
            modeInsert: t('mode: insert'),
            modeOverwrite: t('mode: overwrite'),
            modeTitle: t('Insert or overwrite bytes (Insert or {0})', key('I')),
            modeOff: t('Inserting is off: not enough disk space'),
            inputHex: t('input: hex'),
            inputText: t('input: text'),
            goto: t('{0} — go to', key('G')),
            gotoTitle: t('Go to an offset'),
            gotoLabel: t('Go to offset:'),
            gotoPlaceholder: t('0x1F00 or 7936'),
            gotoHint: t('An offset: hexadecimal with 0x or decimal; +/- from the current one'),
            help: t('Tab — hex/text · Delete/⌫ — delete a byte · {0} — undo · {1} — save', key('Z'), key('S')),
            helpNoDelete: t('Tab — hex/text · {0} — undo · {1} — save', key('Z'), key('S')),
            lowSpace: t('⚠️ Low disk space: {0} free, but inserting and deleting bytes need about {1}, so they are off; overwriting works.'),
            diskChanged: t('The file changed on disk, and you have unsaved edits.'),
            diskDeleted: t('The file was deleted on disk.'),
            reload: t('Reload from disk (lose the edits)'),
            keep: t('Keep my edits'),
            close: t('Close'),
            savedTyped: t('Saved; the edits made while saving were dropped and the file was read again.'),
            readError: t('Cannot read the bytes: {0}'),
            replaceByte: t('Overwrite a byte'),
            insertByte: t('Insert a byte'),
            deleteByte: t('Delete a byte'),
            restoreEdits: t('Restore unsaved edits'),
            unitB: t('B'),
            unitKB: t('KB'),
            unitMB: t('MB'),
            unitGB: t('GB'),
        };
    }
}
