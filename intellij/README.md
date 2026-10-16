# Codebloom for IntelliJ

The Codebloom mind map for IntelliJ IDEA and the other JetBrains IDEs (2024.3 and later). It is the same map UI as the [VS Code extension](../README.md), running in the IDE's built-in browser, with IntelliJ's own code model underneath.

## How it works

| | VS Code extension | IntelliJ plugin |
|---|---|---|
| Map UI | `src/webview` | Same files, bundled and hosted in JCEF (`MapPanel.kt`) |
| Blocks | tree-sitter / language-server outline | The IDE's Structure view, for any language the IDE understands |
| Calls | Static resolver / call hierarchy | IntelliJ reference resolution, so Java and Kotlin links are exact |
| Callers | Workspace index / call hierarchy | Reference search when a block is selected, including calls through interfaces and base methods (Java) |

Java gets exact block kinds, signatures, Javadoc, annotations, `new` → constructor links and method references as "passed as a value" (`JavaSupport.kt`). Java support lives behind the `languageSupport` extension point and loads only when the Java plugin is present, so the plugin also runs in PyCharm, WebStorm and the rest. Other languages use generic rules based on their PSI classes (`MapBuilder.genericKind`).

## Use

Open the **Codebloom** tool window on the right, or choose **Open Codebloom Map** from the editor or Project view context menu (<kbd>⌘⌥⇧M</kbd> / <kbd>Ctrl+Alt+Shift+M</kbd>). To give the map more room, choose **Open Codebloom Map in Editor Tab**: it opens like any other file, so you can split it beside your code, drag it to another window or maximize it. The map follows the selected editor and its caret. **Copy Block as LLM Context** in the editor context menu copies the block at the caret with its calls and callers.

## Build

```sh
npm run build            # in the repository root: builds the webview the plugin bundles
cd intellij
./gradlew test           # headless IntelliJ tests (Java fixtures)
./gradlew buildPlugin    # build/distributions/codebloom-intellij-<version>.zip
./gradlew verifyPlugin   # Plugin Verifier: IntelliJ 2024.3, 2026.2 and PyCharm 2025.3
./gradlew runIde         # a sandbox IDE with the plugin installed
```

`runIde` also has a self-test for development: `-Pcodebloom.selfTestProject=<dir> -Pcodebloom.selfTestFile=<path in project> -Pcodebloom.selfTestOut=<dir>` opens the file, shows the map, selects a method, writes what the page shows to `<dir>/report.txt` and the rendered page to `<dir>/page.html`, then exits.
