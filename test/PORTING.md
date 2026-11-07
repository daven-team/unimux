# Porting the main-side tests to Rust

Every `it()` / `test()` case of a main-side test file (one that imports src/main, src/ptyhost, src/dbhost, src/sftphost, src/convsearch, src/exechost, src/sshcore or src/updatesplash) gets one row here when its package ports it. `npm run porting:count` prints the baseline and the progress; the 1.2.0 release gate needs every case done (ported, renderer-only or obsolete).

Status values: `ported` (a Rust test checks the same behaviour), `partial` (the Rust test covers part of it; the rest is named in the Rust column), `renderer-only` (the case tests TS that stays in the renderer), `obsolete` (Electron-only machinery that no longer exists in 1.2.0; reason in the Rust column).

Rows keep the exact case name (the counter matches them). Rust tests are named `crate::module::tests::name` or `crate/tests/file.rs::name`.

| file | case | rust test | status |
|---|---|---|---|
| data-dir-migration | uses MC_DATA_DIR as is and touches nothing | unimux-core data_dir::tests::uses_mc_data_dir_as_is_and_touches_nothing | ported |
| data-dir-migration | ignores MC_DATA_DIR in the installed app | unimux-core data_dir::tests::ignores_mc_data_dir_in_the_installed_app; dev_overrides::tests::release_build_ignores_the_environment | ported |
| data-dir-migration | never moves the old directory from a run outside the installed app | unimux-core data_dir::tests::never_moves_from_a_run_outside_the_installed_app | ported |
| data-dir-migration | moves the old directory and leaves a link to the new one at the old path | unimux-core data_dir::tests::moves_and_leaves_a_link | ported |
| data-dir-migration | runs only once: later starts use the new directory through the existing link | unimux-core data_dir::tests::runs_only_once | ported |
| data-dir-migration | uses the new directory on a fresh install and creates no link | unimux-core data_dir::tests::fresh_install_creates_nothing | ported |
| data-dir-migration | moves an empty new directory (no state) aside instead of mixing the two | unimux-core data_dir::tests::moves_an_empty_new_directory_aside | ported |
| data-dir-migration | leaves both directories alone when the new one already holds a state | unimux-core data_dir::tests::leaves_both_alone_when_the_new_one_has_a_state | ported |
| data-dir-migration | keeps using the old directory when the rename fails (locked files) and moves it on a later start | unimux-core data_dir::tests::rename_failure_keeps_the_old_directory_and_a_later_start_migrates | ported |
| data-dir-migration | keeps the old directory when the empty new one cannot be moved aside | unimux-core data_dir::tests::empty_new_directory_that_cannot_be_moved_aside | ported |
| data-dir-migration | keeps the old directory when only the second rename fails; the aside copy stays and the next start migrates | unimux-core data_dir::tests::only_the_second_rename_fails | ported |
| data-dir-migration | uses the new directory when the link cannot be created and creates it on the next start | unimux-core data_dir::tests::link_failure_is_repaired_on_the_next_start | ported |
| data-dir-migration | keeps a link the user made to another place as the data directory | unimux-core data_dir::tests::keeps_a_user_link_as_the_data_directory | ported |
| data-dir-migration | follows another instance that moved the directory first instead of recreating the old one | unimux-core data_dir::tests::follows_another_instance_that_moved_first | ported |
| data-dir-migration | still migrates when the marker cannot be written | unimux-core data_dir::tests::still_migrates_when_the_marker_cannot_be_written | ported |
| data-dir-migration | waits while the update window of the previous version still works in the old directory | unimux-core data_dir::tests::waits_while_an_update_window_works_in_the_old_directory | ported |
| data-dir-migration | never moves anything when the old path is a link or a file | unimux-core data_dir::tests::never_moves_a_link_or_a_file | ported |
| data-dir-migration | never deletes: a failed run leaves every file where it was | unimux-core data_dir::tests::never_deletes_on_failure | ported |
| atomic-write | writes the file and leaves no temp file behind | unimux-core atomic_write::tests::writes_and_replaces | ported |
| atomic-write | retries a rename that hits a Windows file lock, with a growing backoff | unimux-core atomic_write::tests::retries_transient_rename_failures_with_doubling_backoff | ported |
| atomic-write | gives up after the retries and removes its temp file | unimux-core atomic_write::tests::gives_up_and_removes_the_temp_file | ported |
| atomic-write | does not retry errors that are not transient | unimux-core atomic_write::tests::a_permanent_error_is_not_retried | ported |
| atomic-write | flushes the temp file to disk before the rename unless told not to | unimux-core atomic_write (AtomicWriteOptions::fsync); no test observes the sync call yet | partial |
| atomic-write | uses a temp name no other writer shares | unimux-core atomic_write::tests::temp_name_shape; unimux-core/tests/golden.rs::temp_names_match_the_ts_reference | ported |
| atomic-write | knows which error codes are transient | unimux-core atomic_write::is_transient (used by the retry tests); no table test yet | partial |
| startup-timing | records each mark once, in order, rounded to milliseconds | unimux-core startup_timing::tests::first_mark_wins_and_line_format | ported |
| startup-timing | accepts only the fixed renderer marks | unimux-core startup_timing::tests::renderer_marks_are_fixed | ported |
| startup-timing | keeps the last launches only | unimux-core startup_timing::tests::keeps_twenty_lines_and_replaces_own_line | ported |
| startup-timing | rewrites the line of this launch on every flush and never throws | unimux-core startup_timing::tests::keeps_twenty_lines_and_replaces_own_line | ported |
| stability | limits the reports per minute | unimux-core crash_log::tests::limiter | ported |
| stability | accepts only well-formed reports and cuts them | unimux-core crash_log::tests::renderer_reports (+ renderer_reports_cut_in_utf16_units; through the handler: unimux-app commands::app::tests::renderer_reports_reach_crash_log_well_formed_and_at_most_twenty_a_minute) | ported |
| stability | describes anything thrown | unimux-core crash_log::tests::describe_cuts (panics: the panic hook in unimux-app startup.rs, checked by scripts/smoke-tauri.mjs) | partial |
| store | roundtrips state and makes a .bak on load | unimux-state store::tests::a_good_file_loads_unchanged_and_refreshes_the_bak | ported |
| store | falls back to .bak when state.json is corrupted | unimux-state store::tests::a_corrupt_file_is_kept_and_the_bak_is_used | ported |
| store | returns defaults when nothing usable exists | unimux-state store::tests::missing_file_gives_defaults; a_wrong_version_counts_as_corrupt_and_falls_back_to_defaults | ported |
| store | debounced saver writes on flush | unimux-state store::tests::debounces_and_the_newest_state_wins | ported |
| store | persists the language across restarts and uses macOS defaults on first launch | unimux-state normalize::tests::defaults_match_the_ts_code; normalize::tests::the_language_rule_of_existing_installations; unimux-state/tests/golden.rs::a_normalized_state_loads_and_saves_unchanged | ported |
| state-store | keeps an unparsable state.json as a timestamped backup and falls back to .bak | unimux-state store::tests::a_corrupt_file_is_kept_and_the_bak_is_used | ported |
| state-store | starts empty when neither file is usable, still keeping the damaged one | unimux-state store::tests::a_wrong_version_counts_as_corrupt_and_falls_back_to_defaults | ported |
| state-store | writes compact JSON | unimux-state store::tests::writes_state_json_atomically | ported |
| state-store | keeps the pending state when a save fails, retries with a backoff and never throws | unimux-state store::tests::a_failed_save_stays_pending_and_flush_until_saved_retries; retry_delays | ported |
| state-store | is read again for a few seconds, then the start fails without touching it | unimux-state store::tests::an_unreadable_file_stops_the_start_and_nothing_is_overwritten | ported |
| state-store | loads normally when the lock goes away during the wait | unimux-state store::tests::a_briefly_locked_file_is_read_again | ported |
| state-store | removes temp files of writes that never finished, but not the files of this process | unimux-state store::tests::sweeps_temps_of_other_processes_only | ported |
| state-store | tries a failed last save again until it works or the time is up | unimux-state store::tests::a_failed_save_stays_pending_and_flush_until_saved_retries | ported |
| state-store | refreshes .bak from a good state.json and keeps working when that copy fails | unimux-state store::tests::a_good_file_loads_unchanged_and_refreshes_the_bak (the failing-copy half is not tested yet) | partial |
| state-broadcast | sends a burst of agent changes as one patch after the delay, and the window ends with main state | unimux-state broadcast::tests::flush_sends_what_waits_and_the_timer_does_too | ported |
| state-broadcast | a user edit goes out at once and takes the waiting batch with it, in order | unimux-state broadcast::tests::batched_changes_coalesce_and_an_immediate_one_takes_them_along | ported |
| state-broadcast | user operations through the service (no agent) are not batched; flush sends a waiting batch at once | unimux-state broadcast::tests::immediate_changes_go_out_at_once | ported |
| state-patch | round-trips every real state transition: apply(diff(a, b)) equals b | unimux-state/tests/golden.rs::diff_state_matches_the_ts_reference_and_applies (400 generated transitions, byte-identical patches) | ported |
| state-patch | names only what changed: an appended entry, a dropped front, an entry changed in place | unimux-state patch::tests::shapes | ported |
| state-patch | falls back to the full id list for removals in the middle, moves and reappearing ids, and always round-trips | unimux-state patch::tests::shapes; round_trips | ported |
| state-edits | merges edits to different cells and does not resurrect a deleted project | unimux-state edits::tests::does_not_resurrect_a_deleted_entity; unimux-state/tests/golden.rs::merge_state_edit_matches_the_ts_reference | ported |
| state-edits | preserves external collection reordering when the UI only edits a field | unimux-state/tests/golden.rs::merge_state_edit_matches_the_ts_reference (400 generated edits) | ported |
| state-edits | repairs the layout when two independent additions are merged | unimux-state controller::tests::repairs_the_layout_when_two_independent_additions_are_merged; unimux-state/tests/golden.rs::edit_normalization_matches_the_ts_reference | ported |
| state-edits | rejects concurrent additions beyond 20 without altering the canonical state | unimux-state controller::tests::rejects_concurrent_additions_beyond_20_without_altering_the_canonical_state | ported |
| state-edits | normalizes the SFTP places and the scrollback setting of a renderer edit | unimux-state controller::tests::normalizes_the_sftp_places_and_the_scrollback_setting_of_a_renderer_edit; unimux-state/tests/golden.rs::edit_normalization_matches_the_ts_reference | ported |
| ipc-guard | runs the handler for the app window and passes the arguments through | unimux-ipc router::tests::dispatches_with_positional_arguments | ported |
| ipc-guard | answers a foreign sender with the fallback and never runs the handler | unimux-ipc router::tests::the_guard_runs_for_every_guarded_command_and_never_for_open_ones | ported |
| ipc-guard | a fallback may reject like the handler itself would | 1.2.0 answers every refused call with MC_REFUSED (router::tests::the_guard_runs_for_every_guarded_command_and_never_for_open_ones) | obsolete |
| ipc-guard | no channel outside OPEN_IPC_CHANNELS is registered without the sender check | the router applies the guard centrally to every channel not in OPEN_COMMANDS: no registration can skip it (unimux-ipc guard::tests::open_commands_are_reads_only) | obsolete |
| ipc-guard | nothing registers channels around the scan (aliases of ipcMain, an injected ipc outside the modules with own tests) | no ipcMain in 1.2.0; every channel goes through RouterBuilder, checked against the contract (unimux-app commands::tests::every_registration_matches_the_contract) | obsolete |
| ipc-guard | every channel the app changes something through is registered with guardedHandle / guardedOn | central guard in Router::admit (unimux-ipc router::tests::the_guard_runs_for_every_guarded_command_and_never_for_open_ones) | obsolete |
| ipc-guard | only the read-only git channels are open; every other one is guarded | unimux-ipc guard::tests::open_commands_are_reads_only | ported |
| ipc-guard | every channel the main preload uses is registered somewhere in src/main | the contract is generated from mcApi.ts and the router report lists every channel (npm run ipc:report) | obsolete |
| db-wire-sp9.int | Node UTF-8 decoding and toValue | unimux-db/tests/wire_servers.rs::node_utf8_decoding_and_to_value_golden | ported |
| db-wire-sp9.int | values, fields, tags, errors and notices | unimux-db/tests/wire_servers.rs::pg_values_match_node_postgres (SP9 spike client; D4 owns the production one) | ported |
| db-wire-sp9.int | the startup message | unimux-db/tests/wire_servers.rs::pg_startup_and_logins_match_node_postgres | ported |
| db-wire-sp9.int | logins: md5, SCRAM with a SASLprep-sensitive password, a wrong password | unimux-db/tests/wire_servers.rs::pg_startup_and_logins_match_node_postgres | ported |
| db-wire-sp9.int | values, columns, counts, errors | unimux-db/tests/wire_servers.rs::mysql_values_match_mysql2 (SP9 spike client; D7 owns the production one) | ported |
| db-wire-sp9.int | caching_sha2_password: full authentication over plain TCP (RSA key request), then the fast path | unimux-db/tests/wire_servers.rs::mysql_logins_caching_sha2_full_and_fast | ported |
| db-wire-sp9.int | console replies | unimux-db/tests/wire_servers.rs::redis_replies_match_ioredis (SP9 own RESP2 reader; D9 / D10 own the session) | ported |
| db-wire-sp9.int | the connect sequence (default user; ACL user on DB 2) | unimux-db/tests/wire_servers.rs::redis_connect_sequence_matches_ioredis | ported |
| stability | keeps only the newest ones | unimux-platform notify::tests::keeps_only_the_newest_ones (+ the_registry_keeps_fifty_and_forgets_once) | ported |
| taskbar | counts running agent cells: attention without muted ones, working with them; shells and dead cells never | unimux-platform taskbar::tests::counts_running_agent_cells_attention_without_muted_ones_working_with_them_shells_and_dead_cells_never | ported |
| taskbar | a finished turn or an error is not "waiting for you" | unimux-platform taskbar::tests::a_finished_turn_or_an_error_is_not_waiting_for_you | ported |
| taskbar | only the macOS Dock gets a badge (1.1.2: no Windows overlay) | unimux-platform taskbar::tests::only_the_macos_dock_gets_a_badge | ported |
| taskbar | validates reported statuses | unimux-platform taskbar::tests::validates_reported_statuses | ported |
| taskbar | debounces a burst of statuses into one update and calls the OS only for what changed | unimux-platform taskbar::tests::debounces_a_burst_of_statuses_into_one_update_and_calls_the_os_only_for_what_changed | ported |
| taskbar | forgets the statuses of a reloaded window, follows mutes and settings, and reapplies on demand | unimux-platform taskbar::tests::forgets_the_statuses_of_a_reloaded_window_follows_mutes_and_settings_and_reapplies_on_demand | ported |
| taskbar | Windows: never touches the OS | unimux-platform taskbar::tests::windows_never_touches_the_os | ported |
| taskbar | stops after dispose | unimux-platform taskbar::tests::stops_after_dispose | ported |
| startup-gates | a Claude cell waits for the hook/MCP servers and for the account recovery | unimux-app cells::gates::tests::a_claude_cell_waits_for_the_hook_mcp_servers_and_for_the_account_recovery | ported |
| startup-gates | a Codex cell waits for the servers only, never for the account recovery | unimux-app cells::gates::tests::a_codex_cell_waits_for_the_servers_only_never_for_the_account_recovery | ported |
| startup-gates | a plain shell (also an SSH cell) waits for nothing, unless it gets a startup prompt | unimux-app cells::gates::tests::a_plain_shell_also_an_ssh_cell_waits_for_nothing_unless_it_gets_a_startup_prompt | ported |
| alert-sound-file | reads a small whitelisted file and skips bytes for a known key | unimux-platform sound::tests::reads_a_small_whitelisted_file_and_skips_bytes_for_a_known_key | ported |
| alert-sound-file | refuses missing, empty, oversized, wrong-extension files and directories without throwing | unimux-platform sound::tests::refuses_missing_empty_oversized_wrong_extension_files_and_directories_without_throwing | ported |
| alert-sound-file | reads the saved file of the asked event only | unimux-platform sound::tests::reads_the_saved_file_of_the_asked_event_only | ported |
| alert-sound-file | keeps every file check per event: wrong extension, missing, empty, oversized, directory | unimux-platform sound::tests::keeps_every_file_check_per_event | ported |
| alert-sound-file | never accepts a path or an unknown event from the caller | unimux-platform sound::tests::never_accepts_a_path_or_an_unknown_event_from_the_caller | ported |
| alert-sound-file | refuses preset, system and off choices | unimux-platform sound::tests::refuses_preset_system_and_off_choices | ported |
| alert-sound-file | refuses relative, UNC and device paths even when the extension is fine | unimux-platform sound::tests::refuses_relative_unc_and_device_paths_even_when_the_extension_is_fine | ported |
| alert-sound-file | refuses a symbolic link to a sound file | unimux-platform sound::tests::refuses_a_symbolic_link_to_a_sound_file | ported |
| permission-action | labels the buttons on Windows and macOS only, in the order the action index maps | unimux-platform notify::tests::labels_the_buttons_on_windows_and_macos_only_in_the_order_the_action_index_maps | ported |
| permission-action | validates what comes over IPC | unimux-platform notify::tests::validates_what_comes_over_ipc | ported |
| permission-action | answers a hooked Claude permission with a known tool and a Codex approval | permissionAsk stays in the renderer (src/shared/permissionAction.ts) | renderer-only |
| permission-action | refuses everything else: other states, questions, unknown tool, plan approval, shells, unhooked Claude | permissionAsk stays in the renderer | renderer-only |
| permission-action | finds the dialog with the plain Yes highlighted | dialogReady stays in the renderer | renderer-only |
| permission-action | refuses a moved highlight, a broader first option, a missing No and a dialog that scrolled away | dialogReady stays in the renderer | renderer-only |
| permission-action | needs the same token, the same state and the dialog on screen | mayAnswer stays in the renderer | renderer-only |
| permission-action | is Enter / Esc, as win32-input-mode key events in a ConPTY cell | permissionKeys stays in the renderer | renderer-only |
| permission-action | only a single cell needing you gets buttons; Allow / Deny only with a token | noticeActions stays in the renderer | renderer-only |
| detached-windows | keeps valid entries, one per tab, of open grids only, and repairs a grid that moved project | unimux-state detached::tests::keeps_valid_entries_one_per_tab_of_open_grids_only_and_repairs_a_grid_that_moved_project; unimux-state/tests/golden.rs::detached_matches_the_ts_reference | ported |
| detached-windows | survives a save and load, and drops the window of a grid that is gone | unimux-state/tests/detached_state.rs::survives_a_save_and_load_and_drops_the_window_of_a_grid_that_is_gone | ported |
| detached-windows | adds (one window per tab, a limit), moves and removes entries | unimux-state detached::tests::adds_one_window_per_tab_a_limit_moves_and_removes_entries | ported |
| detached-windows | knows which window owns each cell and what moves between two states | unimux-state detached::tests::knows_which_window_owns_each_cell_and_what_moves_between_two_states | ported |
| detached-windows | shows the detached tab as active in its window, and the overlay never travels with an edit | unimux-state/tests/detached_state.rs::the_overlay_of_a_detached_window_never_travels_with_an_edit (viewOverlay itself stays renderer code) | ported |
| detached-windows | a renderer edit can neither add nor remove a detached window (main owns the registry) | unimux-state/tests/detached_state.rs::a_renderer_edit_can_neither_add_nor_remove_a_detached_window | ported |
| detached-windows | clamps into an area and finds the display of a point | unimux-state detached::tests::clamps_into_an_area_and_finds_the_display_of_a_point | ported |
| detached-windows | reopens where it was while its title bar is on a display, else centered on the primary display | unimux-state detached::tests::reopens_where_it_was_while_its_title_bar_is_on_a_display_else_centered_on_the_primary_display | ported |
| detached-windows | a drop puts the title bar under the pointer, clamped to that display | unimux-state detached::tests::a_drop_puts_the_title_bar_under_the_pointer_clamped_to_that_display | ported |
| detached-windows | the menu opens it on the other display, or beside the main window when there is one display | unimux-state detached::tests::the_menu_opens_it_on_the_other_display_or_beside_the_main_window_when_there_is_one_display | ported |
| detached-windows | broadcasts the state, sends a cell's messages to its window and the rest to the main window | unimux-ipc route::tests::broadcasts_the_state_sends_cell_messages_to_their_window_and_the_rest_to_main; route::tests::golden_rows_match_the_ts_reference; events::tests::send_routes_like_send_routed | ported |
| detached-tabs | keeps the new reopen kinds and refuses broken ones | unimux-state/tests/detached_state.rs::keeps_the_new_reopen_kinds_and_refuses_broken_ones | ported |
| detached-tabs | tells documents and handoffs apart and takes only valid sessions of documents that travel | unimux-state detached::tests::tells_documents_and_handoffs_apart_and_takes_only_valid_sessions_of_documents_that_travel | ported |
| detached-tabs | repairs and sums the work reports of detached windows | unimux-state detached::tests::repairs_and_sums_the_work_reports_of_detached_windows | ported |
| detached-tabs | accepts only well-formed tabs to open in the main window | unimux-state detached::tests::accepts_only_well_formed_tabs_to_open_in_the_main_window | ported |
| detached-tabs | sends session and prompt events of databases and SFTP to every window | unimux-ipc route::tests::sends_session_and_prompt_events_of_databases_and_sftp_to_every_window | ported |
| agent-work | does not hold a quit when no agent works | unimux-app lifecycle::quit_confirm::tests::does_not_hold_a_quit_when_no_agent_works | ported |
| agent-work | quits or stays as the user chose | unimux-app lifecycle::quit_confirm::tests::quits_or_stays_as_the_user_chose (real app: scripts/verify-tauri-lifecycle.mjs A) | ported |
| agent-work | a second Close while asking asks again and quits when the renderer stays silent | unimux-app lifecycle::quit_confirm::tests::a_second_close_while_asking_asks_again_and_quits_when_the_renderer_stays_silent | ported |
| agent-work | a repeated Close that is acknowledged keeps waiting for the answer | unimux-app lifecycle::quit_confirm::tests::a_repeated_close_that_is_acknowledged_keeps_waiting_for_the_answer | ported |
| agent-work | an acknowledged question holds the quit at most two minutes | unimux-app lifecycle::quit_confirm::tests::an_acknowledged_question_holds_the_quit_at_most_two_minutes | ported |
| agent-work | a session end releases a held quit at once | unimux-app lifecycle::quit_confirm::tests::a_session_end_releases_a_held_quit_at_once (real app: verify-tauri-lifecycle.mjs B) | ported |
| agent-work | treats a session end as exempt for about a minute only | unimux-app lifecycle::quit_confirm::tests::treats_a_session_end_as_exempt_for_about_a_minute_only | ported |
| agent-work | never holds a session end or update and does not wait for a silent renderer | unimux-app lifecycle::quit_confirm::tests::never_holds_a_session_end_or_update_and_does_not_wait_for_a_silent_renderer | ported |
| quit-wait | never waits (and sets no timer) when nothing runs | unimux-app lifecycle::wind_down::tests::never_waits_and_sets_no_timer_when_nothing_runs | ported |
| quit-wait | resolves true as soon as the work ends, and clears its timer | unimux-app lifecycle::wind_down::tests::resolves_true_as_soon_as_the_work_ends | ported |
| quit-wait | resolves false once the bound runs out while the work still runs | unimux-app lifecycle::wind_down::tests::resolves_false_once_the_bound_runs_out_while_the_work_still_runs | ported |
| quit-wait | the bounds (5 s, then 3 s after the cells) stay well inside the hard shutdown limit | unimux-app lifecycle::wind_down::tests::the_bounds_stay_well_inside_the_hard_shutdown_limit | ported |
| quit-wait | a release followed at once by a new claim keeps the quit waiting (within the bound) | unimux-app lifecycle::wind_down::tests::a_release_followed_at_once_by_a_new_claim_keeps_waiting_within_the_bound (the swap slot itself is A2) | partial |
| safe-window | leaves the wind-down a bounded time | unimux-app lifecycle::wind_down::tests::the_bounds_stay_well_inside_the_hard_shutdown_limit | ported |
| git-paths | treats the short and the long spelling, other letter case and slashes as one folder | unimux-git paths::tests::treats_the_short_and_the_long_spelling_other_letter_case_and_slashes_as_one_folder | ported |
| git-paths | decides "inside the project" on canonical paths | unimux-git paths::tests::decides_inside_the_project_on_canonical_paths | ported |
| git-paths | keeps the real case of the part below the parent | unimux-git paths::tests::keeps_the_real_case_of_the_part_below_the_parent | ported |
| git-paths | is case sensitive and link aware off Windows, and falls back to the lexical path | unimux-git paths::tests::is_case_sensitive_and_link_aware_off_windows_and_falls_back_to_the_lexical_path | ported |
| git-paths | resolves a link and the lexical fallback of a missing folder | unimux-git/tests/canonical_paths.rs::canonical_paths_of_real_folders_match_the_ts_reference (junction, 8.3 names, subst drive, missing children, all compared with gitPaths.ts live) | ported |
| git-ops | reports a missing git with an install hint | unimux-git/tests/runner.rs::reports_a_missing_git_with_an_install_hint (root and probe; the status call is G3) | partial |
| git-ops | stops a slow git at the timeout | unimux-git/tests/runner.rs::stops_a_slow_git_at_the_timeout_and_releases_the_lock_it_left (read and network timeouts at the runner; status / fetch are G3) | partial |
| git-ops | never prints credentials of a remote URL | unimux-git/tests/runner.rs::never_prints_credentials_and_does_not_wait_for_a_prompt (git fetch through the runner; Git.fetch is G3) | partial |
| git-ops | does not wait for a credential prompt | unimux-git/tests/runner.rs::never_prints_credentials_and_does_not_wait_for_a_prompt (git fetch through the runner; Git.fetch is G3) | partial |
| git-ops | caps the number of listed changes | unimux-git/tests/runner.rs::caps_the_output_of_reads_and_writes (the read cap; the status parser and GIT_MAX_FILES are G2 / G3) | partial |
| git-ops | marks binary files and caps huge diffs | unimux-git/tests/runner.rs::caps_the_output_of_reads_and_writes (the 1 MiB diff cap; diff and the binary mark are G3) | partial |
| git-ops | works from a subfolder and from a non-repository | unimux-git/tests/runner.rs::finds_the_root_from_a_subfolder_and_tells_folders_without_a_repository (root and probe; the status call is G3) | partial |
| git-trust | lists what can start a program, without starting any of it | unimux-git/tests/trust.rs::lists_what_can_start_a_program_without_starting_any_of_it | ported |
| git-trust | cannot be trusted by a flag on an ordinary call, only by the dedicated request | unimux-git/tests/trust.rs::cannot_be_trusted_by_a_flag_on_an_ordinary_call_only_by_the_dedicated_request (trust / trustGrant through handle_git; the status and commit refusals are G3's channels) | partial |
| git-trust | asks again when the configuration or a hook changes, and remembers the answer across restarts | unimux-git/tests/trust.rs::asks_again_when_the_configuration_or_a_hook_changes_and_remembers_the_answer_across_restarts (the status refusal is checked as require_trust, which G3's status calls) | partial |
| git-trust | treats a repository without risky configuration as safe | unimux-git/tests/trust.rs::treats_a_repository_without_risky_configuration_as_safe (trust info and require_trust; the status call is G3) | partial |
| git-trust | picks up a hostile .gitattributes that names a driver defined outside the repository | unimux-git/tests/trust.rs::picks_up_a_hostile_gitattributes_that_names_a_driver_defined_outside_the_repository | ported |
| git-trust | refuses writes in a repository that is larger than the project and says so | unimux-git/tests/trust.rs::refuses_writes_in_a_repository_that_is_larger_than_the_project_and_says_so (the trust `parent` flag; status and the refused writes are G3) | partial |
| git-trust | shape of an error for an untrusted repository carries a message the panel can translate | unimux-git/tests/trust.rs::shape_of_an_error_for_an_untrusted_repository_carries_a_message_the_panel_can_translate (the require_trust failure on the wire; the status channel is G3) | partial |
| files | lists folders first and sorts file names naturally | unimux-files/tests/files.rs::lists_folders_first_and_sorts_file_names_naturally; unimux-files/tests/golden.rs::name_order_matches_v8_intl_collator; unimux-files/tests/files.rs::the_listing_stops_at_2000_entries | ported |
| files | reads text without altering the file | unimux-files/tests/files.rs::reads_text_without_altering_the_file | ported |
| files | blocks traversal and absolute paths | unimux-files/tests/files.rs::blocks_traversal_and_absolute_paths; unimux-files/tests/golden.rs::path_checks_match_node | ported |
| files | blocks directory junctions leading outside the project | unimux-files/tests/files.rs::blocks_directory_junctions_leading_outside_the_project | ported |
| files | limits large previews and handles a UTF-8 character cut at the limit | unimux-files/tests/files.rs::limits_large_previews_and_handles_a_utf8_character_cut_at_the_limit; unimux-files/tests/golden.rs::previews_match_the_ts_reference | ported |
| files | supports UTF-16 Windows text files and distinguishes binary content | unimux-files/tests/files.rs::supports_utf16_windows_text_files_and_distinguishes_binary_content; unimux-files/tests/golden.rs::previews_match_the_ts_reference | ported |
| files | returns useful errors for missing files and prevents previewing directories | unimux-files/tests/files.rs::returns_useful_errors_for_missing_files_and_prevents_previewing_directories | ported |
| files | lists many folders in one call, each like a single listing | unimux-files/tests/files.rs::lists_many_folders_in_one_call_each_like_a_single_listing | ported |
| files | ignores malformed input and caps the number of folders | unimux-files/tests/files.rs::ignores_malformed_input_and_caps_the_number_of_folders | ported |
| files | walks every folder breadth first in natural order (read level by level in parallel) | unimux-files/tests/files.rs::walks_every_folder_breadth_first_in_natural_order | ported |
| files | preserves encoding, BOM and CRLF for %s | unimux-files/tests/files.rs::preserves_encoding_bom_and_crlf (utf8, utf8-bom, utf16le, utf16be); unimux-files/tests/golden.rs::saves_match_the_ts_reference | ported |
| files | preserves mixed line endings and empty files | unimux-files/tests/files.rs::preserves_mixed_line_endings_and_empty_files | ported |
| files | rejects an external edit without changing bytes or leaving temporary files | unimux-files/tests/files.rs::rejects_an_external_edit_without_changing_bytes_or_leaving_temporary_files | ported |
| files | other save failures carry no conflict code | unimux-files/tests/files.rs::other_save_failures_carry_no_conflict_code | ported |
| files | serializes concurrent saves to the same baseline | unimux-files/tests/files.rs::serializes_concurrent_saves_to_the_same_baseline | ported |
| files | rejects binary, truncated, oversized output and invalid text without damage | unimux-files/tests/files.rs::rejects_binary_truncated_oversized_output_and_invalid_text_without_damage (a lone surrogate in the new text: test/tauri-bridge.test.ts, the bridge refuses it before Rust) | ported |
| files | rejects missing files, directories, traversal, absolute paths and external junctions | unimux-files/tests/files.rs::rejects_missing_files_directories_traversal_absolute_paths_and_external_junctions | ported |
| editor-source | reads, stats and saves like a project file (refuses when the file changed, keeps line endings) | unimux-files/tests/files.rs::local_reads_stats_and_saves_like_a_project_file | ported |
| editor-source | refuses relative paths and non-strings | unimux-files/tests/files.rs::local_refuses_relative_paths_and_non_strings | ported |
| editor-source | writes only a file this window read first; a reload forgets them (a restored draft reads again) | unimux-files/tests/files.rs::local_writes_only_a_file_read_first_and_a_reload_forgets; unimux-files/tests/files.rs::local_opened_set_keeps_the_last_500; unimux-app commands::files::tests::local_files_are_forgotten_when_the_main_page_reloads | ported |
| editor-source | never reads or writes the app data dir or the install dir, nor UNC and device paths | unimux-files/tests/files.rs::local_never_touches_the_app_folders_nor_unc_and_device_paths; unimux-app commands::files::tests::forbidden_roots_cover_the_app_folders | ported |
| editor-source | a local file that is gone has its own text, not "cannot be edited here" | unimux-files/tests/files.rs::local_a_file_that_is_gone_has_its_own_text | ported |
| file-ops | renames a file and a folder | unimux-files/tests/fileops.rs::renames_a_file_and_a_folder; unimux-files/tests/fileops_golden.rs::operations_match_the_ts_reference | ported |
| file-ops | refuses to overwrite and keeps both files | unimux-files/tests/fileops.rs::refuses_to_overwrite_and_keeps_both_files | ported |
| file-ops | rejects invalid, reserved and path-like names | unimux-files/tests/fileops.rs::rejects_invalid_reserved_and_path_like_names; unimux-files/tests/fileops_golden.rs::helpers_match_the_ts_reference | ported |
| file-ops | refuses the project root, traversal and absolute paths | unimux-files/tests/fileops.rs::refuses_the_project_root_traversal_and_absolute_paths | ported |
| file-ops | refuses entries reached through a junction that leaves the project | unimux-files/tests/fileops.rs::refuses_entries_reached_through_a_junction_that_leaves_the_project | ported |
| file-ops | can rename the link itself (the link is inside the project) | unimux-files/tests/fileops.rs::can_rename_the_link_itself | ported |
| file-ops | renames case-only, also when the filesystem is case-insensitive | unimux-files/tests/fileops.rs::renames_case_only_also_when_the_filesystem_is_case_insensitive | ported |
| file-ops | renaming to the same name is a no-op | unimux-files/tests/fileops.rs::renaming_to_the_same_name_is_a_no_op | ported |
| file-ops | creates files and folders without overwriting | unimux-files/tests/fileops.rs::creates_files_and_folders_without_overwriting | ported |
| file-ops | moves a file and a folder with content into another folder | unimux-files/tests/fileops.rs::moves_a_file_and_a_folder_with_content_into_another_folder | ported |
| file-ops | moves to the project root | unimux-files/tests/fileops.rs::moves_to_the_project_root | ported |
| file-ops | reports conflicts first and changes nothing | unimux-files/tests/fileops.rs::reports_conflicts_first_and_changes_nothing | ported |
| file-ops | replace sends the old item to the trash, never deleting it | unimux-files/tests/fileops.rs::replace_sends_the_old_item_to_the_trash_never_deleting_it | ported |
| file-ops | keep both numbers the moved item | unimux-files/tests/fileops.rs::keep_both_numbers_the_moved_item | ported |
| file-ops | skip leaves the conflicting item where it was | unimux-files/tests/fileops.rs::skip_leaves_the_conflicting_item_where_it_was | ported |
| file-ops | refuses to move a folder into itself or a descendant | unimux-files/tests/fileops.rs::refuses_to_move_a_folder_into_itself_or_a_descendant | ported |
| file-ops | refuses a replace that would trash the source itself | unimux-files/tests/fileops.rs::refuses_a_replace_that_would_trash_the_source_itself | ported |
| file-ops | moving into the folder it is already in is a no-op | unimux-files/tests/fileops.rs::moving_into_the_folder_it_is_already_in_is_a_no_op | ported |
| file-ops | refuses a destination that is not a folder or does not exist | unimux-files/tests/fileops.rs::refuses_a_destination_that_is_not_a_folder_or_does_not_exist | ported |
| file-ops | drops entries that are inside another selected folder | unimux-files/tests/fileops.rs::drops_entries_that_are_inside_another_selected_folder | ported |
| file-ops | refuses a missing source | unimux-files/tests/fileops.rs::refuses_a_missing_source | ported |
| file-ops | copies a file and a whole tree and keeps modification times | unimux-files/tests/fileops.rs::copies_a_file_and_a_whole_tree_and_keeps_modification_times | ported |
| file-ops | pasting into the same folder duplicates as "copy", "copy 2" | unimux-files/tests/fileops.rs::pasting_into_the_same_folder_duplicates_as_copy_copy_2 | ported |
| file-ops | asks about conflicts, then replaces (old item to the trash) or keeps both | unimux-files/tests/fileops.rs::asks_about_conflicts_then_replaces_or_keeps_both | ported |
| file-ops | does not follow symlinks: they are copied as links or skipped | unimux-files/tests/fileops.rs::does_not_follow_symlinks_they_are_copied_as_links_or_skipped | ported |
| file-ops | asks for confirmation above the size/entry limits and goes on once forced | unimux-files/tests/fileops.rs::asks_for_confirmation_above_the_size_entry_limits_and_goes_on_once_forced | ported |
| file-ops | can be cancelled and leaves no partial copy | unimux-files/tests/fileops.rs::can_be_cancelled_and_leaves_no_partial_copy; unimux-files/tests/fileops.rs::a_cancel_in_the_middle_removes_the_partial_copy | ported |
| file-ops | reports progress | unimux-files/tests/fileops.rs::reports_progress | ported |
| file-ops | sends files and folders to the trash and never removes them itself | unimux-files/tests/fileops.rs::sends_files_and_folders_to_the_trash_and_never_removes_them_itself | ported |
| file-ops | collapses nested selections and reports failures per item | unimux-files/tests/fileops.rs::collapses_nested_selections_and_reports_failures_per_item | ported |
| file-ops | refuses the project root, outside paths and empty selections | unimux-files/tests/fileops.rs::refuses_the_project_root_outside_paths_and_empty_selections | ported |
| file-ops | two sources with the same name: Replace gives the second a free name and trashes nothing | unimux-files/tests/fileops.rs::two_sources_with_the_same_name_replace_gives_the_second_a_free_name | ported |
| file-ops | an existing target is still replaced once (and reported), the duplicate keeps both | unimux-files/tests/fileops.rs::an_existing_target_is_still_replaced_once_the_duplicate_keeps_both | ported |
| file-ops | Skip skips the duplicate and copies behave the same | unimux-files/tests/fileops.rs::skip_skips_the_duplicate_and_copies_behave_the_same | ported |
| file-ops | rejects unknown conflict policies instead of replacing | unimux-files/tests/fileops.rs::rejects_unknown_conflict_policies_instead_of_replacing | ported |
| file-ops | rejects non-string, oversized and too many paths | unimux-files/tests/fileops.rs::rejects_non_string_oversized_and_too_many_paths | ported |
| file-ops | handles a large selection quickly (linear de-duplication) | unimux-files/tests/fileops.rs::handles_a_large_selection_quickly | ported |
| file-ops | copies and then removes the source when everything could be copied | unimux-files/tests/fileops.rs::exdev_copies_and_then_removes_the_source | ported |
| file-ops | keeps the source and leaves no partial copy when a link could not be copied | unimux-files/tests/fileops.rs::exdev_keeps_the_source_when_a_link_could_not_be_copied | ported |
| sftp-main | lists any folder with size, time and kind; makes, renames (never over a file) and trashes | unimux-files/tests/pane.rs::lists_any_folder_with_size_time_and_kind_makes_renames_and_trashes; unimux-files/tests/fileops_golden.rs::local_pane_matches_the_ts_reference; unimux-app commands::files::tests::the_local_pane_channels_answer_like_1_1_4 | ported |
| sftp-main | reveals a macOS bundle (Foo.app) selected in Finder instead of opening it, and opens plain folders | unimux-files/tests/pane.rs::reveals_a_macos_bundle_selected_in_finder_and_opens_plain_folders | ported |
| search | escapes literal queries and ignores case unless asked | unimux-files/tests/search.rs::escapes_literal_queries_and_ignores_case_unless_asked | ported |
| search | matches whole words, including letters outside ASCII | unimux-files/tests/search.rs::matches_whole_words_including_letters_outside_ascii | ported |
| search | supports regular expressions and reports invalid ones | unimux-files/tests/search.rs::supports_regular_expressions_and_reports_invalid_ones; unimux-files/tests/search_golden.rs::patterns_match_v8; unimux-files/tests/search_golden.rs::random_patterns_compile_and_match_like_v8 | ported |
| search | reports line and column of every match and a shortened preview | unimux-files/tests/search.rs::reports_line_and_column_of_every_match_and_a_shortened_preview | ported |
| search | skips empty matches and giant lines, and stops at the limit | unimux-files/tests/search.rs::skips_empty_matches_and_giant_lines_and_stops_at_the_limit | ported |
| search | replaces literally unless the search is a regular expression | unimux-files/tests/search.rs::replaces_literally_unless_the_search_is_a_regular_expression | ported |
| search | replaces one occurrence and keeps every kind of line ending | unimux-files/tests/search.rs::replaces_one_occurrence_and_keeps_every_kind_of_line_ending | ported |
| search | expands replacement tokens like String.replace | unimux-files/tests/search.rs::expands_replacement_tokens_like_string_replace | ported |
| search | compiles file globs | unimux-files/tests/search.rs::compiles_file_globs; unimux-files/tests/search_golden.rs::globs_match_the_ts_reference | ported |
| search | finds matches across the project and skips dependencies, git data and binary files | unimux-files/tests/search.rs::finds_matches_across_the_project_and_skips_dependencies_git_data_and_binary_files | ported |
| search | honours case, whole word, include and exclude filters | unimux-files/tests/search.rs::honours_case_whole_word_include_and_exclude_filters; unimux-files/tests/search_golden.rs::project_searches_match_the_ts_reference | ported |
| search | reports a bad regular expression, accepts an empty query and skips large files | unimux-files/tests/search.rs::reports_a_bad_regular_expression_accepts_an_empty_query_and_skips_large_files | ported |
| search | stops when the match limit or the time budget is reached | unimux-files/tests/search.rs::stops_when_the_match_limit_or_the_time_budget_is_reached | ported |
| search | stops a search that a newer one replaced and still finds everything when reading files in parallel | unimux-files/tests/search.rs::stops_a_search_that_a_newer_one_replaced_and_still_finds_everything_when_reading_files_in_parallel | ported |
| search | replaces in every matching file and keeps line endings | unimux-files/tests/search.rs::replaces_in_every_matching_file_and_keeps_line_endings; unimux-files/tests/search_golden.rs::project_replaces_match_the_ts_reference | ported |
| search | replaces only one file or one occurrence when asked | unimux-files/tests/search.rs::replaces_only_one_file_or_one_occurrence_when_asked | ported |
| search | refuses a single replacement when the file changed since the search | unimux-files/tests/search.rs::refuses_a_single_replacement_when_the_file_changed_since_the_search | ported |
| search | keeps a byte order mark and expands regular-expression groups | unimux-files/tests/search.rs::keeps_a_byte_order_mark_and_expands_regular_expression_groups | ported |
| search | reports files that cannot be replaced and rejects invalid requests | unimux-files/tests/search.rs::reports_files_that_cannot_be_replaced_and_rejects_invalid_requests | ported |
| search | lists folders breadth first without dependency folders and honours the limit | unimux-files/tests/search.rs::lists_folders_breadth_first_without_dependency_folders_and_honours_the_limit | ported |
| main-misc | emits hook events for valid token and rejects others | unimux-agents/tests/hook_server.rs::emits_hook_events_for_a_valid_token_and_rejects_others | ported |
| main-misc | reports idle_prompt as its own (quiet) idle event, permission prompts as notify | unimux-agents/tests/hook_server.rs::reports_idle_prompt_as_its_own_event_and_permission_prompts_as_notify | ported |
| main-misc | rejects malformed ids and oversized bodies without crashing, and sends bodies only for notify | unimux-agents/tests/hook_server.rs::rejects_malformed_ids_and_oversized_bodies_without_crashing (the settings half, --data-binary only for notify, is H2) | partial |
| session-hook | emits a session event, never a status event, and rejects bad requests | unimux-agents/tests/hook_server.rs::session_start_emits_a_session_event_never_a_status_event_and_rejects_bad_requests | ported |
| session-hook | parses payloads strictly | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (parseSessionStart over test/golden/hook-payloads.jsonl) | ported |
| session-hook | stores the followed conversation as confirmed | unimux-agents hooks::route::tests::followed_session_is_confirmed | ported |
| session-hook | updates a live Claude cell whose conversation changed | unimux-agents hooks::route::tests::should_update_cell_session_ports_the_ts_cases; hooks::route::tests::a_session_switch_is_followed_only_for_a_live_claude_cell | ported |
| session-hook | ignores unknown, non-claude, not alive, unchanged and invalid ids | unimux-agents hooks::route::tests::should_update_cell_session_ports_the_ts_cases | ported |
| session-hook | ignores stale or missing nonces for every event and accepts the current one after a restart | unimux-agents/tests/hook_server.rs::ignores_stale_or_missing_nonces_for_every_event_and_accepts_the_current_one_after_a_restart | ported |
| codex-hooks | reads the thread and turn of a completed turn and nothing else | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (parseCodexNotify) | ported |
| codex-hooks | drops malformed ids but still reports the turn end | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (parseCodexNotify) | ported |
| codex-hooks | rejects anything that is not a completed-turn object | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (parseCodexNotify) | ported |
| codex-hooks | survives hostile and huge payloads | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (parseCodexNotify, nesting 200 and 5,000 deep) | ported |
| codex-hooks | emits a notice per valid request of the current process and drops every other one | unimux-agents/tests/hook_server.rs::codex_emits_a_notice_per_valid_request_of_the_current_process_and_drops_every_other_one | ported |
| codex-hooks | accepts a large payload and counts an oversized one as a turn end without ids | unimux-agents/tests/hook_server.rs::codex_accepts_a_large_payload_and_counts_an_oversized_one_as_a_turn_end_without_ids | ported |
| background-stop | handles the payload shapes | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (hasActiveBackgroundWork) | ported |
| background-stop | emits stopbg or stop, rejects oversized and wrong-token requests | unimux-agents/tests/hook_server.rs::emits_stopbg_or_stop_and_rejects_oversized_and_wrong_token_requests | ported |
| background-stop | ignores subagent payloads and accepts fork | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (parseSessionStart) | ported |
| background-stop | writes only keys, types and statuses, and is silent when disabled | unimux-agents/tests/hook_server.rs::the_debug_log_writes_only_keys_types_and_statuses_and_restarts_past_256_kib; hook_server.rs::mc_hook_debug_logs_payload_shapes_to_hook_debug_log | ported |
| background-stop | holds the cell for running workflows and counts them | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (stopInfo, hasActiveBackgroundWork) | ported |
| background-stop | a running shell plus a running workflow holds; a shell alone does not (dev server regression) | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (hasActiveBackgroundWork) | ported |
| background-stop | marks a payload without a task list as unknown, not as "nothing runs" | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (stopInfo) | ported |
| background-stop | the debug line tells whether a task is named and whether the stop hook was active, never the name | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (stopDebugLine) | ported |
| background-stop | the hook server emits stopbg for a workflow and stop when the task list is absent | unimux-agents/tests/hook_server.rs::emits_stopbg_for_a_workflow_and_stop_when_the_task_list_is_absent | ported |
| status-continuation | stopInfo reads stop_hook_active | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (stopInfo) | ported |
| status-continuation | only agent-like or unknown task types hold it | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (hasActiveBackgroundWork) | ported |
| status-continuation | stopInfo counts only the holding tasks as active and lists the types | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (stopInfo) | ported |
| status-continuation | the hook server emits a plain stop for a dev server task and stopbg for an agent task | unimux-agents/tests/hook_goldens.rs::the_server_answers_and_emits_like_the_ts_reference (rows "stop with shell work only", "stop with background work") | ported |
| status-continuation | has its own URL event and arrives as a subagent busy hook | unimux-agents/tests/hook_goldens.rs::the_server_answers_and_emits_like_the_ts_reference (subagent rows; the settings half is H2) | partial |
| status-reliability | the hook server parses StopFailure, caps its body and still counts an oversized one | unimux-agents/tests/hook_goldens.rs::the_server_answers_and_emits_like_the_ts_reference (fail rows); hook_server.rs::acceptance_large_bodies_stale_nonces_and_bad_tokens | ported |
| status-reliability | parseFailure only reports documented codes | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (parseFailure) | ported |
| status-reliability | stopInfo reports counts and distinct status strings only | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (stopInfo) | ported |
| status-reliability | the hook server emits Stop info and a sessionstart event that is never a status hook | unimux-agents/tests/hook_goldens.rs::the_server_answers_and_emits_like_the_ts_reference; hook_server.rs::session_start_emits_a_session_event_never_a_status_event_and_rejects_bad_requests | ported |
| status-reliability | records StopFailure and SessionStart with codes and keys only | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (hookDebugLine); hook_server.rs::mc_hook_debug_logs_payload_shapes_to_hook_debug_log | ported |
| status-hooks-shell | maps each documented type to what it means for the status | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (notificationEvent) | ported |
| status-hooks-shell | reads the tool name and id of a whole payload, never its input | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (toolHookFacts) | ported |
| status-hooks-shell | a huge PostToolUse: the id is read from the tail, and an id inside the tool output (escaped) is never taken | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (toolHookFacts head + tail) | ported |
| status-hooks-shell | AskUserQuestion is a question the moment it starts; PermissionRequest, Elicitation and compaction map to their events | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (toolHookEvent) | ported |
| status-hooks-shell | the server reads a 1 MB tool payload to the end, answers it and emits the tool facts | unimux-agents/tests/hook_goldens.rs::the_server_answers_and_emits_like_the_ts_reference (rows "pre with 2 MB of input", "post with a large output keeps the head and the tail") | ported |
| context-usage | takes the transcript path of the main conversation only | unimux-agents/tests/hook_goldens.rs::payload_helpers_answer_like_the_ts_reference (transcriptOf) | ported |
| cli-detect | finds a CLI in a known install directory that is not on the app PATH and verifies its version | unimux-agents cli::detector::tests::finds_a_cli_in_a_known_install_directory_that_is_not_on_the_app_path_and_verifies_its_version | ported |
| cli-detect | finds a CLI through the PATH walk | unimux-agents cli::detector::tests::finds_a_cli_through_the_path_walk | ported |
| cli-detect | finds the newest nvm version and an npm prefix from ~/.npmrc | unimux-agents cli::detector::tests::finds_the_newest_nvm_version_and_an_npm_prefix_from_npmrc | ported |
| cli-detect | finds a CLI only through the login-shell probe (custom install dir) and runs the probe once for both CLIs | unimux-agents cli::detector::tests::finds_a_cli_only_through_the_login_shell_probe_and_runs_the_probe_once_for_both_clis | ported |
| cli-detect | reports "missing" only when every place was searched | unimux-agents cli::detector::tests::reports_missing_only_when_every_place_was_searched | ported |
| cli-detect | never reports "missing" when the login shell resolves the name to an alias or function | unimux-agents cli::detector::tests::never_reports_missing_when_the_login_shell_resolves_the_name_to_an_alias_or_function | ported |
| cli-detect | probes with the shell the cells run (settings.shell), not $SHELL | unimux-agents cli::detector::tests::probes_with_the_shell_the_cells_run_not_shell | ported |
| cli-detect | fails open (unknown) when the login shell probe times out or the shell is unsupported | unimux-agents cli::detector::tests::fails_open_unknown_when_the_login_shell_probe_times_out_or_the_shell_is_unsupported | ported |
| cli-detect | treats a binary whose version check fails or times out as found but unverified | unimux-agents cli::detector::tests::treats_a_binary_whose_version_check_fails_or_times_out_as_found_but_unverified | ported |
| cli-detect | never exposes anything but the parsed version of the output | unimux-agents cli::detector::tests::never_exposes_anything_but_the_parsed_version_of_the_output | ported |
| cli-detect | finds claude.exe in the documented %USERPROFILE%\.local\bin and asks it through cmd.exe | unimux-agents cli::detector::tests::finds_claude_exe_in_the_documented_local_bin_and_asks_it_through_cmd_exe | ported |
| cli-detect | runs an .exe directly when its path cannot be quoted for cmd.exe | unimux-agents cli::detector::tests::runs_an_exe_directly_when_its_path_cannot_be_quoted_for_cmd_exe | ported |
| cli-detect | runs an npm .cmd shim through cmd.exe with a safely quoted command line | unimux-agents cli::detector::tests::runs_an_npm_cmd_shim_through_cmd_exe_with_a_safely_quoted_command_line | ported |
| cli-detect | quotes a shim path so that `&` in a folder name works, and refuses what cannot be quoted | unimux-agents cli::detector::tests::quotes_a_shim_path_so_that_ampersand_in_a_folder_name_works_and_refuses_what_cannot_be_quoted | ported |
| cli-detect | picks up a directory only the registry PATH has (installer ran after the app started) | unimux-agents cli::detector::tests::picks_up_a_directory_only_the_registry_path_has | ported |
| cli-detect | reports "missing" with a readable registry and "unknown" when the registry cannot be read | unimux-agents cli::detector::tests::reports_missing_with_a_readable_registry_and_unknown_when_the_registry_cannot_be_read | ported |
| cli-detect | refreshes the cell PATH from the registry without reordering it and keeps the Path key | unimux-agents cli::detector::tests::refreshes_the_cell_path_from_the_registry_without_reordering_it_and_keeps_the_path_key | ported |
| cli-detect | does not touch a PATH that already has everything | unimux-agents cli::detector::tests::does_not_touch_a_path_that_already_has_everything | ported |
| cli-detect | finds an Application the profile put on the PATH and verifies it | unimux-agents cli::detector::tests::finds_an_application_the_profile_put_on_the_path_and_verifies_it | ported |
| cli-detect | treats an alias, function or script as unknown, never as missing (no lock-out) | unimux-agents cli::detector::tests::treats_an_alias_function_or_script_as_unknown_never_as_missing | ported |
| cli-detect | is missing only when the shell itself ran and knows nothing | unimux-agents cli::detector::tests::is_missing_only_when_the_shell_itself_ran_and_knows_nothing | ported |
| cli-detect | runs one probe for both CLIs, and none when the binary is found on the PATH | unimux-agents cli::detector::tests::runs_one_probe_for_both_clis_and_none_when_the_binary_is_found_on_the_path | ported |
| cli-detect | uses pwsh for the pwsh shell (falling back to Windows PowerShell) and skips the probe for cmd | unimux-agents cli::detector::tests::uses_pwsh_for_the_pwsh_shell_falling_back_to_windows_powershell_and_skips_the_probe_for_cmd | ported |
| cli-detect | dot-sources the test profile instead of the real one when asked (unpackaged hook) | unimux-agents cli::detector::tests::dot_sources_the_test_profile_instead_of_the_real_one_when_asked | ported |
| cli-detect | prepends the detected directory only when the PATH lacks it, and leaves shell cells alone | unimux-agents cli::detector::tests::prepends_the_detected_directory_only_when_the_path_lacks_it_and_leaves_shell_cells_alone | ported |
| cli-detect | shares one detection between concurrent callers | unimux-agents cli::detector::tests::shares_one_detection_between_concurrent_callers | ported |
| cli-detect | keeps "found" for 10 minutes, then serves the stale value while re-verifying in the background | unimux-agents cli::detector::tests::keeps_found_for_10_minutes_then_serves_the_stale_value_while_re_verifying_in_the_background | ported |
| cli-detect | keeps "missing" for 30 seconds and then looks again (the user may have installed it) | unimux-agents cli::detector::tests::keeps_missing_for_30_seconds_and_then_looks_again | ported |
| cli-detect | invalidate / recheck forget the cache and the login-shell snapshot | unimux-agents cli::detector::tests::invalidate_recheck_forget_the_cache_and_the_login_shell_snapshot | ported |
| cli-detect | does not let an older, slower detection overwrite a newer recheck | unimux-agents cli::detector::tests::does_not_let_an_older_slower_detection_overwrite_a_newer_recheck | ported |
| cli-detect | returns unknown instead of blocking when a detection is slower than the caller is willing to wait | unimux-agents cli::detector::tests::returns_unknown_instead_of_blocking_when_a_detection_is_slower_than_the_caller_is_willing_to_wait | ported |
| cli-detect | notifies listeners about changes only | unimux-agents cli::detector::tests::notifies_listeners_about_changes_only | ported |
| cli-ipc | answers the status from the detector snapshot | unimux-agents cli::ipc::tests::answers_the_status_from_the_detector_snapshot | ported |
| cli-ipc | validates the CLI id of a recheck | unimux-agents cli::ipc::tests::validates_the_cli_id_of_a_recheck | ported |
| cli-ipc | shares a running recheck between repeated requests | unimux-agents cli::ipc::tests::shares_a_running_recheck_between_repeated_requests | ported |
| cli-ipc | opens only allow-listed documentation, never an address from the renderer | unimux-agents cli::ipc::tests::opens_only_allow_listed_documentation_never_an_address_from_the_renderer | ported |
| conv-search | folds case and Polish diacritics without changing the length | unimux-agents conv::text::tests::folds_like_the_ts_reference_test; unimux-agents/tests/conv_golden.rs::fold_of_every_code_unit_matches | ported |
| conv-search | splits words and quoted phrases and drops terms another one contains | unimux-agents conv::search::tests::splits_words_and_quoted_phrases_and_drops_terms_another_one_contains; unimux-agents/tests/conv_golden.rs::query_terms_match | ported |
| conv-search | finds the message of an offset | unimux-agents conv::search::tests::finds_the_message_of_an_offset | ported |
| conv-search | needs every term somewhere in the conversation | unimux-agents conv::search::tests::needs_every_term_somewhere_in_the_conversation | ported |
| conv-search | marks the terms in snippets with offsets of the snippet text | unimux-agents conv::search::tests::marks_the_terms_in_snippets_with_offsets_of_the_snippet_text; unimux-agents/tests/conv_golden.rs::search_results_match_with_utf16_offsets | ported |
| conv-search | marks folded matches on the original text | unimux-agents conv::search::tests::marks_folded_matches_on_the_original_text | ported |
| conv-search | filters by role | unimux-agents conv::search::tests::filters_by_role | ported |
| conv-search | cuts long messages around the hit and collapses whitespace | unimux-agents conv::search::tests::cuts_long_messages_around_the_hit_and_collapses_whitespace | ported |
| conv-search | matches a title term and lists newest first with filters | unimux-agents conv::search::tests::matches_a_title_term_and_lists_newest_first_with_filters | ported |
| conv-search | skips tool output, thinking, injected and sidechain lines on Claude | unimux-agents conv::parse::tests::skips_tool_output_thinking_injected_and_sidechain_lines_on_claude | ported |
| conv-search | prefilters lines on their bytes | unimux-agents conv::parse::tests::prefilters_lines_on_their_bytes | ported |
| conv-search | reads lines across chunk borders, skips huge lines and keeps the offset of the last whole line | unimux-agents conv::parse::tests::reads_lines_across_chunk_borders_skips_huge_lines_and_keeps_the_offset_of_the_last_whole_line; unimux-agents/tests/conv_golden.rs::transcripts_read_into_the_same_documents_and_exports | ported |
| conv-search | indexes both formats and searches across projects | unimux-agents/tests/conv_index.rs::indexes_both_formats_and_searches_across_projects | ported |
| conv-search | reads only what a grown transcript gained, and a replaced one again | unimux-agents/tests/conv_index.rs::reads_only_what_a_grown_transcript_gained_and_a_replaced_one_again | ported |
| conv-search | drops removed files, survives missing folders and keeps the index in its cache file | unimux-agents/tests/conv_index.rs::drops_removed_files_survives_missing_folders_and_keeps_the_index_in_its_cache_file | ported |
| conv-search | reads the transcript preview of indexed files only, with message indexes that match the snippets | unimux-agents/tests/conv_index.rs::reads_the_transcript_preview_of_indexed_files_only_with_message_indexes_that_match_the_snippets | ported |
| conv-search | caps the text of a huge conversation | unimux-agents/tests/conv_index.rs::caps_the_text_of_a_huge_conversation | ported |
| conv-search | keeps only known query fields | unimux-agents/tests/conv_index.rs::keeps_only_known_query_fields; unimux-agents/tests/conv_golden.rs::ipc_sanitizers_match | ported |
| conv-search | finds the project or worktree of a conversation folder | folderOwner stays in the renderer (src/renderer/src/conversationSearch.ts) | renderer-only |
| conv-export | reads a Claude transcript: texts and tool calls, never tool output, thinking, injected or sidechain messages | unimux-agents/tests/conv_index.rs::reads_a_claude_transcript_texts_and_tool_calls_never_tool_output_thinking_injected_or_sidechain_messages | ported |
| conv-export | reads a Codex rollout: shell commands without the shell wrapper, apply_patch as its files, no reasoning or output | unimux-agents/tests/conv_index.rs::reads_a_codex_rollout_shell_commands_without_the_shell_wrapper_apply_patch_as_its_files_no_reasoning_or_output | ported |
| conv-export | stops at the limits and says so | unimux-agents/tests/conv_index.rs::stops_at_the_limits_and_says_so | ported |
| conv-export | finds Claude and Codex sessions by id and refuses ids that could be paths | unimux-agents/tests/conv_index.rs::finds_claude_and_codex_sessions_by_id_and_refuses_ids_that_could_be_paths; unimux-agents/tests/conv_golden.rs::ipc_sanitizers_match | ported |
| conv-export | renders the Claude fixture with a header, sections and no tool calls by default | renderConvMarkdown stays in the renderer (src/renderer/src/convExport.ts) | renderer-only |
| conv-export | adds one quoted line per tool call when asked | renderConvMarkdown stays in the renderer | renderer-only |
| conv-export | renders the Codex fixture under "## Codex" | renderConvMarkdown stays in the renderer | renderer-only |
| conv-export | marks cut messages and a cut conversation, and names an untitled one | renderConvMarkdown stays in the renderer | renderer-only |
| conv-export | summarises tool inputs in one line | unimux-agents conv::export::tests::summarises_tool_inputs_in_one_line; unimux-agents/tests/conv_golden.rs::tool_details_match | ported |
| conv-export | keeps backticks inside inline code | inlineCode stays in the renderer | renderer-only |
| conv-export | builds a file name from the title and the day | exportBaseName stays in the renderer | renderer-only |
| conv-export | cuts a long text for a note at a line end with a note | capText stays in the renderer | renderer-only |
| claude-locks | uses the paths Claude Code uses | unimux-accounts locks::tests::uses_the_paths_claude_code_uses; unimux-accounts locks::tests::the_legacy_lock_follows_a_junction_to_the_real_config_dir | ported |
| claude-locks | holds the credential locks and the config lock while fn runs, and releases them | unimux-accounts locks::tests::holds_the_credential_locks_and_the_config_lock_while_fn_runs_and_releases_them; unimux-accounts locks::tests::credentials_only_skips_the_config_lock | ported |
| claude-locks | releases on throw | unimux-accounts locks::tests::releases_on_throw (a panic in f); unimux-accounts locks::tests::a_dropped_lock_is_released | ported |
| claude-locks | waits for a holder that lets go | unimux-accounts locks::tests::waits_for_a_holder_that_lets_go; unimux-accounts/tests/lock_interop.rs (real npm proper-lockfile, both directions) | ported |
| claude-locks | gives up on a live holder without running fn and releases what it took | unimux-accounts locks::tests::gives_up_on_a_live_holder_without_running_fn_and_releases_what_it_took | ported |
| claude-locks | takes over a credential lock older than 60 s and a config lock older than 10 s | unimux-accounts locks::tests::takes_over_a_credential_lock_older_than_60_s_and_a_config_lock_older_than_10_s | ported |
| claude-locks | does not take over a credential lock that is only 15 s old | unimux-accounts locks::tests::does_not_take_over_a_credential_lock_that_is_only_15_s_old | ported |
| claude-locks | touches its locks while holding them | unimux-accounts locks::tests::touches_its_locks_while_holding_them | ported |
| claude-locks | never creates, reads or removes Claude Code's owner record | unimux-accounts locks::tests::never_creates_reads_or_removes_claude_codes_owner_record | ported |
| claude-locks | never creates Claude Code's directories | unimux-accounts locks::tests::never_creates_claude_codes_directories | ported |
| claude-locks | retries the release while the lock dir is briefly busy (EPERM, EBUSY), so no lock is left behind | unimux-accounts locks::tests::retries_the_release_while_the_lock_dir_is_briefly_busy_so_no_lock_is_left_behind | ported |
| claude-locks | gives up after a few tries and reports it | unimux-accounts locks::tests::gives_up_after_a_few_tries_and_reports_it | ported |
| accounts-store | accepts uuids only | unimux-accounts store::tests::is_account_id_accepts_uuids_only | ported |
| accounts-store | prepare creates the directory but does not list it | unimux-accounts store::tests::prepare_creates_the_directory_but_does_not_list_it | ported |
| accounts-store | commit lists the account and persists across instances, in insertion order | unimux-accounts store::tests::commit_lists_the_account_and_persists_across_instances_in_insertion_order | ported |
| accounts-store | commit of an existing id replaces it | unimux-accounts store::tests::commit_of_an_existing_id_replaces_it | ported |
| accounts-store | drops over-long email and org on commit and update like list does | unimux-accounts store::tests::drops_over_long_email_and_org_on_commit_and_update_like_list_does | ported |
| accounts-store | keeps a corrupt accounts.json as a timestamped backup and starts empty, never over an earlier backup | unimux-accounts store::tests::keeps_a_corrupt_accounts_json_as_a_timestamped_backup_and_starts_empty_never_over_an_earlier_backup | ported |
| accounts-store | removes the temp file when the write cannot be completed | unimux-accounts store::tests::removes_the_temp_file_when_the_write_cannot_be_completed; unimux-accounts store::tests::removes_the_temp_file_when_the_rename_fails | ported |
| accounts-store | tolerates missing and corrupt files | unimux-accounts store::tests::tolerates_missing_and_corrupt_files | ported |
| accounts-store | drops entries with bad ids or shapes | unimux-accounts store::tests::drops_entries_with_bad_ids_or_shapes; unimux-accounts/tests/golden.rs::accounts_store_matches_1_1_4 | ported |
| accounts-store | update changes email and org | unimux-accounts store::tests::update_changes_email_and_org | ported |
| accounts-store | remove deletes the record and directory, also for an uncommitted id | unimux-accounts store::tests::remove_deletes_the_record_and_directory_also_for_an_uncommitted_id | ported |
| accounts-store | rejects invalid ids and never touches anything outside the root | unimux-accounts store::tests::rejects_invalid_ids_and_never_touches_anything_outside_the_root | ported |
| accounts-store | writes atomically and leaves no temp files | unimux-accounts store::tests::writes_atomically_and_leaves_no_temp_files | ported |
| accounts-store | keeps the key order of the stored entry | unimux-accounts store::tests::update_keeps_the_key_order_of_the_stored_entry; unimux-accounts store::tests::writes_the_1_1_4_format_byte_for_byte | ported |
| accounts-store | keeps identity, custody, family and duplicateOf and drops bad values | unimux-accounts store::tests::v2_keeps_identity_custody_family_and_duplicate_of_and_drops_bad_values | ported |
| accounts-store | updateIdentity with replace takes exactly the given identity | unimux-accounts store::tests::v2_update_identity_with_replace_takes_exactly_the_given_identity | ported |
| accounts-store | lists the records of a newer file without changing it | unimux-accounts store::tests::v2_lists_the_records_of_a_newer_file_without_changing_it; unimux-accounts store::tests::v2_opens_a_file_it_cannot_read_safely_read_only_and_never_writes_over_it | ported |
| accounts-store | reports version 1 for a 0.9.0 file and 2 after the migration mark | unimux-accounts store::tests::v2_reports_version_1_for_a_0_9_0_file_and_2_after_the_migration_mark | ported |
| accounts-store | keeps the live identity and the notices across record writes, at most 20 notices | unimux-accounts store::tests::v2_keeps_the_live_identity_and_the_notices_across_record_writes_at_most_20_notices | ported |
| accounts-store | remove drops the notices and the live record id that point to the record | unimux-accounts store::tests::v2_remove_drops_the_notices_and_the_live_record_id_that_point_to_the_record | ported |
| accounts-store | removing the record a copy was set aside for releases the copy (never the last saved copy behind a copy notice) | unimux-accounts store::tests::v2_removing_the_record_a_copy_was_set_aside_for_releases_the_copy | ported |
| codex-accounts | compares by user and workspace, else by e-mail | unimux-accounts codex::tests::compares_by_user_and_workspace_else_by_e_mail; unimux-accounts/tests/golden.rs::identity_helpers_match_1_1_4 | ported |
| codex-accounts | reads accounts.json safely (bad ids, duplicates and a dangling live record are dropped) | unimux-accounts codex::tests::reads_accounts_json_safely; unimux-accounts/tests/golden.rs::codex_store_matches_1_1_4 | ported |
| codex-accounts | marks the twin of an account switched out by something else as outdated, never an independent copy | unimux-accounts codex::tests::marks_the_twin_of_an_account_switched_out_by_something_else_as_outdated_never_an_independent_copy | ported |
| codex-accounts | refuses the live account, an outdated copy and a missing record; detects the keyring store | unimux-accounts codex::tests::refuses_the_live_account_an_outdated_copy_and_a_missing_record_detects_the_keyring_store | ported |
| codex-accounts | reads who an auth.json belongs to without returning a token | unimux-accounts codex::tests::reads_who_an_auth_json_belongs_to_without_returning_a_token | ported |
| accounts-identity | prefers .claude.json and skips the CLI | unimux-accounts identity::tests::prefers_claude_json_and_skips_the_cli | ported |
| accounts-identity | falls back to the CLI with CLAUDE_CONFIG_DIR set to the profile | unimux-accounts identity::tests::falls_back_to_the_cli_with_claude_config_dir_set_to_the_profile | ported |
| accounts-identity | gives {} for logged out, bad JSON, null and throwing exec | unimux-accounts identity::tests::gives_empty_for_logged_out_bad_json_null_and_throwing_exec | ported |
| mcp | rejects missing credentials, foreign origins and invalid hosts before handling tools | unimux-mcp/tests/server.rs::rejects_missing_credentials_foreign_origins_and_invalid_hosts_before_handling_tools | ported |
| mcp | enforces the token owner role and revokes credentials when its cell restarts | unimux-mcp/tests/server.rs::rejects_revoked_tokens_at_the_http_layer_and_mid_session (revoke on re-issue); the role checks of the tools are M2 / M3 | partial |
| mcp | limits request bodies without modifying application state | unimux-mcp/tests/server.rs::limits_request_bodies_without_modifying_application_state | ported |
| mcp | distinguishes configured tokens from authenticated connections and clears on revoke/stop | unimux-mcp/tests/server.rs::distinguishes_configured_tokens_from_authenticated_connections_and_clears_on_revoke_and_stop; a_cell_counts_as_connected_for_ten_minutes_after_its_last_tool_use | ported |
| mcp | cuts an oversized result into valid JSON with a hint | unimux-mcp tools::tests::cap_result_keeps_valid_json_under_the_cap; cap_result_writes_a_cut_surrogate_pair_like_json_stringify | ported |
| mcp-protocol | initializes statelessly with a role-aware instruction and returns text-only JSON results | unimux-mcp/tests/server.rs::initializes_statelessly_with_the_instructions_and_text_only_json_results (the role-aware instruction text is M2) | partial |
| mcp-protocol | accepts large arguments up to the body limit and handles concurrent calls | unimux-mcp/tests/server.rs::handles_concurrent_calls_and_a_body_up_to_the_limit (the 32,000-character snippet limit is M2) | partial |
| mcp-protocol | rejects revoked tokens at the HTTP layer and mid-session | unimux-mcp/tests/server.rs::rejects_revoked_tokens_at_the_http_layer_and_mid_session | ported |
| mcp-protocol | stops listing tools when MCP is disabled for the cell and refuses calls | unimux-mcp/tests/server.rs::stops_listing_tools_when_mcp_is_disabled_for_the_cell_and_refuses_calls (the server side; the role lookup is M2) | partial |
| mcp-protocol | stops waiting when the client disconnects and frees the request slot | unimux-mcp/tests/server.rs::stops_waiting_when_the_client_disconnects_and_frees_the_request_slot | ported |
| mcp-protocol | ends an in-flight wait_for with an expiry error when its token is revoked | unimux-mcp/tests/server.rs::ends_an_in_flight_wait_for_with_an_expiry_error_when_its_token_is_revoked (fake wait_for; the real one is M4) | ported |
| mcp-protocol | listens on loopback only and issues unique 256-bit tokens | unimux-mcp/tests/server.rs::listens_on_loopback_only_and_issues_unique_256_bit_tokens | ported |
| mcp-protocol | does not grow with issued and revoked tokens | unimux-mcp/tests/server.rs::does_not_grow_with_issued_and_revoked_tokens | ported |
| mcp-protocol | rate limits per token with a monotonic clock: exact 429s, refill, no refill from a backwards step | unimux-mcp/tests/server.rs::rate_limits_per_token_with_a_monotonic_clock; unimux-mcp server::tests::the_rate_bucket_never_refills_from_a_backwards_clock | ported |
| mcp-protocol | does not spend rate budget on requests rejected by the in-flight cap | unimux-mcp/tests/server.rs::does_not_spend_rate_budget_on_requests_rejected_by_the_in_flight_cap | ported |
| mcp-protocol | caps simultaneous requests per token so a waiting agent cannot exhaust the server | unimux-mcp/tests/server.rs::caps_simultaneous_requests_per_token_so_a_waiting_agent_cannot_exhaust_the_server; caps_simultaneous_stateless_requests_in_total | ported |
| mcp-protocol | rejects foreign Host and Origin headers, other paths and methods, and oversize bodies | unimux-mcp/tests/server.rs::rejects_foreign_host_and_origin_headers_other_paths_and_methods_and_oversize_bodies | ported |
| mcp-protocol | never echoes the bearer token in responses | unimux-mcp/tests/server.rs::never_echoes_the_bearer_token_in_responses; an_internal_failure_answers_500_without_echoing_the_request | ported |
| mcp-protocol | answers tools/list quickly and cheaply for repeated calls | unimux-mcp/tests/server.rs::answers_tools_list_quickly_and_cheaply_for_repeated_calls | ported |
| ssh-keys | %s %s | unimux-ssh/tests/keys.rs::generate_key_every_type_and_size (all 7 type/size rows, with and without a passphrase); generated_keys_pass_ssh_keygen | ported |
| ssh-keys | refuses sizes the generator does not offer | unimux-ssh/tests/keys.rs::generate_key_refuses_sizes_the_generator_does_not_offer | ported |
| ssh-keys | accepts OpenSSH, PEM PKCS#1 RSA, PEM SEC1 EC and PPK v2 RSA | unimux-ssh/tests/keys.rs::parse_private_key_accepts_openssh_pem_and_ppk_v2; every_answer_of_the_sp7_key_corpus_matches_1_1_4 | ported |
| ssh-keys | asks for the passphrase of an encrypted key and checks it | unimux-ssh/tests/keys.rs::parse_private_key_asks_for_and_checks_the_passphrase | ported |
| ssh-keys | rejects what it cannot use with a clear code | unimux-ssh/tests/keys.rs::parse_private_key_rejects_with_clear_codes; text_variants_answer_like_1_1_4 | ported |
| ssh-keys | compares pasted public keys and certificates with the private key | unimux-ssh/tests/keys.rs::pasted_public_keys_and_certificates_are_compared; public_key_checks_answer_like_1_1_4 | ported |
| ssh-keys | keeps at most 20 drafts and evicts the oldest (D3) | unimux-ssh/tests/keys.rs::key_drafts_keep_at_most_20_and_evict_the_oldest | ported |
| ssh-keys | creates, unlocks, flags duplicates and mismatches, and expires drafts | unimux-ssh/tests/keys.rs::key_drafts_create_unlock_flag_and_expire; draft_sessions_give_the_1_1_4_draft_results | ported |
| ssh-keys | never returns private material in a draft result | unimux-ssh/tests/keys.rs::key_drafts_never_return_private_material | ported |
| update-coordinator | idle -> checking -> available -> downloading -> ready, one download for repeated looks | unimux-update coordinator::tests::idle_checking_available_downloading_ready_one_download_for_repeated_looks | ported |
| update-coordinator | a background look while an update is offered is silent and a failure of it does not turn "ready" into an error | unimux-update coordinator::tests::a_background_look_while_an_update_is_offered_is_silent_and_a_failure_of_it_does_not_turn_ready_into_an_error | ported |
| update-coordinator | shows an error with the target version and retries by looking again | unimux-update coordinator::tests::shows_an_error_with_the_target_version_and_retries_by_looking_again | ported |
| update-coordinator | reports "current" when the feed has nothing newer and drops a target the feed no longer announces | unimux-update coordinator::tests::reports_current_when_the_feed_has_nothing_newer_and_drops_a_target_the_feed_no_longer_announces | ported |
| update-coordinator | announces only a download link for builds that cannot install by themselves | unimux-update coordinator::tests::announces_only_a_download_link_for_builds_that_cannot_install_by_themselves | ported |
| update-coordinator | stalled-download watchdog: no progress for two minutes is an error, later progress recovers | unimux-update coordinator::tests::stalled_download_watchdog_no_progress_for_two_minutes_is_an_error_later_progress_recovers | ported |
| update-coordinator | a look that never answers ends in an error instead of blocking every later check | unimux-update coordinator::tests::a_look_that_never_answers_ends_in_an_error_instead_of_blocking_every_later_check | ported |
| update-coordinator | while available/downloading: cancels the old download, restarts for the newest, notifies listeners | unimux-update coordinator::tests::while_available_downloading_cancels_the_old_download_restarts_for_the_newest_notifies_listeners | ported |
| update-coordinator | while ready: the old version is forgotten (it can no longer be installed) | unimux-update coordinator::tests::while_ready_the_old_version_is_forgotten | ported |
| update-coordinator | a joined download of the superseded version rejects with SupersededError | unimux-update coordinator::tests::a_joined_download_of_the_superseded_version_ends_superseded | ported |
| update-coordinator | during the hand-over: nothing changes, the newer version is only remembered | unimux-update coordinator::tests::during_the_hand_over_nothing_changes_the_newer_version_is_only_remembered | ported |
| update-coordinator | a failed hand-over releases the lock; then the newest version is offered normally | unimux-update coordinator::tests::a_failed_hand_over_releases_the_lock_then_the_newest_version_is_offered_normally | ported |
| update-coordinator | a stale OLDER answer of the feed never replaces the target, cancels nothing and starts no second download | unimux-update coordinator::tests::a_stale_older_answer_never_replaces_the_target_cancels_nothing_and_starts_no_second_download | ported |
| update-coordinator | a stale older answer while the newer one is still downloading keeps that download | unimux-update coordinator::tests::a_stale_older_answer_while_the_newer_one_is_still_downloading_keeps_that_download | ported |
| update-coordinator | a download page offer (install refused) survives blocking and later looks; a real block still drops a normal target | unimux-update coordinator::tests::a_download_page_offer_survives_blocking_and_later_looks_a_real_block_still_drops_a_normal_target | ported |
| update-coordinator | a blocked version is not offered; a newer one is | unimux-update coordinator::tests::a_blocked_version_is_not_offered_a_newer_one_is | ported |
| update-coordinator | compares versions numerically | unimux-update version::tests::compares_dotted_versions_numerically | ported |
| update-coordinator | ask prompt open: a newer release replaces the version in the prompt, "Install now" installs the newest only | unimux-update gate::tests::ask_prompt_open_a_newer_release_replaces_the_version_in_the_prompt_install_now_installs_the_newest_only | ported |
| update-coordinator | chosen and downloading: a newer release restarts the download in the same window, the old version is never installing | unimux-update gate::tests::chosen_and_downloading_a_newer_release_restarts_the_download_in_the_same_window | ported |
| update-coordinator | the last look before the hand-over finds a newer release after the old one was fully downloaded | unimux-update gate::tests::the_last_look_before_the_hand_over_finds_a_newer_release_after_the_old_one_was_fully_downloaded | ported |
| update-coordinator | status bar click on a ready update: window opens, the last look supersedes, the newest installs | unimux-update gate::tests::status_bar_click_on_a_ready_update_window_opens_the_last_look_supersedes_the_newest_installs | ported |
| update-coordinator | status bar click while a background download runs joins it (no second download) and installs when it ends | unimux-update gate::tests::status_bar_click_while_a_background_download_runs_joins_it_and_installs_when_it_ends | ported |
| update-coordinator | status bar click on a ready update installs at once through the window | unimux-update gate::tests::status_bar_click_on_a_ready_update_installs_at_once_through_the_window | ported |
| update-coordinator | user pressed install for A and B appears during the hand-over: A finishes, B is offered after the relaunch | unimux-update gate::tests::install_pressed_for_a_and_b_appears_during_the_hand_over_a_finishes_b_is_offered_after_the_relaunch | ported |
| update-coordinator | closing the window mid-download leaves the download running for the status bar | unimux-update gate::tests::closing_the_window_mid_download_leaves_the_download_running_for_the_status_bar | ported |
| update-coordinator | lets only one of the startup prompt and the status bar window exist at a time | unimux-update gate::tests::lets_only_one_of_the_startup_prompt_and_the_status_bar_window_exist_at_a_time | ported |
| startup-gate | gates only the installed Windows and macOS builds in the Automatic (ask) mode | unimux-update gate::tests::gates_only_the_installed_windows_and_macos_builds_in_the_automatic_ask_mode | ported |
| startup-gate | compares dotted versions numerically | unimux-update version::tests::compares_dotted_versions_numerically | ported |
| startup-gate | a record of the version that is now running is no failure (the next start may offer a newer release) | unimux-update gate::tests::a_record_of_the_version_that_is_now_running_is_no_failure | ported |
| startup-gate | keeps a failure for the cooldown only and ignores malformed records | unimux-update gate::tests::keeps_a_failure_for_the_cooldown_only_and_ignores_malformed_records | ported |
| startup-gate | starts the app without ever showing the window when there is no update quickly | unimux-update gate::tests::starts_the_app_without_ever_showing_the_window_when_there_is_no_update_quickly | ported |
| startup-gate | shows the checking window after the short delay and closes it when current | unimux-update gate::tests::shows_the_checking_window_after_the_short_delay_and_closes_it_when_current | ported |
| startup-gate | closes a checking window the moment the answer arrives, without holding it on screen | unimux-update gate::tests::closes_a_checking_window_the_moment_the_answer_arrives_without_holding_it_on_screen | ported |
| startup-gate | returns at once when the user closes the checking window | unimux-update gate::tests::returns_at_once_when_the_user_closes_the_checking_window | ported |
| startup-gate | fails open after the hard timeout when the server never answers | unimux-update gate::tests::fails_open_after_the_hard_timeout_when_the_server_never_answers | ported |
| startup-gate | fails open when the check rejects or throws synchronously | unimux-update gate::tests::fails_open_when_the_check_rejects (a synchronous throw does not exist in Rust: check returns a future) | ported |
| startup-gate | survives a window that fails to show or hide | obsolete: GateDeps::show / hide cannot fail (no return value, no exceptions) | obsolete |
| startup-gate | offers the update, downloads and hands over to the installer without starting the app | unimux-update gate::tests::offers_the_update_downloads_and_hands_over_to_the_installer_without_starting_the_app | ported |
| startup-gate | records the failure, shows it and starts the current version when the download fails | unimux-update gate::tests::records_the_failure_shows_it_and_starts_the_current_version_when_the_download_fails | ported |
| startup-gate | records the failure and starts the app when the installer hand-over does not happen | unimux-update gate::tests::records_the_failure_and_starts_the_app_when_the_installer_hand_over_does_not_happen | ported |
| startup-gate | treats a stalled download as a failure | unimux-update gate::tests::treats_a_stalled_download_as_a_failure | ported |
| startup-gate | keeps a slow but progressing download alive | unimux-update gate::tests::keeps_a_slow_but_progressing_download_alive | ported |
| startup-gate | never retries a version that already failed | unimux-update gate::tests::never_retries_a_version_that_already_failed | ported |
| startup-gate | marks the attempt before the installer starts, so an installer failing outside the app is remembered | unimux-update gate::tests::marks_the_attempt_before_the_installer_starts | ported |
| startup-gate | starts the app when the hand-over never answers and nothing says the installer started (abandoned, no failure record) | unimux-update gate::tests::starts_the_app_when_the_hand_over_never_answers_and_nothing_says_the_installer_started | ported |
| startup-gate | starts the app when the hand-over throws or reports that nothing was handed over | unimux-update gate::tests::starts_the_app_when_the_hand_over_throws_or_reports_that_nothing_was_handed_over | ported |
| startup-gate | gives up on a download that keeps progressing but never finishes | unimux-update gate::tests::gives_up_on_a_download_that_keeps_progressing_but_never_finishes | ported |
| startup-gate | abandons the check only on a timeout, not on an ordinary failure | unimux-update gate::tests::abandons_the_check_only_on_a_timeout_not_on_an_ordinary_failure | ported |
| startup-gate | closes the window even when showing it threw | obsolete: GateDeps::show cannot fail; hide after a shown window is covered by shows_the_checking_window_after_the_short_delay_and_closes_it_when_current | obsolete |
| startup-gate | survives a failing attempt marker | obsolete: GateDeps::mark_attempt cannot fail (write_gate_record is best effort and returns nothing) | obsolete |
| startup-gate | starts the app during the check without recording a failure and abandons the check | unimux-update gate::tests::starts_the_app_during_the_check_without_recording_a_failure_and_abandons_the_check | ported |
| startup-gate | starts the app during the download, leaves the window closed and ignores later progress | unimux-update gate::tests::starts_the_app_during_the_download_leaves_the_window_closed_and_ignores_later_progress | ported |
| startup-gate | is ignored once the installer is being handed over | unimux-update gate::tests::a_cancel_is_ignored_once_the_installer_is_being_handed_over | ported |
| startup-gate | still updates to a newer version than the one that failed | unimux-update gate::tests::still_updates_to_a_newer_version_than_the_one_that_failed | ported |
| startup-gate | is abandoned through the signal when the installer was not started in time, without recording a failure | unimux-update gate::tests::a_slow_hand_over_is_abandoned_through_the_signal_without_recording_a_failure | ported |
| startup-gate | counts as installing when the installer was already started at the deadline (no failure, the app is about to quit) | unimux-update gate::tests::a_slow_hand_over_counts_as_installing_when_the_installer_was_already_started_at_the_deadline | ported |
| startup-gate | still records a failure when the hand-over itself reports failure | unimux-update gate::tests::a_hand_over_that_reports_failure_still_records_a_failure | ported |
| startup-gate | skips a failed version only while the failure is recent | unimux-update gate::tests::skips_a_failed_version_only_while_the_failure_is_recent | ported |
| startup-gate | offers the update, starts downloading at once and keeps the prompt on screen while it runs | unimux-update gate::tests::ask_offers_the_update_starts_downloading_at_once_and_keeps_the_prompt_on_screen_while_it_runs | ported |
| startup-gate | re-checks once when "Install now" fails and does not record a failure for a vanished version | unimux-update gate::tests::ask_re_checks_once_when_install_now_fails_and_does_not_record_a_failure_for_a_vanished_version | ported |
| startup-gate | still records the failure when the re-check finds the same version | unimux-update gate::tests::ask_still_records_the_failure_when_the_re_check_finds_the_same_version | ported |
| startup-gate | "Install now" while the download is still running shows its progress, then hands over | unimux-update gate::tests::ask_install_now_while_the_download_is_still_running_shows_its_progress_then_hands_over | ported |
| startup-gate | "Install now" after the download finished goes straight to the hand-over | unimux-update gate::tests::ask_install_now_after_the_download_finished_goes_straight_to_the_hand_over | ported |
| startup-gate | a download that failed while the prompt was open fails when "Install now" is chosen | unimux-update gate::tests::ask_a_download_that_failed_while_the_prompt_was_open_fails_when_install_now_is_chosen | ported |
| startup-gate | "Later" after a failed download starts the app quietly, without a failure record or prompt loop | unimux-update gate::tests::ask_later_after_a_failed_download_starts_the_app_quietly | ported |
| startup-gate | a stalled download is still a failure when "Install now" is chosen after the stall | unimux-update gate::tests::ask_a_stalled_download_is_still_a_failure_when_install_now_is_chosen_after_the_stall | ported |
| startup-gate | "Later" (or X, Escape) starts the app without installing or recording a failure and leaves the download running | unimux-update gate::tests::ask_later_starts_the_app_without_installing_or_recording_a_failure_and_leaves_the_download_running | ported |
| startup-gate | never prompts or downloads when there is no update, and never retries a failed version | unimux-update gate::tests::ask_never_prompts_or_downloads_when_there_is_no_update_and_never_retries_a_failed_version | ported |
| startup-gate | closing during the download after "Install now" still starts the app without a failure record | unimux-update gate::tests::ask_closing_during_the_download_after_install_now_still_starts_the_app_without_a_failure_record | ported |
| monitor | reads the Windows helper rows (100 ns CPU, FILETIME start) and skips junk | no helper text in 1.2.0: SYSTEM_PROCESS_INFORMATION is read directly with the same fields and units (unimux-files monitor::win::tests::a_snapshot_finds_this_process_with_its_parent_start_and_name; a_tiny_buffer_grows_to_what_the_system_needs) | obsolete |
| monitor | reads ps CPU times in every shape macOS prints | no `ps` in 1.2.0: libproc gives the CPU time as a number (unimux-files monitor::mac, compile-checked for aarch64-apple-darwin) | obsolete |
| monitor | reads ps rows with lstart and executable paths with spaces | no `ps` in 1.2.0: libproc gives start, resident size and the executable path (unimux-files monitor::mac) | obsolete |
| monitor | is the CPU time used in the interval over every core, 0 for new or reused pids | unimux-files monitor::model::tests::cpu_is_the_time_used_in_the_interval_over_every_core_0_for_new_or_reused_pids; tests/golden_g8.rs::monitor_trees_match_the_ts_reference | ported |
| monitor | ignores a parent pid that was reused by a younger process | unimux-files monitor::model::tests::ignores_a_parent_pid_that_was_reused_by_a_younger_process | ported |
| monitor | survives cycles | unimux-files monitor::model::tests::survives_cycles | ported |
| monitor | gives each cell the console host ConPTY started right before its shell | unimux-files monitor::model::tests::gives_each_cell_the_console_host_conpty_started_right_before_its_shell | ported |
| monitor | puts the busiest cell first with its tree depth-first and its console host | unimux-files monitor::model::tests::puts_the_busiest_cell_first_with_its_tree_depth_first_and_its_console_host; tests/golden_g8.rs::monitor_trees_match_the_ts_reference | ported |
| monitor | lists the app processes and anything else the app started, never a cell process twice, never a foreign one | unimux-files monitor::model::tests::lists_the_app_processes_and_anything_else_the_app_started_never_a_cell_process_twice_never_a_foreign_one; without_a_pty_host_the_console_hosts_are_the_apps_own_children | ported |
| monitor | allows killing only processes of a cell tree, never a console host, a host or the app | unimux-files monitor::model::tests::allows_killing_only_processes_of_a_cell_tree_never_a_console_host_a_host_or_the_app | ported |
| monitor | names the hosts by their fork names and matches the console hosts to the cells | adapted: no Electron hosts in 1.2.0, the WebView2 processes get their kinds instead (unimux-files monitor::tests::names_the_webview_processes_by_kind_and_matches_the_console_hosts_to_the_cells; monitor::webview::tests::kinds_follow_webview2_and_the_command_line) | ported |
| monitor | kills only processes of a cell tree | unimux-files monitor::tests::kills_only_processes_of_a_cell_tree; unimux-app commands::files::g8::tests::the_monitor_samples_this_process_and_refuses_kills_outside_a_cell | ported |
| monitor | maps Electron process types and host service names | no app.getAppMetrics in 1.2.0: WebView2's process kinds and Chromium service names instead (unimux-files monitor::webview::tests::utility_processes_get_electrons_service_names; kinds_follow_webview2_and_the_command_line) | obsolete |
| monitor | formats memory and CPU | formatBytes / formatCpu stay in src/shared/monitor.ts for the renderer | renderer-only |
| noteFiles | saves a pasted image under a random name and reads it back as a data URL | unimux-files notes::tests::saves_a_pasted_image_under_a_random_name_and_reads_it_back_as_a_data_url; unimux-app commands::files::g8::tests::notes_channels_save_read_and_export_like_1_1_4 | ported |
| noteFiles | refuses what is not a small image of a known type | unimux-files notes::tests::refuses_what_is_not_a_small_image_of_a_known_type | ported |
| noteFiles | reads only names the app gave, never a path | unimux-files notes::tests::reads_only_names_the_app_gave_never_a_path | ported |
| noteFiles | writes the note where the dialog points and refuses names with a path | unimux-files notes::tests::writes_the_note_where_the_dialog_points_and_refuses_names_with_a_path; export_checks_follow_1_1_4 | ported |
| changelog | removes the title, the download guide and housekeeping lines | unimux-files changelog::tests::removes_the_title_the_download_guide_and_housekeeping_lines; tests/golden_g8.rs::releases_match_the_ts_reference | ported |
| changelog | lists published releases newest first and skips drafts and non-version tags | unimux-files changelog::tests::lists_published_releases_newest_first_and_skips_drafts_and_non_version_tags; tests/golden_g8.rs::releases_match_the_ts_reference | ported |
| changelog | compares versions numerically | unimux-files changelog::tests::compares_versions_numerically | ported |
| changelog | turns markdown into blocks without ever producing HTML | parseNotes / parseInline stay in src/shared/changelog.ts for the renderer | renderer-only |
| changelog | fetches once, serves the fresh copy and refetches when forced | unimux-files changelog::tests::fetches_once_serves_the_fresh_copy_and_refetches_when_forced | ported |
| changelog | deduplicates concurrent requests | unimux-files changelog::tests::deduplicates_concurrent_requests | ported |
| changelog | falls back to the saved copy offline and reports the error | unimux-files changelog::tests::falls_back_to_the_saved_copy_offline_and_reports_the_error | ported |
| changelog | reports an empty result with the error when nothing is saved | unimux-files changelog::tests::reports_an_empty_result_with_the_error_when_nothing_is_saved | ported |
| main-perf | answers without blocking and treats bad input as missing | unimux-files probe::tests::exists_answers_like_1_1_4; unimux-app commands::files::g8::tests::probes_answer_like_1_1_4 | ported |
