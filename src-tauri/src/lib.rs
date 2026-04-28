mod agent_trace;
mod claude;
mod filestore;
mod fs_tree;
mod git_history;
mod git_ops;
mod intake;
mod kb;
mod keychain;
mod pinkfish;
mod project;
mod pty;
mod reports;
mod skill_canvas;
mod skills;
mod slack;
mod state;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            let _ = app;
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(watcher::WatcherState::default())
        .manage(intake::IntakeState::default())
        .manage(slack::SlackSupervisorState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::claude_detect,
            fs_tree::fs_list,
            fs_tree::fs_read,
            fs_tree::fs_read_bytes,
            fs_tree::fs_reveal,
            fs_tree::fs_open,
            fs_tree::fs_delete,
            git_history::git_log,
            git_history::git_diff,
            git_ops::git_ensure_repo,
            git_ops::git_add_and_commit,
            git_ops::git_commit_paths,
            git_ops::git_status_short,
            git_ops::git_stage,
            git_ops::git_unstage,
            git_ops::git_commit_staged,
            git_ops::git_discard,
            git_ops::git_file_diff,
            git_ops::git_has_conflict_markers,
            git_ops::git_diff_name_only,
            git_ops::git_global_user_email,
            claude::claude_generate_commit_message,
            state::state_load,
            state::state_save,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            keychain::keychain_probe,
            pinkfish::pinkfish_oauth_exchange,
            pinkfish::pinkfish_list_orgs,
            pinkfish::pinkfish_list_connections,
            pinkfish::pinkfish_mcp_call,
            project::project_bootstrap,
            reports::report_overview_run,
            kb::kb_init,
            kb::kb_delete_file,
            kb::kb_read_file,
            kb::kb_write_file,
            kb::kb_write_file_bytes,
            kb::kb_download_to_local,
            kb::kb_upload_file,
            kb::kb_list_remote,
            kb::kb_supported_extensions,
            kb::fs_store_init,
            kb::fs_store_read_file,
            kb::fs_store_write_file,
            kb::fs_store_write_file_bytes,
            kb::fs_store_download_to_local,
            kb::fs_store_upload_file,
            kb::entity_state_load,
            kb::entity_state_save,
            kb::entity_list_local,
            kb::entity_write_file,
            kb::entity_write_file_bytes,
            kb::entity_delete_file,
            kb::entity_clear_dir,
            skills::skills_fetch_manifest,
            skills::skills_fetch_file,
            skills::skills_fetch_bundled_manifest,
            skills::skills_fetch_bundled_file,
            filestore::filestore_list_collections,
            filestore::datastore_list_collections,
            watcher::fs_watch_start,
            watcher::fs_watch_stop,
            intake::intake_start,
            intake::intake_stop,
            intake::intake_url,
            agent_trace::agent_trace_latest,
            skill_canvas::skill_state_read,
            skill_canvas::skill_state_write,
            skill_canvas::skill_state_clear,
            slack::slack_connect,
            slack::slack_validate_bot_token,
            slack::slack_disconnect,
            slack::slack_config_read,
            slack::slack_listener_start,
            slack::slack_listener_stop,
            slack::slack_listener_status,
            slack::slack_listener_send_intro,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
