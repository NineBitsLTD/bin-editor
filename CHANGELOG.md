# Change Log

All notable changes to the "bin-editor" extension are documented in this file.

## [1.1.0]

- The default editor of binary files: the extension sets VS Code's `workbench.editor.defaultBinaryEditor`
  to `bin-editor.hex` by default, so files VS Code cannot show as text open in the Bin Editor instead
  of a placeholder, and without "Open in the Default Editor" (there is none for them)

## [1.0.0]

- Hex editor of files of any size, ported from the hex view of Claude-AI's file viewer: virtual rows,
  64 KB blocks, overwrite / insert / delete in a piece table, go to an offset, saving in place or by a
  rewrite through a temporary copy (with a free-space check), reload on changes on disk
- VS Code's undo / redo, save, Save As, revert and hot exit; English and Russian
- Extension icon: the universe icon of gw with the label BIN, white on a black square with rounded
  corners (`scripts/make-icon.swift`, source `resources/icon-space.svg`)
