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
| stability | accepts only well-formed reports and cuts them | unimux-core crash_log::tests::renderer_reports | ported |
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
