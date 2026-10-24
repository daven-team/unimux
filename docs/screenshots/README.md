# README screenshots

The PNGs in this folder come from the real Electron application in English. `scripts/capture-readme.mjs` builds all of its demo data in a temporary folder and never loads an installed app's data:

- an **Atlas storefront** project (plus two more project entries) that is a scratch git repository with a few commits, a merged branch and staged, modified and untracked files, three grids (**Agents**, **Development**, **Servers**), notes, snippets with variables and a review-team preset;
- scripted stand-ins for the `claude` and `codex` commands in the scratch home: they print a fixed demo session, post the status hooks a real Claude Code would (so the cells show "working: Edit" and "needs approval: Bash") and never contact a model; demo transcripts with token counts only give the context meter its numbers;
- SSH hosts on the local test server `scripts/ssh-test-server.mjs` (status bar answers of a Debian server, SFTP and a small shell over a demo folder) and a second test server whose host key is not trusted yet, for the connect card; a few more hosts that are never contacted;
- a SQLite file, a local Postgres (`scripts/pg-test-server.mjs`, PGlite) and a local Redis (`scripts/redis-test-server.mjs`) with demo data, plus two listed connections that are never opened.

From the repository root, with Node.js 22 or newer and dependencies installed:

```sh
npm run build
node scripts/capture-readme.mjs
```

An Electron desktop environment is required. The script uses `MC_DATA_DIR` for isolated state, `MC_OFFSCREEN=1` to keep its window away from the desktop, and a dynamically allocated `MC_DEBUG_PORT` to control and capture the renderer over CDP. It does not modify source files or an installed app's settings. The shell cells use cmd on Windows and bash on macOS.

| Image | View |
| --- | --- |
| `main.png` | The Agents grid: Claude Code and Codex cards with statuses and context usage, a shell with test output and an SSH session with its status bar |
| `grid-dialog.png` | New grid with the review-team preset: profiles, roles and startup prompts |
| `detached.png` | The Development grid in its own window |
| `split.png` | A Markdown preview beside the Development grid |
| `palette.png` | Command palette searching for "new" |
| `ssh-session.png` | Two SSH cells: a connected one with the status bar and its disk card, and the connect card asking to trust a new host key |
| `ssh.png` | SSH view: colored host cards by group and the details of web-1 |
| `sftp.png` | SFTP: a marquee selection on the local side, a typed remote path with folder suggestions, finished uploads |
| `settings.png` | Settings, SSH section: themes and status bar items |
| `git.png` | Git panel: staged, modified and untracked files, the history graph and a working-tree diff |
| `git-clone.png` | Clone repository dialog |
| `database.png` | A Postgres table with two staged edits and the connection tree |
| `sql.png` | SQL editor with a result set and the query history |
| `redis.png` | Redis key browser with a hash |
| `db-connection.png` | Connection form: a tunnel through an SSH host and TLS |
| `notes.png` | Snippets and Notes in the right column, a checklist note in preview |
| `snippets.png` | A snippet asking for its variable before it is pasted |
| `find.png` | Editor with the find box |
| `monitor.png` | Monitor panel with the processes of every cell |

To review a capture before replacing the tracked images, pass an output directory:

```sh
node scripts/capture-readme.mjs ./capture-review
```

`--only main,sftp` captures only the named images (each step starts from the Agents grid), and `--hold` stops after the setup, prints the debug port and keeps the app running to try steps by hand. `--verify` runs the workspace checks of `scripts/verify-workspace-ui.mjs` after the capture.

The script logs its temporary demo directory and closes its own Electron instance and test servers when finished. Temporary data is kept for inspection. CDP sets the actual renderer viewport to 1600×1000 (the detached window 1400×860); platform fonts and test timings may vary. Do not run while another process is rebuilding `out/`. Inspect every image before committing it.

The app also gets a scratch home (`USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`), so it never reads your profile, `~/.claude`, `~/.codex`, `~/.ssh` or the data of an installed app. The app shows the project folder path (shell prompts, the SFTP local pane). If your system temp path includes your personal name, set `MC_CAPTURE_ROOT` to a generic, writable directory before capturing. For example, in PowerShell:

```powershell
$env:MC_CAPTURE_ROOT = 'D:\Temp\demo'
node scripts/capture-readme.mjs
```
