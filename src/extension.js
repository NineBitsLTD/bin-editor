import { BinEditor } from './components/BinEditor';

/**
 * @param {import('vscode').ExtensionContext} context
 */
export function activate(context) {
	// Any file: its bytes in a hex editor of any size (overwrite, insert, delete)
	context.subscriptions.push(new BinEditor(context).register());
}

export function deactivate() {}
