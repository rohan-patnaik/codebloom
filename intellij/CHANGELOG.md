# Changelog

## 0.4.0

- **Open Codebloom Map in Editor Tab** (editor, Project view and editor-tab menus) opens the map as an editor tab, like any other file, instead of the narrow tool window. It can be split, dragged to another window or given the whole editor, and its tab is titled after the file on the map. The tool window stays.
- In a map tab, clicking a block moves editors already showing that file without covering the map; **Go to code** jumps there. The full-width button hides the tool windows (and brings them back).

## 0.3.0

- The selected block's card scrolls through all of its code. Scroll past its end to move on to the next block in the file, or past its top to go back; the arrows and details panel follow along.

## 0.2.0

- Align the JetBrains plugin version with VS Code and Open VSX. Both editor packages now take their version from the root `package.json` and ship through the same release workflow.
- Keeps the existing JetBrains features and shared map UI; this release corrects the separate version numbering.

## 0.1.0

First release for IntelliJ IDEA and other JetBrains IDEs (2024.3+).

- The Codebloom mind map in a tool window: blocks from the IDE's Structure view, the same pastel map, Names/Code modes, outline, search, back/forward and details panel as the VS Code extension.
- Calls resolved by IntelliJ; callers found across the project when you select a block, including calls through interfaces and base methods.
- Java: block kinds, signatures, Javadoc, annotations, constructors and method references as "passed as a value".
- Follows the editor and caret, matches the IDE theme. **Copy Block as LLM Context** action.
