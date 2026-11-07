# AGENTS.md

Guidelines for AI agents (Claude, Gemini, GPT, Codex, etc.)

## Overview

VS Code extension **Bin Editor** (`bin-editor`): a hex editor of files of any size, ported from the
hex view of Claude-AI's file viewer (`/Volumes/Projects/ninebits/claude-ai`, `server/public/index.html`
"hex view" and the `/api/bytes*` routes of `server/server.js`; the copy is independent now). It
contributes:
- A **custom editor** `bin-editor.hex` of any file (`*`, priority `option`, so files open as usual):
  "Open in Bin Editor" in the Explorer menu and the editor title (a binary-file icon), "Open in the
  Default Editor" back from it, each replacing the active tab when that has no unsaved changes
  (`BinEditor.open` / `openText`); VS Code's "Reopen Editor With…" works too. One editor per document.
- **The default editor of binary files**: files VS Code takes for binary (its test: a zero byte among
  the first 512 bytes, unless UTF-16 — `BinDocument.seemsBinary`) have no editor in it, and its text
  editor hands them to the editor of the setting `workbench.editor.defaultBinaryEditor` (else shows a
  placeholder); the manifest's `configurationDefaults` makes that `bin-editor.hex` (a user's value
  wins). For them "Open in the Default Editor" is hidden: the context key `bin-editor.noDefaultEditor`
  holds the URIs of the open bin editors' files with no other editor (binary, and the setting is ours
  or empty; checked again after a save, a revert, a change on disk); `openText` refuses them too.
  Binary files over `workbench.editorLargeFileConfirmation` get VS Code's "very large" warning first.
- The view, like Midnight Commander's: offset / 16 bytes in hex / the same as text; virtual rows in a
  native scroller (past 8 000 000 px the scrollbar is scaled), bytes read in 64 KB blocks as rows come
  into view (128 kept). Overwrite; insert (Insert or ⌘I / Ctrl+I) and delete (Delete / ⌫) only when the
  disk has room to rewrite the file (about its size + 1 MB, asked with the first read; else a warning
  and overwriting only); Tab switches hex / text input; arrows, Page Up/Down, Home/End (⌘ — the file's
  ends); go to an offset (⌘G / Ctrl+G: `0x1F00`, `7936`, `1F00h`, `+`/`-` relative). A status line
  shows the offset, the byte, the size (and the old one), the new bytes and the change of size.
- Undo / redo / save / Save As / revert / hot exit are VS Code's (see Runtime data flow).

## Commands

```bash
npm run build      # full production build into dist/ (clean → extension → webview → css)
npm run watch      # build once, then run all watchers concurrently (esbuild --watch + sass)
npm run pack       # vsce runs the build (vscode:prepublish), then packs bin-editor-<version>.vsix
npm test           # node --test test/*.test.js: PieceTable and BinDocument's disk work (no VS Code needed)
npx eslint src     # lint (no "lint" npm script)
node test/harness/server.mjs   # the webview in a browser with a fake host: a virtual file of ?size= bytes (200 MB), ?free= bytes free → http://127.0.0.1:3399/ (needs a build)
```

To run/debug the extension, launch an Extension Development Host with `--extensionDevelopmentPath` of
this folder (a `.vscode/launch.json` "Run Extension" config, see the README; `.vscode/` is gitignored).
The entry point is `dist/extension.cjs`, so **build (or watch) before launching**.

## Build architecture

Source is authored as **ESM** (`"type": "module"`) and bundled with **esbuild** into two targets:

1. **Extension host** — `src/extension.js` → `dist/extension.cjs` (CJS for Node, `vscode` external):
   `src/components/BinEditor.js` (the `CustomEditorProvider`, commands, the webview page and its texts)
   and `src/components/BinDocument.js` (the `CustomDocument` and all disk work; it does not import
   `vscode`, so the tests run it in plain Node); `src/utils/createNonce.js`.
2. **Editor webview** — `src/editor.js` → `dist/js/editor.js` (browser): `src/editor/HexView.js` (the
   view, keys, status line), `src/editor/PieceTable.js` (also bundled into the host, which uses it to
   tell patchable edits and their patches), `src/editor/HostRequests.js` (webview → host requests
   answered by `{ type: 'hostReply', requestId, result | error }`, as in tts-stt-md-aloud).

