use keyring::Entry;

const SERVICE: &str = "ai.pinkfish.openit";

fn entry(slot: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, slot).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keychain_set(slot: String, value: String) -> Result<(), String> {
    let e = entry(&slot)?;
    e.set_password(&value).map_err(|e| e.to_string())?;
    eprintln!("[keychain] set ok: slot={} len={}", slot, value.len());
    Ok(())
}

/// Self-test: write then read back a value under a probe slot. Returns
/// whether the round-trip succeeded.
#[tauri::command]
pub fn keychain_probe() -> Result<bool, String> {
    let slot = "openit.probe";
    let probe_value = "probe-12345";
    let e = entry(slot)?;
    e.set_password(probe_value)
        .map_err(|e| format!("set: {}", e))?;
    let got = e.get_password().map_err(|e| format!("get: {}", e))?;
    let _ = e.delete_credential();
    Ok(got == probe_value)
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
