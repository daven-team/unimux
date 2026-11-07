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
