# Keyboard shortcuts

On macOS, replace **Ctrl** with **Cmd** and **Alt** with **Option**.

These are the defaults. Every one of them can be changed, disabled or restored in **Settings → Keyboard shortcuts**: click **Change**, press the new combination, and the app warns when another action already uses it (you can swap them) or when the keys are reserved by the system or the terminal.

| Shortcut | Action |
|---|---|
| `Ctrl+K` / `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+T` | New tab with a single terminal |
| `Ctrl+Shift+G` | New grid or grid template |
| `Ctrl+Shift+N` | Add an agent to the current grid |
| `Ctrl+Shift+W` | Close the tab in front: a grid (it goes to History), a file, the SSH view or Settings |
| `Ctrl+Shift+H` | History of conversations and grids |
| `Ctrl+Shift+M` | Maximize or restore the cell (or double click its header) |
| `Ctrl+Alt+Arrows` | Move between cells |
| `Ctrl+Alt+Shift+Arrows` | Swap the focused cell with its neighbour (or drag a cell by its header onto another one) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Recently used tab of the strip (grids of all projects, files): a tap toggles between the last two, holding `Ctrl` and pressing `Tab` again walks further with a switcher, releasing `Ctrl` switches (also `Ctrl` on macOS). "Next tab" / "Previous tab" in strip order have no key by default and can be bound in Settings |
| `Ctrl+Shift+B` / `Ctrl+Shift+E` | Toggle snippets / projects panel |
| `Ctrl+Alt+F` | Search every Claude Code and Codex conversation of all projects |
| `Ctrl+Shift+U` | Send one prompt to several agents (Claude and Codex cells of every grid and window) |
| `Ctrl+Shift+D` | Add a prompt to the queue of the focused agent cell |
| `Ctrl+Alt+PageDown` / `Ctrl+Alt+PageUp` | Next / previous cell that waits for you (also from a detached window) |
| `Ctrl+Wheel` | Zoom a single cell |

Plain `Ctrl+T`, `Ctrl+B` and `Ctrl+W` in terminals are left alone on purpose: Claude Code and Codex use them.

## Files and editor

In the Files tree, `F2` renames, `Delete` moves to the trash, and `Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Ctrl+Z` / `Ctrl+A` copy, cut, paste, undo and select all.

A single click on a file, or `Space` on it in the tree, opens it in the preview tab (its name in italics) and leaves the keyboard in the tree: the next file opened that way replaces it instead of adding a tab. A double click on the file or on the tab, `Enter`, an edit, a save or dragging the tab keeps it open; a double click on the file and `Enter` also move the keyboard into the editor. In the Git panel, a double click on a change or on a file of a commit keeps its diff tab.

In an editor tab, `Ctrl+S` saves the file and **Tab** inserts indentation. The editor toolbar offers line wrapping and a close button with unsaved-change protection (save, discard or cancel).
