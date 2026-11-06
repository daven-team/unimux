# unimux Tauri migration: progress log

The orchestrator updates this file after every step. Status values: `todo`, `in progress`, `done` (code merged), `verified` (acceptance tests from PLAN.md passed). Dates are filled in when a status changes.

Branch: `tauri-1.2.0`. Specs: ARCHITECTURE.md, PLAN.md, INVENTORY.md.

## Status

### 1.2.0

| id | title | wave | status | started | done | verified | notes |
|---|---|---|---|---|---|---|---|
| S1 | Tauri shell, WebView2 args, WS transport | 0 | todo | | | | |
| S2 | Node 24 SEA sidecar | 0 | todo | | | | needs Node 24 |
| S3 | Electron safeStorage both directions | 0 | todo | | | | needs a Mac for the Keychain half |
| S4 | Windows 1.1.4 -> Tauri NSIS hand-over | 0 | todo | | | | needs a Windows VM |
| S5 | macOS 1.1.4 engine accepts Tauri zip | 0 | todo | | | | needs a Mac |
| S6 | Rust ConPTY + Channel throughput | 0 | todo | | | | |
| A1 | Workspace scaffold | 1 | todo | | | | |
| B1 | Golden corpus + PORTING.md + messages export | 1 | todo | | | | |
| T0 | Contract and guard tests | 1 | todo | | | | |
| A2 | Rust process start | 2 | todo | | | | |
| A3 | Sidecar build and supervision | 2 | todo | | | | |
| A6 | Renderer bridge window.mc | 2 | todo | | | | |
| A8 | Main window and WebView settings | 2 | todo | | | | |
| P1 | Rust pty core | 2 | todo | | | | |
| N2 | unimux-blob:// protocol | 2 | todo | | | | |
| A4 | Electron shim in the sidecar | 3 | todo | | | | |
| P2 | Pty output engine + Channel data plane | 3 | todo | | | | |
| A13 | unimux-oscrypt production | 3 | todo | | | | |
| A12 | OS file drop, localStorage import, polyfills | 4 | todo | | | | |
| A5 | Hosts without utilityProcess | 4 | todo | | | | |
| A7 | Sidecar WS server and sender guard | 4 | todo | | | | |
| A9 | Detached and gate windows | 4 | todo | | | | |
| A11 | Notifications, badge, dialogs, clipboard | 4 | todo | | | | |
| N1 | Rust http_fetch | 4 | todo | | | | |
| P3 | Pty service wiring | 4 | todo | | | | |
| P3b | `--host=ssh` for SSH shell cells | 5 | todo | | | | added by critic review |
| A10 | Lifecycle: quit, session end, crash, hang | 5 | todo | | | | |
| A17 | Real-app harness migration | 5 | todo | | | | |
| A14 | Updater Tauri -> Tauri | 5 | todo | | | | |
| A15 | Electron 1.1.4 -> 1.2.0 transition | 6 | todo | | | | needs VM + Mac |
| A16 | CI and release pipeline | 6 | todo | | | | needs signing secrets |
| A18 | 1.2.0 parity and performance sweep | 7 | todo | | | | |
| A19 | macOS pass | 7 | todo | | | | needs a Mac |
| A20 | 1.2.0 docs, i18n and release | 7 | todo | | | | user approves notes |

### 1.3.0

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| B2 | State mirror, mutation RPC, route flip | todo | | | | |
| B3 | Dual host + unimux-hostd | todo | | | | |
| C1 | Git runner, env scrub, caches, paths | todo | | | | |
| C2 | Git parsers, validators, trust | todo | | | | |
| C3 | Git reads, mutations, commands | todo | | | | |
| C4 | Worktrees, clone, init, installGit | todo | | | | |
| C5 | Project files: listing, preview, save | todo | | | | |
| C6 | File operations with progress | todo | | | | |
| C7 | Project search and replace | todo | | | | |
| C8 | Notes, fs probes, monitor, changelog | todo | | | | |
| D1 | Hook server in Rust | todo | | | | |
| D2 | Claude settings, Codex hooks, fallback, cell files | todo | | | | |
| D3 | CLI detector | todo | | | | |
| D5 | Context tracker, sessions, codex bind | todo | | | | |
| D6 | Conversation search | todo | | | | |
| R1 | 1.3.0 release sweep | todo | | | | |

### 1.4.0

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| E1 | SSH stores in Rust | todo | | | | |
| E2 | SSH key handling | todo | | | | |
| E3 | russh login core and coordinator | todo | | | | |
| E4 | SSH IPC and russh test server | todo | | | | Docker |
| P4 | Shell integration, launch line, spawn in Rust | todo | | | | |
| P5 | SSH shell cells on russh | todo | | | | |
| P6 | Install manager and login terminals | todo | | | | |
| F1 | SFTP service and sessions | todo | | | | |
| F2 | Remote and local sides | todo | | | | |
| F3 | Transfer queue | todo | | | | |
| F4 | SFTP manage ops and editor files | todo | | | | |
| F5 | Sudo SFTP over exec | todo | | | | Docker |
| R2 | 1.4.0 release sweep | todo | | | | |

