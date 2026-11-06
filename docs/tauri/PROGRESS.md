# unimux Tauri migration: progress log

The orchestrator updates this file after every step. Status values: `todo`, `in progress`, `done` (code merged into `tauri-1.2.0`), `verified` (acceptance tests from PLAN.md passed). Dates are filled in when a status changes.

Branch: `tauri-1.2.0`. Specs: ARCHITECTURE.md, PLAN.md, INVENTORY.md. Plan: ALL AT ONCE (one release, 1.2.0, fully Rust + Tauri v2, no Node sidecar).

## Decision log

| date | decision | by | effect |
|---|---|---|---|
| 2026-11-06 | **ALL AT ONCE.** 1.2.0 ships only when the WHOLE app is Rust + Tauri v2 with full parity. No Node sidecar in the shipped app; Node only as a build tool for the React UI and tests. | user | Staged plan (sidecar in 1.2.0, ports in 1.3.0 to 1.6.0) dropped; ARCHITECTURE.md = design 1 + grafts; PLAN.md rewritten into waves 0 to 7 (93 packages, 291.5 agent-days). |
| 2026-11-06 | Installs done: Node 26 LTS, Docker Desktop (WSL2), VirtualBox (Windows VM image not downloaded yet), cargo on PATH. | user | Node 24 / SEA no longer needed. VM image needed for SP3 / U3 / B3 PAC check. |
| 2026-11-06 | Updater signing key generated. GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` exist. Public key `D:\Projekty\_unimux-tauri-keys\unimux-updater.key.pub` (minisign key id 817A07BB564AC8D0) is embedded; agents never read, print or copy the private key or password. | user | Public key recorded in ARCHITECTURE section 8; used by F2 / U1 / U4. |
| 2026-11-06 | **Keep the current look.** Windows caption buttons drawn to look exactly like today (Electron titleBarOverlay #0d0d0d / #8a8a8a, height 36). | user | Package W1 (reference images from 1.1.4, pixel diff at 4 scaling levels); release gate item 8. |
| 2026-11-06 | **Keep the custom update window** (progress, stages, restart) for updates between Tauri versions too, not the stock installer UI. | user | Packages SP6, U2 (Windows), U5 (macOS); tauri-plugin-updater not used for install; NSIS `passive` mode dropped. |
| 2026-11-06 | **Keep publishing latest.yml / latest-mac.yml** so Electron 1.1.x installs update into 1.2.0. | user | U3 transition, U4 asset list, every release from now on. |

Still open (see the Polish section at the end): macOS identifier com.ajzakomator.app + one Keychain prompt, fallback bridge release 1.1.5 if SP3/SP4 fail, Mac access, 1.1.4 test data.

## Status

### Wave 0a: foundation

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| F1 | Cargo workspace, Vite and build scripts | todo | | | | first; everything waits for it |
| F2 | tauri.conf, capabilities, CSP, sender guard | todo | | | | embeds the updater public key |
| F3 | IPC contract generator, Rust router, not-yet stubs | todo | | | | |
| F4 | Renderer window.mc adapter | todo | | | | |
| F5 | Process start: data dir, dev overrides, crash log | todo | | | | |
| F6 | Single instance, compatible with Electron 1.1.x | todo | | | | macOS half re-checked in R3 |
| F7 | State store: load, save, controller | todo | | | | |
| F8 | State normalize port | todo | | | | |
| F9 | State edits, patches, broadcast, state commands | todo | | | | |
| F10 | Golden corpus, PORTING.md, messages export | todo | | | | |
| F11 | Main window, startup gate order, window state, WebView settings | todo | | | | |
| F12 | CI skeleton | todo | | | | |
| F13 | Real-app harness base | todo | | | | |
| F14 | Exec helper and env | todo | | | | |

### Wave 0b: spikes

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| SP1 | WebView2 shell behaviour | todo | | | | |
| SP2 | Electron safeStorage both directions | todo | | | | Mac half needs a Mac |
| SP3 | Windows 1.1.4 -> Tauri NSIS hand-over | todo | | | | needs the VirtualBox Windows VM image |
| SP4 | macOS 1.1.4 engine accepts the Tauri zip | todo | | | | needs a Mac |
| SP5 | Rust ConPTY + Channel | todo | | | | |
| SP6 | Custom update window process | todo | | | | |
| SP7 | russh coverage | todo | | | | Docker |
| SP8 | MCP wire with real CLIs | todo | | | | scratch home |
| SP9 | DB wire fidelity | todo | | | | Docker |

### Wave 1

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P1 | Rust pty core | todo | | | | |
| B1 | Dual host test harness (unimux-hostd) | todo | | | | |
| B2 | unimux-oscrypt production | todo | | | | |
| B3 | Rust http_fetch | todo | | | | PAC check in the VM |
| W1 | Windows caption buttons that look like today | todo | | | | reference images from 1.1.4 first |
| W2 | macOS window chrome, app menu, WebKit compatibility | todo | | | | |
| W3 | OS file drop and localStorage import | todo | | | | |
| W4 | Notifications, attention, badge, beep, dialogs, clipboard, shell, sound files | todo | | | | |
| W5 | Detached windows and event routing | todo | | | | |
| W6 | Lifecycle: quit, session end, renderer crash and hang | todo | | | | |
| G1 | Git runner, env scrub, caches, canonical paths | todo | | | | |
| G5 | Project files: listing, preview, save, local files | todo | | | | |
| H1 | Hook server | todo | | | | |
| H3 | CLI detector | todo | | | | |
| H5 | Conversation search | todo | | | | |
| D3 | SQL helper ports | todo | | | | |
| A1 | Accounts stores and Claude Code locks | todo | | | | |
| M1 | MCP HTTP server | todo | | | | |
| S2 | SSH key handling | todo | | | | |
| U2 | Custom update window (Windows) | todo | | | | |
| X1 | Real-app script migration | todo | | | | |

### Wave 2

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P2 | Pty output engine and Channel data plane | todo | | | | |
| G2 | Git parsers, validators, trust | todo | | | | |
| G6 | File operations with progress | todo | | | | |
| G7 | Project search and replace | todo | | | | |
| G8 | Notes, fs probes, monitor, changelog | todo | | | | |
| H2 | Claude settings, Codex hooks, fallback, cell files | todo | | | | |
| H4 | Context tracker, sessions, codex bind | todo | | | | |
| S1 | SSH stores | todo | | | | |
| D1 | DB service, vault, history, sqlite files | todo | | | | |
| A2 | Activation, swap journal, recovery | todo | | | | |
| A6 | GitHub token store, device flow, status | todo | | | | |
| M2 | MCP tools, validation, elicitation | todo | | | | |
| U1 | Update coordinator and startup gate flow | todo | | | | |
| U5 | macOS update engine in the update window | todo | | | | Mac check in R3 |
| W7 | Core cell bookkeeping, startup gates, taskbar, misc commands | todo | | | | |

### Wave 3

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P3 | Pty service: spawn, routing, replay, supervision | todo | | | | |
| G3 | Git reads, mutations, commands, publish | todo | | | | |
| G4 | Worktrees, clone, init, installGit | todo | | | | |
| S3 | russh login core and SshCoordinator | todo | | | | Docker |
| A3 | Reconcile, resync, token refresh | todo | | | | |
| D4 | Postgres client: connect, simple query, TLS | todo | | | | Docker |
| D7 | MySQL/MariaDB client core | todo | | | | Docker |
| D9 | Redis sessions and browsing | todo | | | | |
| D11 | SQLite sessions | todo | | | | |
| U3 | Electron 1.1.x -> 1.2.0 transition | todo | | | | needs VM + Mac |

### Wave 4

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P4 | Shell integration, launch line, cell spawn | todo | | | | |
| P5 | SSH shell cells on russh | todo | | | | |
| H6 | Install manager, login terminals, agent delivery | todo | | | | |
| S4 | SSH IPC and russh test server | todo | | | | Docker |
| T1 | SFTP service and sessions | todo | | | | |
| D2 | SSH tunnels for databases | todo | | | | |
| D5 | Postgres cursors and read-only | todo | | | | |
| D8 | MySQL session, meta, edits | todo | | | | |
| D10 | Redis writes, console, pattern ops, pub/sub | todo | | | | |
| A4 | Login managers | todo | | | | |
| A5 | Usage, auto-switch, limit alerts | todo | | | | |
| M3 | Automation operations | todo | | | | |
| U4 | CI and release pipeline | todo | | | | uses the signing secrets in CI only |

### Wave 5

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| D6 | Postgres metadata, pages, edits | todo | | | | |
| T2 | SFTP remote and local sides | todo | | | | |
| M4 | wait_for, delivery, team prompts | todo | | | | |

### Wave 6

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| T3 | SFTP transfer queue | todo | | | | |
| T4 | SFTP manage ops and editor files | todo | | | | |
| T5 | Sudo SFTP over exec | todo | | | | Docker |
| D12 | DB result routing and detached DB windows | todo | | | | |

### Wave 7: release

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| R1 | Remove Electron | todo | | | | |
| R2 | Parity and performance sweep | todo | | | | |
| R3 | macOS pass | todo | | | | needs a Mac |
| R4 | 1.2.0 docs, i18n, release | todo | | | | user approves the test build and notes |

## Contract and porting counters

Updated after every merge (`npm run ipc:report`, `node scripts/porting-count.mjs`; both exist after F3 / F10).

| date | window.mc implemented | events implemented | PORTING.md ported | verify scripts green |
|---|---|---|---|---|
| 2026-11-06 | 0 / 245 | 0 / 45 | 0 / about 1,815 | 0 / 44 |

## 1.2.0 release gate checklist

See PLAN.md "1.2.0 release gate". Tick here when verified.

- [ ] 1. Spikes SP1 to SP9 green or fallback re-tested
- [ ] 2. typecheck, npm test, cargo fmt/clippy/test green on Windows and macOS CI
- [ ] 3. No Node in the shipped app (installer and .app checked)
- [ ] 4. Contract 245/245 and all events, PORTING.md 100 percent, goldens no diff, guard tests, no 3.0.0-alpha
- [ ] 5. verify-cli-contract, verify-team-start and all other verify scripts green
- [ ] 6. Upgrade test on a 1.1.4 data copy + downgrade check + no parallel 1.1.4/1.2.0 on one data dir
- [ ] 7. Windows VM transition, macOS harness transition, Tauri -> Tauri update through the custom window
- [ ] 8. Look kept: caption buttons match 1.1.4 references; update window as in 1.1.4
- [ ] 9. Isolation test (real profile untouched)
- [ ] 10. No-console start and `-e` legacy call
- [ ] 11. Performance vs 1.1.4
- [ ] 12. macOS manual checklist
- [ ] 13. CI rehearsal assets incl. latest.yml, latest-mac.yml, latest.json + .sig, signatures verified
- [ ] 14. User tested a test build and approved the release note
- [ ] 15. Published via `npm run publish-release` (dry run first)

## Install status (2026-11-06)

| item | status |
|---|---|
| Visual Studio 2026 C++ tools (VC Tools x86/x64) | installed |
| Windows 11 SDK | to confirm in the VS installer ("Desktop development with C++") |
| Rust 1.99.1 MSVC, cargo on PATH | installed |
| Node 26 LTS (npm) | installed (build tool only) |
| WebView2 Runtime 156 | installed |
| Docker Desktop with WSL2 | installed |
| VirtualBox | installed |
| Windows VM image for VirtualBox | **not downloaded yet**; needed for SP3 (wave 0 spike), B3 PAC check, U3 |
| Tauri CLI | project dependency added in F1 (`@tauri-apps/cli ~2.12.4`), nothing global; NSIS downloads on the first `tauri build` |
| Updater signing key + GitHub secrets | done; public key embedded |
| Mac access | not available yet; needed for SP2 (Mac half), SP4, R3 |

## Log

| date | step | result |
|---|---|---|
| 2026-11-06 | Inventory of 12 units, 3 designs, 3 judge reports | Winner by votes: design 3 (staged strangler), with grafts from designs 1 and 2 |
| 2026-11-06 | docs/tauri/ARCHITECTURE.md, PLAN.md, INVENTORY.md, PROGRESS.md written | 92 packages, 293 agent-days total; 1.2.0 = 33 packages, 93 agent-days. Waiting for user decisions. |
| 2026-11-06 | Critic review of the four docs against the source | 1.2.0 = 34 packages, 98 agent-days; total 93 / 298. |
| 2026-11-06 | User decisions recorded (decision log above) | ALL AT ONCE: PLAN.md rewritten into waves 0 to 7 (93 packages, 291.5 agent-days + 20-25 percent integration, about 11 to 13 calendar weeks with 6 agents); sidecar-only packages dropped (S2, A3, A4, A5, A7, P3b, N2, B2 mirror, I10, R1-R4 sweeps); 1.3-1.6 packages folded in; new packages: F1-F14 foundation, SP6 + U2 + U5 custom update window, W1 caption buttons, F6 Electron singleton compat, X1 script migration, R1 Electron removal. ARCHITECTURE.md rewritten for the single Rust process. |

## Do zainstalowania / do decyzji użytkownika

### Decyzje podjęte 2026-11-06

1. Wszystko naraz: 1.2.0 wychodzi dopiero, gdy cała aplikacja jest w Rust + Tauri v2 i działa jak 1.1.4. Bez sidecara Node.
2. Wygląd zostaje: przyciski okna na Windows rysowane tak, żeby wyglądały jak dziś; własne okno aktualizacji (postęp, etapy, restart) także przy aktualizacjach między wersjami Tauri.
3. latest.yml i latest-mac.yml publikowane przy każdym wydaniu (aktualizacja z Electron 1.1.x do 1.2.0).
4. Klucz podpisywania aktualizacji wygenerowany, sekrety GitHub ustawione.

Szacunek: około 290 dni pracy agentów + 20-25 procent na integrację, czyli realnie 11-13 tygodni przy 6 agentach równolegle. Wersja testowa do sprawdzenia przed wydaniem.

### Nadal otwarte

1. **macOS: identyfikator com.ajzakomator.app zostaje** (zachowuje uprawnienia systemowe i zgodność z aktualizatorem 1.1.x). Po aktualizacji macOS raz zapyta o dostęp do pęku kluczy ("Zawsze zezwalaj"). Akceptujesz?
2. **Plan awaryjny.** Jeśli testy przejścia (SP3/SP4) nie wyjdą, potrzebne będzie wydanie pomostowe 1.1.5 na Electronie. Zgoda?
3. **Kopia testowych danych 1.1.4** (KOPIA, nie oryginał `%APPDATA%\unimux`) albo zgoda, żebym utworzył syntetyczne dane w 1.1.4 pod `MC_DATA_DIR` z testowymi hasłami SSH/DB i tokenem GitHub.

### Do zrobienia po Twojej stronie (gdy będzie potrzebne)

1. **Obraz Windows dla VirtualBox** (np. oficjalna maszyna deweloperska Windows 11 albo ISO z licencją) do testu aktualizacji 1.1.4 -> 1.2.0 (spike SP3, potem U3). Nigdy na Twoim prawdziwym profilu.
2. **Dostęp do Maca** (Apple Silicon, Xcode Command Line Tools, Rust) do testu pęku kluczy, aktualizatora 1.1.4 -> 1.2.0, okna aktualizacji i ręcznej listy kontrolnej (SP2, SP4, R3).
3. **Kopia zapasowa klucza podpisywania offline.** W folderze `D:\Projekty\_unimux-tauri-keys` leży też plik z hasłem; warto przenieść hasło do menedżera haseł i zrobić kopię klucza na nośniku offline (utrata klucza = koniec aktualizacji dla wersji Tauri). Agenci nie czytają tych plików.
4. Sprawdzić w instalatorze Visual Studio, czy jest Windows 11 SDK ("Programowanie aplikacji klasycznych w C++").
5. Akceptacja wersji testowej przed wydaniem i przeczytanie `docs/releases/1.2.0.md`.
