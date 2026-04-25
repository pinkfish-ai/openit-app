mod cli;
mod fs_tree;
mod git_history;
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
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::claude_detect,
            fs_tree::fs_list,
            fs_tree::fs_read,
            git_history::git_log,
            git_history::git_diff,
            cli::pinkit_deploy,
            state::state_load,
            state::state_save,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            pinkfish::pinkfish_oauth_exchange,
            pinkfish::pinkfish_list_orgs,
            pinkfish::pinkfish_list_connections,
            project::project_bootstrap,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
