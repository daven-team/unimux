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
