# Changelog

## 0.2.0

- Maps any language VS Code has a language extension for. Python, Java and JavaScript keep their built-in parsers; TypeScript, CSS, SCSS, Less, HTML and Markdown work out of the box; Go, Rust, C#, C++ and others use the outline and call hierarchy of your installed extension. The package size is unchanged.
- **Codebloom: Choose Languages…** and the `codebloom.languages` setting pick which languages are mapped. Switching to a file in a language that is off shows a notice with a one-click fix.
- Grammars load on first use, so a workspace only loads the parsers it needs.
- Functions passed as values (callbacks, handlers, LangGraph nodes, JSX props) are listed as **Passed as a value** with dotted arrows. Blocks with no direct callers explain why instead of showing a bare zero. Decorators and annotations are shown.
- Back and forward history (<kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd>, mouse buttons) with a trail of where you've been, across files.
- The details panel no longer repeats the code already open on the map, floats over the map on narrow editors instead of disappearing, and a new full-width toggle gives the map the whole editor area.
- The header warns when the workspace has more files than `codebloom.maxFiles` or indexing is off. "External calls" are now "Unlinked calls", with an explanation.
- New settings: `codebloom.preferLanguageServer`, `codebloom.openLocation`.
- Fix: cross-file call rows in the details panel were misaligned.

## 0.1.0

First release.

- Mind map of any Python, Java or JavaScript file: imports, globals, classes, methods, functions and entry points, each with its line range.
- Names mode (open one block as code) and Code mode (every block as a code card).
- Call arrows for the selected block, linked across files through a background workspace index.
- Details panel with signature, calls, callers, external calls, a code preview and "Copy as context".
- Outline view, search, keyboard navigation, fold/unfold, live updates while you type, cursor sync with the editor.