### 1.5.0

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| G1 | DB service, vault, history, sqlite files | todo | | | | |
| G2 | Tunnels and TLS | todo | | | | |
| G6 | SQL helper ports | todo | | | | |
| G3 | Postgres wire client: connect, simple query | todo | | | | Docker |
| G4 | Postgres cursors and read-only | todo | | | | |
| G5 | Postgres metadata, pages, edits | todo | | | | |
| G7 | MySQL/MariaDB client core | todo | | | | Docker |
| G8 | MySQL session, meta, edits | todo | | | | |
| G9 | Redis sessions and browsing | todo | | | | |
| G10 | Redis writes, console, pattern ops, pub/sub | todo | | | | |
| G11 | SQLite sessions | todo | | | | |
| G12 | DB result routing and CI services | todo | | | | |
| R3 | 1.5.0 release sweep | todo | | | | |

### 1.6.0

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| H1 | Accounts stores and Claude locks | todo | | | | |
| H2 | Activation, swap journal, recovery | todo | | | | |
| H3 | Reconcile, resync, token refresh | todo | | | | |
| H4 | Login managers | todo | | | | |
| H5 | Usage, auto-switch, limit alerts | todo | | | | |
| H6 | GitHub auth and publish | todo | | | | |
| I1 | State model port 1: normalize | todo | | | | |
| I2 | State model port 2: merge and diff | todo | | | | |
| I3 | Rust becomes the state writer | todo | | | | |
| I4 | MCP HTTP server | todo | | | | |
| I5 | MCP tools, validation, elicitation | todo | | | | |
| I6 | Automation operations | todo | | | | |
| I7 | wait_for, delivery, team prompts | todo | | | | |
| I8 | Remaining core in Rust | todo | | | | |
| I9 | Update coordinator and gate in Rust | todo | | | | |
| I10 | Remove the Node sidecar | todo | | | | |
| R4 | 1.6.0 release sweep | todo | | | | |

## 1.2.0 release gate checklist

See PLAN.md "1.2.0 release gate". Tick here when verified.

- [ ] 1. Spikes S1 to S6 green or fallback re-tested
- [ ] 2. typecheck, npm test, cargo fmt/clippy/test green on Windows and macOS CI
- [ ] 3. Golden corpus no diff, contract test 0 missing, guard scan, no 3.0.0-alpha
- [ ] 4. verify-cli-contract, verify-team-start and all 44 verify scripts green
- [ ] 5. Upgrade test on a 1.1.4 data copy + downgrade check
- [ ] 6. Windows VM transition, macOS harness transition, Tauri -> Tauri update
- [ ] 7. Isolation test (real profile untouched)
- [ ] 8. No-console start and `-e` legacy call
- [ ] 9. Performance vs 1.1.4
- [ ] 10. macOS manual checklist
- [ ] 11. User tested a test build and approved the release note
- [ ] 12. Signing key + GitHub secrets + CI rehearsal assets
- [ ] 13. Published via `npm run publish-release` (dry run first)

## Log

| date | step | result |
|---|---|---|
| 2026-11-06 | Inventory of 12 units, 3 designs, 3 judge reports | Winner by votes: design 3 (staged strangler), with grafts from designs 1 and 2 (Rust pty in 1.2.0, oscrypt read+write, Rust http_fetch, golden corpus, blob protocol, hostd, session-end flush on QUERYENDSESSION) |
| 2026-11-06 | docs/tauri/ARCHITECTURE.md, PLAN.md, INVENTORY.md, PROGRESS.md written | 92 packages, 293 agent-days total; 1.2.0 = 33 packages, 93 agent-days. Waiting for the user decisions below before wave 0 starts. |
| 2026-11-06 | Critic review of the four docs against the source | T0 routing fixed (all existing channels stay on the sidecar), P3b added, A4 +1 day, 4 acceptance cycles removed, CSP / build flavours / gate preload / worker assets / Job breakaway / cross-generation lock / minimize detection added. 1.2.0 = 34 packages, 98 agent-days; total 93 / 298. |

## Do zainstalowania / do decyzji użytkownika

### Decyzje (potrzebne przed startem prac)

