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
