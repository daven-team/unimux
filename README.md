<div align="center">

<img src="resources/branding/banner.png" width="100%" alt="unimux - terminal workspace for coding agents" />

<br />

**A terminal grid for running many Claude Code and Codex agents side by side on Windows and macOS.**

[![Release](https://img.shields.io/github/v/release/daven-team/unimux?style=flat-square&color=f4f4f5&labelColor=18181b)](https://github.com/daven-team/unimux/releases/latest)
[![Downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdaven-team%2Funimux%2Fbadges%2Fdownloads.json&style=flat-square)](https://github.com/daven-team/unimux/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/daven-team/unimux/ci.yml?branch=main&style=flat-square&label=tests&labelColor=18181b)](https://github.com/daven-team/unimux/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-f4f4f5?style=flat-square&labelColor=18181b)](#install)
[![License](https://img.shields.io/github/license/daven-team/unimux?style=flat-square&color=f4f4f5&labelColor=18181b)](LICENSE)

[**Download**](https://github.com/daven-team/unimux/releases/latest) · [Features](#features) · [Docs](#documentation) · [Po polsku](README.pl.md)

<br />

<img src="docs/screenshots/main.png" alt="A grid of agent cards: a working Claude Code cell, a Codex cell, a Claude cell waiting for a permission, a shell with test output and an SSH session with its status bar" width="100%" />

</div>

## Why

Running one AI coding agent is easy. Running six of them across three repos is not: terminals pile up,
you lose track of which one is waiting for you, and closing a window means losing the conversation.

unimux gives every project its own set of terminal grids, keeps every agent running in the
background, tells you which one needs you and why, and brings any grid or conversation back with one click.
Around the agents it has the tools you reach for while they work: files, Git, SSH and SFTP, databases, notes and snippets.

## Features

- **Agents in a grid**: Claude Code, Codex and shell cells as cards, from 1 cell up to 5×4, with live statuses, context usage and alerts
- **Nothing gets lost**: conversations resume after a restart, closed grids go to History, tabs can live in their own windows
- **SSH and SFTP**: saved hosts, keys and identities, SSH cells with a server status bar, a dual-pane file manager and remote file editing
- **Git panel**: changes, commit, history graph, publish to GitHub and clone
- **Databases**: Postgres, MySQL / MariaDB, SQLite and Redis, also through an SSH tunnel
- **Files and editor**: a fast file tree, editor tabs, find and replace, Markdown preview, CSV and Parquet tables
- **Notes, snippets and the `Ctrl+K` palette** for prompts, checklists and everything else
- **AI account limits** for Claude and Codex, and an **optional MCP** for coordinator / worker teams
- **Native terminals**: ConPTY on Windows (with hold Space to dictate), login shells on macOS, GPU rendering
- UI in English, Polish, German, Spanish, French and Portuguese

### Agents in a grid

- **Grids** from 1 cell up to 5×4, row layouts like `3+2`, merged cells and several grids per project. The tab strip shows the grids and files of every project (or only the active one), and `Ctrl+Tab` switches between them.
- **Cells as cards**: each cell has a header with the agent's icon (the Claude spark, the Codex cloud, a shell prompt or the SSH host), its status, name, details such as profile, model, worktree branch or user@host, and its own color.
- **Per-cell setup**: name, color, startup prompt, Claude Code / Codex / shell profile, model, MCP role and an optional isolated `git worktree`. Closing a worktree cell checks for uncommitted files and unmerged commits first.
- **Statuses with a reason**: ◐ working ("working: Edit"), ● waiting for you, "needs approval: Bash" the moment a permission question opens, and a red exit code when a command or CLI fails. A desktop notification and a sound tell you which agent finished or needs you.
- **Context usage** in the card header of Claude and Codex cells ("32%") with a small bar, amber over 70% and red over 90%. It is read from the conversation files when the agent reports, never by polling.
- **Tabs in their own window**: drag a grid, a file, a database or a Redis tab out of the window (or use "Move to new window") for a second monitor. Terminals keep running and the tab comes back when you close the window.
- **A file beside the grid**: "Open beside the grid" shows a file, diff, table or Redis view next to the grid with a divider you can drag.
- **History**: closed grids and past Claude and Codex conversations (also of removed worktrees) come back with one click, and conversations resume after a restart.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/grid-dialog.png" alt="New grid dialog with a review-team preset: a 2x2 layout, Claude Code and Codex profiles, MCP roles and startup prompts" /></td>
    <td width="50%"><img src="docs/screenshots/detached.png" alt="A grid of four shells in its own window with Add and Attach back" /></td>
  </tr>
  <tr>
    <td align="center"><sub>New grid: layout, profiles, roles and startup prompts</sub></td>
    <td align="center"><sub>A grid in its own window</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/split.png" alt="A Markdown preview of README.md beside a grid of four shells" /></td>
    <td width="50%"><img src="docs/screenshots/palette.png" alt="Command palette searching for new: actions for projects, snippets, grids, SSH, notes and databases, and new terminals" /></td>
  </tr>
  <tr>
    <td align="center"><sub>A file beside the grid</sub></td>
    <td align="center"><sub><code>Ctrl+K</code>: actions, tabs, notes, snippets and past conversations</sub></td>
  </tr>
</table>

### AI accounts and MCP

- **AI account limits**: the 5-hour and weekly limits of every Claude account the app knows and of Codex. On Windows you can save several Claude accounts and switch the one Claude Code uses.
- **Optional MCP** for teams: give cells a **Coordinator** or **Worker** role and they get local tools for tasks, messages, snippets and background grids. A coordinator can start a whole team with one call and wait for its tasks instead of polling. Agents can ask you for a decision (MCP elicitations, for example before closing a grid with open tasks), address other agents by name, and run the wait as a long MCP task where the client supports it. See [Agents and local MCP](docs/MCP.en.md).

### SSH and SFTP

- **SSH view** in the left rail: saved hosts as colored cards in groups with tags, keys (generate Ed25519, ECDSA or RSA, or import), identities (a user name with a password and/or key, reused by many hosts) and known hosts. Keys and passwords are encrypted with Windows DPAPI or the macOS Keychain and never reach agents.
- **SSH cells in any grid**, or a whole group opened as a grid. A cell connects behind a **connect card** with the steps (connecting, host key, signing in, shell), the host key and password questions and a log, with **Reconnect** when it fails.
- **Status bar** under every connected SSH terminal: the server's system and name, CPU with a small graph, memory, upload and download, uptime, logged-in users and the root disk (amber over 80%, red over 90%). Hover an item for details: load, all filesystems, everyone logged in.
- **In the terminal**: command suggestions from the host's history and your snippets, **Tab** completion of paths that really exist on the server, seven color themes (per host if you like), **Bulk send** of one command to every checked session, and optional reconnect of the sessions that were open when the app closed.
- **SFTP**: your computer on the left, the server on the right. Drag files and folders between them (also from the desktop), move, rename, delete, set permissions and run SFTP through sudo. A transfer queue shows progress and asks Replace, Skip or Keep both. Click the path bar (or press `Ctrl+L`) to type a path with folder suggestions, and drag a rectangle to select files.
- **Remote files in tabs**: open a server file in an editor tab and `Ctrl+S` writes it back, keeping its permissions; when the file changed on the server meanwhile, you choose to reload it, see the differences or overwrite it.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/ssh-session.png" alt="Two SSH cells: one connected with ls output, the status bar and its disk card, one showing the connect card that asks to trust a new host key" /></td>
    <td width="50%"><img src="docs/screenshots/sftp.png" alt="SFTP view: local files on the left with a marquee selection, the server on the right with a typed path and folder suggestions, finished uploads below" /></td>
  </tr>
  <tr>
    <td align="center"><sub>SSH cells: status bar and the connect card</sub></td>
    <td align="center"><sub>SFTP: two panes, typed paths, marquee selection, transfers</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/ssh.png" alt="SSH view: colored host cards grouped by production, staging and no group, with the details of web-1" /></td>
    <td width="50%"><img src="docs/screenshots/settings.png" alt="Settings, SSH section: vault, session restore, seven terminal themes and the status bar items" /></td>
  </tr>
  <tr>
    <td align="center"><sub>SSH view: hosts, keys, identities and known hosts</sub></td>
    <td align="center"><sub>Settings in six sections with a search</sub></td>
  </tr>
</table>

### Git

- **Changes and commit**: staged, unstaged and untracked groups, diffs in tabs, a commit box with **Commit & Push**, and fetch, pull and push with counters.
- **History** as a graph with branches and merges, searchable, fast with long histories.
- **Publish to GitHub** for a repository without a remote (it creates the repository, adds `origin` and pushes), and **Clone** into the project folder or a new folder that becomes a project.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/git.png" alt="Git panel with staged, not staged and untracked files, the history graph and a working-tree diff" /></td>
    <td width="50%"><img src="docs/screenshots/git-clone.png" alt="Clone repository dialog with a repository URL and a folder name" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Git panel: changes, diff and history graph</sub></td>
    <td align="center"><sub>Clone a repository</sub></td>
  </tr>
</table>

### Databases

- **Postgres, MySQL / MariaDB, SQLite and Redis** in a database panel with folders and folder colors. Connections can go through one of your SSH hosts (no open ports needed), use TLS, and be marked read-only. Passwords are encrypted like SSH secrets; the drivers are built in and run in their own process.
- **Tree and tables**: databases, schemas, tables, views, routines, columns, keys, indexes and DDL. Table data with paging, sorting, a WHERE filter and edits that wait highlighted until you save them in one transaction ("Show SQL" first if you like).
- **SQL editor**: run the statement under the cursor (`Ctrl+Enter`), the selection or the whole script, several result sets, cancel, explicit transactions, export, and a per-connection **query history** with search and favorites.
- **Redis**: a key tree grouped by `:`, every value type with editing and TTL, a console, Pub/Sub and server info.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/database.png" alt="Postgres products table with two staged edits highlighted and the connection tree with Local, Files and Production folders" /></td>
    <td width="50%"><img src="docs/screenshots/sql.png" alt="SQL editor with a join query, its result set and the query history with a favorite" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Table data with staged edits</sub></td>
    <td align="center"><sub>SQL editor and query history</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/redis.png" alt="Redis key browser with a tree of catalog keys and a hash open" /></td>
    <td width="50%"><img src="docs/screenshots/db-connection.png" alt="Connection form of a read-only Postgres connection: SSH and TLS page with a tunnel through db-1 and Require TLS" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Redis key browser</sub></td>
    <td align="center"><sub>Connections through an SSH host, with TLS</sub></td>
  </tr>
</table>

### Files, notes and snippets

- **Files and editor**: a fast file tree with git markers, preview tabs, a code editor with syntax highlighting, a Markdown preview, CSV tables (up to 200,000 rows) and Parquet files. Files changed by an agent reload by themselves.
- **Find everywhere**: `Ctrl+F` in the editor (`Ctrl+H` adds replace), the Markdown preview, diffs, CSV and Parquet tables and large files, and `Ctrl+Shift+F` in a terminal.
- **Notes** (`Ctrl+Shift+O`) for every project or one: Markdown with highlighted code, a preview with copyable code blocks, #tags with filters, checklists you tick in the preview, pinned notes, templates, a note as a full tab and quick capture of a terminal selection (`Ctrl+Shift+L`).
- **Snippets** (`Ctrl+Shift+B`): reusable prompts for one cell or the whole grid, with variables like `{{focus}}` or `{{focus:default}}` that are asked before pasting, plus `{{project}}`, `{{path}}`, `{{branch}}`, `{{date}}` and `{{clipboard}}`.
- **Monitor**: the CPU and memory of every cell's processes and of the app itself, and ending a process inside a cell.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/notes.png" alt="Snippets and Notes in the right column; a release checklist note in preview with ticked tasks and a code block" /></td>
    <td width="50%"><img src="docs/screenshots/snippets.png" alt="Insert snippet dialog asking for the focus variable, with the text to be sent" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Notes with tags, checklists and preview</sub></td>
    <td align="center"><sub>Snippet variables</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/find.png" alt="Code editor with the find box: match case, whole word and regular expression toggles and 12 matches" /></td>
    <td width="50%"><img src="docs/screenshots/monitor.png" alt="Monitor panel listing the processes of every cell with CPU and memory" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Editor with the find box</sub></td>
    <td align="center"><sub>Monitor: processes of every cell</sub></td>
  </tr>
</table>

## Install

Download the latest version from [Releases](https://github.com/daven-team/unimux/releases/latest):

| Platform | File |
|---|---|
| Windows 10 1809+ / 11 | `unimux-Setup-x.y.z.exe` |
| macOS, Apple Silicon | `unimux-x.y.z-mac-arm64.dmg` |
| macOS, Intel | `unimux-x.y.z-mac-x64.dmg` |

macOS builds are also available as ZIP archives. The builds are not signed with a paid certificate. On Windows, SmartScreen may need *More info → Run anyway*; on macOS, **System Settings → Privacy & Security → Open Anyway**.

You also need the agents you want to use on your shell's `PATH` (`claude`, `codex`). [PowerShell 7](https://aka.ms/powershell) is recommended on Windows; `git` is only needed for worktrees and the Git panel.

**Updates** are never installed without your click: the status bar offers a new version, and **Updates** in **Settings → General** chooses between **Manual** (the default) and **Automatic**, which asks at start. See [Updating](docs/UPDATES.md).

## Quick start

1. Add a project (any folder). Agents run in that folder.
2. Press `Ctrl+Shift+G` (`Cmd+Shift+G` on macOS) to create a grid and pick a profile for each cell.
3. Work. Status icons show which agent is waiting for you and why; `Ctrl+K` finds anything.

## Keyboard shortcuts

On macOS, use `Cmd` instead of `Ctrl`. Every shortcut can be changed in **Settings → Keyboard shortcuts**.

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Command palette |
| `Ctrl+Shift+G` | New grid or preset |
| `Ctrl+Shift+T` | New tab with a single terminal |
| `Ctrl+Shift+H` | History of conversations and grids |
| `Ctrl+Shift+M` | Maximize or restore the cell |
| `Ctrl+Alt+Arrows` | Move between cells |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+B` / `Ctrl+Shift+O` | Snippets / Notes |
| `Ctrl+Shift+F` | Find in a terminal |

The full list is in [Keyboard shortcuts](docs/SHORTCUTS.md).

## Documentation

- [Keyboard shortcuts](docs/SHORTCUTS.md)
- [Status, alerts and AI accounts](docs/ALERTS.md)
- [Agents and local MCP](docs/MCP.en.md)
- [Git panel and repository trust](docs/GIT.md)
- [SSH connections and SFTP](docs/SSH.md)
- [Updating](docs/UPDATES.md)
- [Development, architecture and releasing](docs/DEVELOPMENT.md)

## Development

```powershell
git clone https://github.com/daven-team/unimux
cd unimux
npm install
npm run dev
```

`npm test` runs the test suite and `npm run dist:win` / `npm run dist:mac` build installers. See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for details. The screenshots above come from the real app with demo data: see [capturing them](docs/screenshots/README.md).

Ideas and bug reports are welcome in [Issues](https://github.com/daven-team/unimux/issues).

## License

[MIT](LICENSE). Not affiliated with Anthropic or OpenAI. Claude Code and Codex are their respective owners' products.
