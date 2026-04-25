mod cli;
mod fs_tree;
mod git_history;
mod kb;
mod keychain;
mod pinkfish;
mod project;
mod pty;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::claude_detect,
            fs_tree::fs_list,
            fs_tree::fs_read,
            fs_tree::fs_read_bytes,
            git_history::git_log,
            git_history::git_diff,
            cli::pinkit_deploy,
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
            kb::kb_init,
            kb::kb_list_local,
            kb::kb_read_file,
            kb::kb_write_file,
            kb::kb_write_file_bytes,
            kb::kb_state_load,
            kb::kb_state_save,
            kb::kb_download_to_local,
            kb::kb_upload_file,
            kb::kb_list_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