The webview page is a template string of `BinEditor._html` with a Content Security Policy: scripts
only by nonce, styles and fonts from the extension. SCSS in `src/scss/` is compiled by `sass`, then
bundled by esbuild into `dist/css/`. Texts: `vscode.l10n.t` (English in the code, Russian in
`l10n/bundle.l10n.ru.json`; the manifest's in `package.nls*.json`); the webview gets its texts
from the host (`BinEditor._strings`) with the `init` message.

## Runtime data flow

- **Edits live in the webview** (the babylon-editor pattern for binary formats): a `PieceTable` — the
  file as pieces `{ d, n }` (a range of the file on disk) and `{ a }` (new bytes), never changed in
  place, so a `pieces` array is a snapshot. Every edit pushes the snapshot before it on the webview's
  undo stack and posts `{ type: 'edit', label }`; the host fires `onDidChangeCustomDocument` with
  `undo` / `redo` that post `{ type: 'undo' }` / `{ type: 'redo' }` back, so VS Code owns the history
  and the dirty state; the stacks of the webview follow it.
- **Reading**: `{ type: 'bytes', offset, length, free }` → `BinDocument.read` → `{ data, size, mtime,
  free? }` (mtime in ms). A block whose file stamp differs from the one the view started with means the
  file changed on disk.
- **Saving**: the host asks the webview `{ type: 'ask' }` for its edits (`{ loaded, dirty, size, mtime,
  pieces }`, new bytes copied). Same size and every kept byte at its offset (`PieceTable.patchable`):
  only the new bytes are written in place (`BinDocument.writePatches`; if the file changed on disk
  since, a modal asks to overwrite). Otherwise `BinDocument.writeTo` rebuilds the file from the pieces
  in a temporary file next to it (mode kept) and renames it over the file; needs the file's size + 1 MB
  free; if the file changed on disk, the ranges no longer fit it: a modal offers Save As or Revert and
  the save is cancelled. Then `{ type: 'saved' }`: the webview reads the file again and clears its
  stacks — VS Code's older edits refer to the file before the save, undoing past it only tells so
  (`staleUndo`). Save As writes the pieces (or the whole file) to the chosen file the same way.
- **Revert**: `{ type: 'revert' }` → the webview reads the file again.
- **Hot exit**: `backupCustomDocument` writes the pieces as JSON (`BinDocument.writeBackup`, new bytes in
  base64) with the file's size and mtime; reopened with the backup, they are given to the webview in
  `init` (`restored`) only if the file on disk is still the same, as an edit "Restore unsaved edits"
  (undoing it shows the file on disk).
- **Changes on disk**: a `FileSystemWatcher` of the file, and while the editor is visible a check of
  its size and mtime every 2 s (VS Code refuses to watch volumes it takes for network shares — the exFAT
  `/Volumes/Projects` is one); a change that is not our own write (`BinDocument.stamp`) posts
  `{ type: 'diskChanged', exists }` once: without edits the view reloads, with edits it offers
  "Reload from disk" (VS Code's revert) or "Keep my edits".
- **Commands**: `bin-editor.goto` and `bin-editor.toggleInsert` (keybindings when
  `activeCustomEditorId == 'bin-editor.hex'`) post `{ type: 'command', name }` to the active editor;
  the webview does not handle ⌘S / ⌘Z / ⌘G / ⌘I / Insert itself (VS Code gets every key of a webview).

## Icon

`resources/icon.png` (256 px, the `icon` of package.json) is made by `swift scripts/make-icon.swift`
(macOS, AppKit draws the SVG) from `resources/icon-space.svg` — the same picture and script as
babylon-editor, tts-stt-md-aloud and claude-wrapper — with the label BIN. A label shorter than CLAUDE is
drawn as big as CLAUDE would be (`sizeReference`), so the labels of the family match in height.

## Ignored files

`dist/`, `node_modules/`, `.vscode/` and `*.vsix` are gitignored (also macOS `.DS_Store` and the `._*`
files exFAT volumes get).

## AI Coding Principles

### 1. Study Existing Code and Reuse Analogues

Before implementing a task, carefully study the surrounding environment and existing codebase.
Find similar implementations, analyze them, and use these analogues as a basis for the current task.

If an analogue contains logic errors, does not handle certain edge cases,
or requires changes to be made universal enough to apply to the current task —
always propose fixes to those existing modules as part of the work.

### 2. Think Beyond the Current Task

Do not strictly limit reasoning to the immediate task.
Analyze adjacent modules and the overall project context to anticipate
how the created modules and their functions may be used in similar cases elsewhere.

### 3. Plan Before Complex Implementation

Before implementing a complex task, always create a plan and analyze it thoroughly multiple times.
Only begin implementation after the plan is approved — execute steps one by one,
verifying each step's result and checking for errors and compliance with the plan.

### 4. Prefer Universality Over Narrow Specificity

Sometimes it is worth sacrificing strict specificity and minimalism in favor of universality.
A more universal solution simplifies future use of the module,
allows it to be applied in different situations,
and eliminates code duplication.

### 5. Modular Code Organization

Write code in a modular way, grouping functionality by entity.
This makes code easier to study, remember, apply, and reuse.

- Do not split code into many tiny files.
- Do not overload methods and files with multiple unrelated responsibilities.
- Each logical block must be written as a separate function.

### 6. Anticipate All Behavioral Scenarios

Identify and account for all possible code behavior scenarios depending on incoming data.
Analyze: empty values, unexpected types, unavailable resources, boundary conditions.
Evaluate each scenario against the current task requirements and expected behavior —
not every edge case requires handling, but every case must be consciously considered.

### 7. Scoped Changes and Controlled Refactoring

Only change what is directly necessary for the current task.
Do not refactor unrelated code along the way — unless it is a pattern used by the current task
or inherits from it. In that case, do not silently refactor it either:
propose the fix for discussion and approval before applying.
Do not add unused abstractions "for the future" —
but design the code being written so that it can naturally be reused in future tasks.

### 8. State Assumptions and Uncertainties Explicitly

Never guess silently. If something is assumed rather than confirmed —
state it explicitly before proceeding.
Flag unclear requirements, ambiguous context, or missing information
so that decisions are made consciously, not accidentally.

### 9. Report All Bugs — Fix Only Task-Related Issues

Report every bug discovered; never ignore or fix them silently.
Inside current task: Fix it immediately.
Outside current task: Report it, pause the current task, and wait for a response before proceeding. Do not apply the fix without explicit approval.

### 10. Naming Conventions — Files vs Identifiers

A file is named after its primary export, using that export's casing:
**PascalCase** for classes/components (`components/BinEditor.js`,
`editor/HexView.js`), **camelCase** for single-function modules
(`utils/createNonce.js`). Files without a single
named primary export (stylesheets, entry points, infrastructure modules) and
folders use **kebab-case** (`scss/editor.scss`).
When in doubt, follow the convention already used in the target directory.
Do not rename existing files just to match this rule.

Identifiers in code (variables, functions, types, components, named exports) use
**PascalCase** for types/components/classes and **camelCase** for variables/functions —
matching their JavaScript semantics.

Conventional uppercase markdown files (`README.md`, `AGENTS.md`, `CLAUDE.md`,
`LICENSE.md`) keep their canonical casing.

### 11. No Comments in SCSS

Do not write comments inside `*.scss` files (no `//` and no `/* */`).
The selector tree itself (`.block { &__elem { ... } }`) is the documentation;
class names follow BEM and CSS variables are self-describing. If a rule needs
explanation, the explanation belongs in the component's JSX/markdown, not the
stylesheet. Move existing helpful notes out when you touch surrounding code.

### 12. Group SCSS Selectors by BEM Prefix

Do not write SCSS as a flat list of sibling selectors. Nest sub-elements
inside their parent block using `&-suffix` chains so each "section" collapses
to a single foldable group in the IDE. Apply to every BEM family
(`&__a`, `&__a-b`, `&__a-c` → nest `&-b` and `&-c` inside `&__a`). Modifiers of
the same element (`&--variant`), pseudo-elements (`&::before`), and descendant
overrides (`.card-header` inside the block) all go inside their owning selector —
never as siblings on the root level.