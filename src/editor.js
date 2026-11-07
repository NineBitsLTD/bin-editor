import { HexView } from './editor/HexView.js';
import { HostRequests } from './editor/HostRequests.js';

/**
 * The webview of the bin editor (`BinEditor` on the host): the hex view of one file. Messages:
 * host → webview `init` (texts, locale, unsaved pieces of a backup), `hostReply`, `undo` / `redo`
 * (VS Code's), `ask` (the edits, for saving or a backup), `saved`, `revert`, `diskChanged`,
 * `command` (go to an offset, insert / overwrite); webview → host `ready`, `bytes` (a request),
 * `edit`, `reply`, `revert`, `staleUndo`.
 */
const vscode = acquireVsCodeApi();
const host = new HostRequests(message => vscode.postMessage(message));
/** @type {HexView | null} */
let view = null;

window.addEventListener('message', (event) => {
    const message = event.data;
    if (host.handleMessage(message)) return;
    if (message?.type === 'init') {
        view = new HexView(/** @type {HTMLElement} */ (document.querySelector('.bin')), { host, strings: message.strings, locale: message.locale });
        view.start(message.restored ?? null);
        return;
    }
    if (!view) return;
    switch (message?.type) {
        case 'undo': view.undo(); break;
        case 'redo': view.redo(); break;
        case 'ask': vscode.postMessage({ type: 'reply', requestId: message.requestId, result: view.edits() }); break;
        case 'saved': view.saved(); break;
        case 'revert': view.reverted(); break;
        case 'diskChanged': view.diskChanged(message.exists); break;
        case 'command':
            if (message.name === 'goto') view.askGoto();
            else if (message.name === 'toggleInsert') view.toggleInsert();
            break;
    }
});
vscode.postMessage({ type: 'ready' });
