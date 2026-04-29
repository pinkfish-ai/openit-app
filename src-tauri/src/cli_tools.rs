//! PATH detection for the CLI catalog. Install / uninstall happen
//! through Claude itself — OpenIT writes a structured prompt into the
//! embedded session asking Claude to run brew (or whatever the right
//! install path is) and to update CLAUDE.md. That gives Claude room to
//! debug failures (bad tap, missing formula, network) the way a human
//! collaborator would, instead of returning opaque stderr to the user.
//!
//! What stays here: a free `which` lookup so the catalog UI can reflect
//! what's actually on the machine — independent of how the binary got
//! there.

/// Returns true if `binary` is on PATH.
#[tauri::command]
pub fn cli_is_installed(binary: String) -> bool {
    which::which(&binary).is_ok()
}
