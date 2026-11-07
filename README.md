# Bin Editor

A Visual Studio Code extension: a hex editor for files of any size — overwrite, insert and delete
bytes, with VS Code's own undo, redo, save and hot exit.

The requirements and how to install the extension or build it from source are described after the
features: [Requirements](#requirements), [Getting started (development)](#getting-started-development),
[Packaging and installing](#packaging-and-installing).

## Features

- **Open any file in hex** — **Open in Bin Editor** in the Explorer's context menu or the editor title
  (files still open in their usual editors); **Open in the Default Editor** goes back. VS Code's
  **Reopen Editor With…** works too.
- **The default editor of binary files** — files VS Code cannot show as text ("The file is not
  displayed in the text editor because it is either binary…") open in the Bin Editor right away, and
  without **Open in the Default Editor**, as there is none. It is VS Code's setting
  `workbench.editor.defaultBinaryEditor`, which the extension sets to `bin-editor.hex` by default:
  set it to an empty value to get VS Code's placeholder back, or to `default` to see such files as text.
- **Any size** — only the rows on screen are read, in 64 KB blocks; multi-gigabyte files scroll as
  fast as small ones.
- **Overwrite, insert, delete** — type hex digits (or characters in the text column; **Tab** switches);
  **Insert** (or ⌘I / Ctrl+I) toggles inserting; **Delete** / **⌫** deletes a byte. Edited bytes are
  highlighted; the status line shows the offset, the byte under the cursor, the size and the edits.
- **Go to an offset** — ⌘G / Ctrl+G: `0x1F00`, `7936`, `1F00h`, or `+100` / `-0x10` from the cursor.
- **Saving that fits the file** — when every byte keeps its offset, only the changed bytes are written
  in place (fast, whatever the size); inserted or deleted bytes rebuild the file through a temporary
  copy, so a failure leaves it intact. That needs about the file's size free on the disk — without it,
  inserting and deleting are off and a warning says so.
- **Safe against changes on disk** — a file changed by another program reloads when you have no edits;
  with edits you choose to reload or keep them, and saving over a changed file asks first.
- **Undo, redo, Save As, revert and hot exit** are VS Code's own; unsaved edits survive a restart.
- English and Russian, following VS Code's display language.

## Requirements

- Visual Studio Code `^1.100.0`, local files (the `file:` scheme)
- Node.js (with `npm`) to build and package the extension from source

## Getting started (development)

The extension entry point is the **bundled** output in `dist/`, not `src/` — so you must build (or
watch) before launching.

```bash
npm install        # install dependencies
npm run watch      # build once, then rebuild on change (esbuild + sass)
npm test           # the piece table and the disk work, in plain Node
```

Then press **F5** in VS Code to launch the "Run Extension" configuration (`.vscode/` is not in the
repository; create `.vscode/launch.json` once):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"]
    }
  ]
}
```

## Packaging and installing

```bash
npm install
npm run pack       # vsce runs npm run build (vscode:prepublish), then packs bin-editor-<version>.vsix
code --install-extension bin-editor-1.1.0.vsix
```

## License

MIT — see the `LICENSE` file.
