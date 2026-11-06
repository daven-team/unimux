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
