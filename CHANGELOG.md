# Changelog

## 0.4.1

- **Scrolling onto a card selects it**, so the next scroll reads its code instead of zooming the map. A zoom or pan that is already under way carries on across cards; <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+wheel and pinch always zoom.
- When trackpad momentum reaches the end of a card, its footer now says **Pause, then scroll on for …**, since one gesture never moves on after scrolling the card.

## 0.4.0

- No changes to the VS Code extension; the version moves with the JetBrains plugin.

## 0.3.0

- **Read through a file on the map.** The selected block's card now scrolls through all of its code instead of stopping at `codebloom.maxCardLines`. Scroll past the end (about two more wheel notches) to move on to the next block in the file; scroll past the top to go back to the previous one, opened at its end. The arrows, details panel and editor follow along. Trackpad momentum never skips a block, and the card's footer shows what comes next.
- **Codebloom: Open Mind Map in New Tab** opens the map as a full editor tab, like any other file (also in the Explorer's right-click menu). The `codebloom.openLocation` setting still picks the default.
- When the map shares an editor group with your code, clicking a block no longer covers the map with the editor, however the map got there. Use Go to code or <kbd>Enter</kbd> to jump.

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
