use keyring::Entry;

const SERVICE: &str = "ai.pinkfish.openit";

fn entry(slot: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, slot).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keychain_set(slot: String, value: String) -> Result<(), String> {
    let e = entry(&slot)?;
    e.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keychain_get(slot: String) -> Result<Option<String>, String> {
    let e = entry(&slot)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn keychain_delete(slot: String) -> Result<(), String> {
    let e = entry(&slot)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