1. **Zakres wersji 1.2.0.** Wygrał plan etapowy (2 z 3 sędziów): 1.2.0 = Tauri 2 + terminale (pty) w Rust + logika biznesowa jeszcze w Node (sidecar), a pełne przepisanie na Rust kończy się w 1.6.0 (kolejne wydania 1.3-1.6). Do 1.2.0 to około 93 dni pracy agentów (realnie 7-8 tygodni przy 5-6 agentach równolegle), łącznie około 293. Alternatywa zgodna z dosłowną prośbą "wszystko w Rust w 1.2.0": około 256 dni pracy agentów, 8-10+ tygodni bez żadnego wydania po drodze i większe ryzyko utraty danych. Potwierdź: etapowo czy wszystko naraz?
2. **Wersja 1.2.0 nie wyjdzie "teraz".** Najwcześniej po zielonym przeglądzie zgodności (A18), testach przejścia 1.1.4 -> 1.2.0 i teście na Macu. Wydanie wcześniej grozi utratą zalogowań, haseł lub terminali.
3. **Pasek tytułu na Windows.** Tauri nie ma natywnej nakładki przycisków okna; przyciski minimalizuj/maksymalizuj/zamknij będą rysowane przez aplikację (z zachowaniem układów przyciągania Windows 11). Wygląd lekko się zmieni. Akceptujesz?
4. **macOS: identyfikator com.ajzakomator.app zostaje** (zachowuje uprawnienia systemowe i zgodność z aktualizatorem 1.1.x). Po aktualizacji macOS raz zapyta o dostęp do pęku kluczy ("Zawsze zezwalaj"). Akceptujesz?
5. **Okno aktualizacji Tauri -> Tauri.** Proponowane: instalator NSIS w trybie "passive" (systemowe okno postępu) zamiast obecnego własnego okienka. Pytanie przy starcie ("Zainstaluj teraz / Później") zostaje. Akceptujesz, czy chcesz zachować własne okienko postępu (+2-3 dni pracy)?
6. **Plan awaryjny.** Jeśli testy przejścia (S4/S5) nie wyjdą, potrzebne będzie wydanie pomostowe 1.1.5 na Electronie. Zgoda?
7. **Pliki latest.yml i latest-mac.yml** będą publikowane przy każdym wydaniu na zawsze (dla użytkowników, którzy jeszcze są na Electronie). Zgoda?

### Do zainstalowania na Twoim komputerze (Windows 11 Home)

1. **Visual Studio z narzędziami C++**: już zainstalowane (Visual Studio Community 2026 z komponentem VC Tools x86/x64, sprawdzone vswhere 2026-11-06). Do sprawdzenia tylko, czy jest Windows 11 SDK (w instalatorze VS: "Programowanie aplikacji klasycznych w C++").
2. **Rust** jest już zainstalowany (1.99.1 MSVC). Dodaj na stałe `%USERPROFILE%\.cargo\bin` do zmiennej PATH.
3. **Node.js 24 LTS** (masz 22.19; 24 jest potrzebny do zbudowania sidecara jako pojedynczego pliku SEA).
4. **Tauri CLI** zainstaluję sam jako zależność projektu (`npm i -D @tauri-apps/cli@~2.12.4 @tauri-apps/api@~2.12.4`); nic globalnie. NSIS pobierze się sam przy pierwszym `tauri build`.
5. **WebView2 Runtime** jest zainstalowany (156.0.4314.58, sprawdzone 2026-11-06); nic do robienia.
6. **Docker Desktop** (z WSL2) do testów baz danych i SSH (Postgres, MySQL, MariaDB, Redis, OpenSSH, Dropbear). Agenci usuwają tylko własne kontenery po id.
7. **Maszyna wirtualna Windows** (VirtualBox lub VMware; Windows 11 Home nie ma Windows Sandbox ani Hyper-V) do testu aktualizacji 1.1.4 -> 1.2.0. Nigdy na Twoim prawdziwym profilu.

### Do przygotowania / dostarczenia przez Ciebie

1. **Klucz podpisywania aktualizacji Tauri:** `npx tauri signer generate -w %USERPROFILE%\.tauri\unimux.key` z hasłem, kopia zapasowa offline (utrata klucza = koniec aktualizacji dla wersji Tauri), sekrety GitHub `TAURI_SIGNING_PRIVATE_KEY` i `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Klucz publiczny wpiszę do tauri.conf.json.
2. **Dostęp do Maca** (Apple Silicon, Xcode Command Line Tools, Rust) do testu pęku kluczy (odszyfrowanie zapisanych haseł), testu aktualizatora 1.1.4 -> 1.2.0 i ręcznej listy kontrolnej. CI na macOS tylko buduje.
3. **Kopia testowych danych 1.1.4** (KOPIA, nie oryginał `%APPDATA%\unimux`) albo zgoda, żebym utworzył syntetyczne dane w 1.1.4 pod `MC_DATA_DIR` z testowymi hasłami SSH/DB i tokenem GitHub.
4. **Akceptacja wersji testowej** przed wydaniem i przeczytanie `docs/releases/1.2.0.md`.

## Critic review (2026-11-06)

Changes made in this file:

1. Added row P3b (`--host=ssh` for SSH shell cells, wave 5) and moved A12 to wave 4 (it now depends on A7), matching PLAN.md.
2. "Do zainstalowania": Visual Studio C++ tools and WebView2 Runtime are already on this machine (VS Community 2026 with VC Tools, WebView2 156.0.4314.58), so those items became checks. Node is 22.19.0 (24 still needed). Rust 1.99.1 has only the x86_64-pc-windows-msvc target; no arm64 build is planned, so nothing else to add.
3. Log entry added to the Log table. Full finding list: PLAN.md, ARCHITECTURE.md and INVENTORY.md "Critic review" sections.
