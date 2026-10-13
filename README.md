<p align="center"><img src="media/logo.png" width="112" alt="Codebloom logo"></p>

# Codebloom: code mind maps for VS Code

**See any code file as a mind map, with the real code on every branch.** Python, Java and JavaScript are built in. TypeScript, CSS, HTML and Markdown work out of the box, and Go, Rust, C#, C++ and anything else work through the language extension you already have.

Codebloom splits a file into its blocks (imports, globals, classes, methods, functions and the entry point) and lays them out around the file name in soft pastel branches. Click any block to open its code in place and jump the editor to it. Arrows show what it calls and what calls it, including calls into other files in your workspace.

![Codebloom showing Flask's app.py with one method open and its call arrows](media/screenshots/map-dark.png)

## Why

People read long files from top to bottom, but code is a graph. Codebloom shows both: the shape of the whole file as a map, any block's code one click away, and your real editor right beside it, kept in sync.

Codebloom is inspired by [epy (Extended Python)](https://github.com/phoenix2610/Extended_Programming). It is a separate implementation built for the editor:

- **Built into the editor.** It runs inside VS Code, with no Python process to start and no browser page to rebuild. Parsing uses tree-sitter compiled to WebAssembly, in-process.
- **Live.** The map updates as you type. Re-parsing a 1,600-line file takes about 9 ms.
- **Opens before indexing finishes.** The current file is mapped immediately. The rest of the workspace is indexed in the background so cross-file links fill in on their own.
- **Fast on big files.** Layout is computed from text metrics, and only the blocks on screen are rendered.
- **Any language, same size.** Python, Java and JavaScript (including JSX) use bundled parsers with cross-file links. Every other language is mapped from the outline its VS Code language extension already provides, so supporting it adds nothing to Codebloom's download.

## Getting started

1. Open a code file. Python, Java, JavaScript, TypeScript, CSS, HTML and Markdown are on by default; run **Codebloom: Choose Languages…** to add others.
2. Click the **Codebloom** icon in the editor title bar, press <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> on Windows/Linux), or run **Codebloom: Open Mind Map** from the Command Palette.
3. The map opens beside your code and follows whichever supported file you switch to.

## Features

| | |
|---|---|
| **Names and Code modes** | Names mode shows labels and opens only the selected block as code. Code mode shows every block as a code card. |
| **Call arrows** | Select a block to see what it calls (blue) and what calls it (peach). |
| **Callbacks count** | Functions passed as values (`graph.add_node("plan", plan_node)`, `addEventListener("click", this.onClick)`, `{ handler }`) show as **Passed as a value** with a dotted arrow, so registered handlers don't look unused. Decorators such as `@app.route` are shown too. |
| **Back and forward** | Follow calls from block to block and file to file, then step back with <kbd>Alt</kbd>+<kbd>←</kbd>. A trail above the map shows where you've been. |
| **Cross-file links** | Resolves imports, `self`/`this`, inheritance, simple local typing (`x = Foo()`, `Foo x = new Foo()`), Java packages, static imports and overloads, JS `require`, default exports and `Foo.prototype.bar = function` patterns. |
| **Editor sync** | Clicking a block scrolls the editor to it. Moving the cursor in the editor highlights its block in the map. |
| **Details panel** | Shows the signature, docs, decorators, calls, callers and unlinked calls, plus **Copy as context** to paste a block and its call graph into an LLM chat. On narrow editors it floats over the map. |
| **Full-width map** | The expand button in the header (or **Codebloom: Toggle Full-Width Map**) gives the map the whole editor area and back. |
| **Outline view** | The same structure as an indented list. |
| **Search** | Press <kbd>/</kbd> to jump to any block by name, with fuzzy matching. |
| **Folding** | Fold any class or function. **Expand all** and **Collapse all** work on the whole file. |
| **Theme aware** | The pastel palette has tuned light and dark variants and follows your VS Code theme. |

![Light theme](media/screenshots/map-light.png)

![Outline view](media/screenshots/outline-light.png)

## Languages

| | How it's mapped | Calls |
|---|---|---|
| Python, Java, JavaScript | Bundled tree-sitter parsers | Linked across the whole workspace in the background |
| TypeScript, CSS, SCSS, Less, HTML, Markdown | Outline from VS Code's built-in language support | From the call hierarchy, looked up when you select a block (TypeScript) |
| Go, Rust, C#, C++, PHP, Ruby, Kotlin and others | Outline from your installed language extension (gopls, rust-analyzer, C# Dev Kit, clangd…) | From the call hierarchy, when the extension provides one |

Only languages in `codebloom.languages` are mapped. **Codebloom: Choose Languages…** shows every language VS Code knows with a checkbox. When you switch to a file in a language that is off, the map says so and offers to turn it on. If no installed extension reports an outline for a language, the file is shown as a single block with a button to find one.

## Keyboard

| Key | Action |
|---|---|
| <kbd>/</kbd> | Search blocks |
| <kbd>↑</kbd> <kbd>↓</kbd> | Previous / next sibling |
| <kbd>←</kbd> <kbd>→</kbd> | Parent / first child (mirrored on the left side of the map) |
| <kbd>Enter</kbd> | Put the cursor in the selected block |
| <kbd>Space</kbd> | Fold / unfold |
| <kbd>C</kbd> | Toggle Names / Code |
| <kbd>O</kbd> | Toggle Map / Outline |
| <kbd>F</kbd> | Fit the map |
| <kbd>+</kbd> <kbd>-</kbd> <kbd>0</kbd> | Zoom in / out / reset |
| <kbd>D</kbd> | Show or hide the details panel |
| <kbd>Alt</kbd>+<kbd>←</kbd> <kbd>Alt</kbd>+<kbd>→</kbd> | Back / forward (also <kbd>[</kbd> <kbd>]</kbd> and the mouse side buttons) |
| <kbd>Esc</kbd> | Deselect |
| <kbd>?</kbd> | Show the shortcut list |

Drag the background to pan. Use the mouse wheel or a pinch to zoom; two-finger scrolling on a trackpad pans.

## Commands

- **Codebloom: Open Mind Map**: map the active file.
- **Open in Codebloom Mind Map**: from the Explorer context menu.
- **Codebloom: Copy Block at Cursor as LLM Context**: also in the editor context menu.
- **Codebloom: Re-index Workspace**
- **Codebloom: Choose Languages…**
- **Codebloom: Toggle Full-Width Map**

## Settings

| Setting | Default | |
|---|---|---|
| `codebloom.languages` | Python, Java, JavaScript, TypeScript, CSS, SCSS, Less, HTML, Markdown | Language ids to map. |
| `codebloom.preferLanguageServer` | `false` | Map Python, Java and JavaScript from their language extensions too, for their call accuracy instead of the built-in parsers' speed. |
| `codebloom.openLocation` | `beside` | Open the map `beside` your code or as a full-width `tab`. |
| `codebloom.defaultMode` | `names` | Start in `names` or `code` mode. |
| `codebloom.maxCardLines` | `24` | Longest code shown on a card before it is cut off. |
| `codebloom.followActiveEditor` | `true` | Switch the map when you switch files. |
| `codebloom.syncCursor` | `true` | Highlight the block under the cursor. |
| `codebloom.revealOnClick` | `true` | Clicking a block scrolls the editor to it. |
| `codebloom.indexWorkspace` | `true` | Index the workspace for cross-file links. |
| `codebloom.maxFiles` | `4000` | Upper limit on indexed files. The header warns when a workspace is bigger. |
| `codebloom.exclude` | `node_modules`, `.git`, `venv`, `dist`, `build`, … | Globs the index skips. |

## Limits

Call resolution is static and best-effort. It cannot link calls whose target is only known at runtime: `getattr`, functions stored in dicts, or methods on objects whose type is not visible (for example, an untyped function parameter). Those calls are listed under **Unlinked calls**. A block with no direct callers says so and suggests why (passed as a value, a decorator, or dynamic dispatch) rather than showing a bare zero.

For other languages, blocks and calls are whatever the language extension reports. Some extensions provide an outline but no call hierarchy; the details panel then says call information is unavailable. Functions defined inside a top-level `if` or `try` are part of that statement's block rather than getting their own.

## Privacy

Everything runs locally. Codebloom makes no network requests and collects no telemetry. For languages other than Python, Java and JavaScript it asks your installed language extensions for the outline and call hierarchy, through VS Code.

## License

MIT
