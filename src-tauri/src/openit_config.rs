//! `.openit/config.json` — admin-tunable lifecycle knobs.
//!
//! The TS side has its own loader (`src/lib/openitConfig.ts`); this file
//! is the Rust entry-point so backend lifecycle paths (today: the
//! agent-crash escalation in `intake.rs`) can read the same config
//! without an IPC round-trip.
//!
//! Defaults are compiled in. A vanilla install has no `.openit/config.json`
//! file — `load(repo)` returns the default record. The file appears
//! lazily when an admin overrides something (writing is the TS side's
//! job today; the Rust side only reads).
//!
//! Partial overrides merge with defaults via serde `#[serde(default)]`
//! per field, so `{ "ticketLifecycle": { "escalateOnAdminReply": false } }`
//! keeps every other field at its compiled-in default.
//!
//! This file is local-only state: not synced to Pinkfish (`.openit/` is
//! local by design).

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketLifecycleConfig {
    /// Hours after a ticket flips to `resolved` before the auto-close
    /// walker flips it to `closed`. `0` disables the transition.
    #[serde(default = "default_auto_close_hours")]
    pub auto_close_resolved_after_hours: u32,
    /// Hours after a ticket sits in `open` (no asker reply) before the
    /// auto-escalate walker flips it to `escalated`. `0` disables.
    #[serde(default = "default_auto_escalate_hours")]
    pub auto_escalate_open_after_hours: u32,
    /// When an admin replies on a ticket, flip the ticket to `escalated`.
    /// Default `true` — the agent is no longer the sole driver. Set
    /// `false` if your admins want to leave commentary on resolved
    /// threads without re-opening them.
    #[serde(default = "default_true")]
    pub escalate_on_admin_reply: bool,
    /// When `claude -p` crashes mid-turn, flip the ticket to `escalated`
    /// so the admin notices. Default `true`. Set `false` for diagnostic
    /// mode — leaves the ticket in `agent-responding` so crash patterns
    /// stay legible.
    #[serde(default = "default_true")]
    pub escalate_on_agent_crash: bool,
}

fn default_auto_close_hours() -> u32 {
    24
}
fn default_auto_escalate_hours() -> u32 {
    24
}
fn default_true() -> bool {
    true
}

impl Default for TicketLifecycleConfig {
    fn default() -> Self {
        Self {
            auto_close_resolved_after_hours: default_auto_close_hours(),
            auto_escalate_open_after_hours: default_auto_escalate_hours(),
            escalate_on_admin_reply: default_true(),
            escalate_on_agent_crash: default_true(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenitConfig {
    #[serde(default)]
    pub ticket_lifecycle: TicketLifecycleConfig,
}

/// Load `.openit/config.json`. Missing file → defaults. Top-level parse
/// error → log and return defaults (config is not load-bearing).
///
/// Per-field tolerant: each known key is plucked individually from the
/// parsed JSON and validated. A wrong-typed or out-of-range value (e.g.
/// `"autoCloseResolvedAfterHours": 0.5` or a string where a bool is
/// expected) falls through to the compiled-in default for *that field
/// only* — the rest of the config is preserved. Mirrors the TS loader's
/// `mergeOpenitConfig` behaviour. Without this, a single bad field
/// would silently drop every override under the same struct (including
/// unrelated booleans), and the two language sides could disagree on
/// the same on-disk file.
pub async fn load(repo: &Path) -> OpenitConfig {
    let path = repo.join(".openit").join("config.json");
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => return OpenitConfig::default(),
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[openit-config] failed to parse {} ({}); using defaults",
                path.display(),
                e
            );
            return OpenitConfig::default();
        }
    };
    let mut cfg = OpenitConfig::default();
    if let Some(tl) = value.get("ticketLifecycle") {
        if let Some(v) = tl
            .get("autoCloseResolvedAfterHours")
            .and_then(coerce_non_negative_u32)
        {
            cfg.ticket_lifecycle.auto_close_resolved_after_hours = v;
        }
        if let Some(v) = tl
            .get("autoEscalateOpenAfterHours")
            .and_then(coerce_non_negative_u32)
        {
            cfg.ticket_lifecycle.auto_escalate_open_after_hours = v;
        }
        if let Some(b) = tl.get("escalateOnAdminReply").and_then(|x| x.as_bool()) {
            cfg.ticket_lifecycle.escalate_on_admin_reply = b;
        }
        if let Some(b) = tl.get("escalateOnAgentCrash").and_then(|x| x.as_bool()) {
            cfg.ticket_lifecycle.escalate_on_agent_crash = b;
        }
    }
    cfg
}

/// Best-effort coerce a JSON number to a non-negative u32. Floats are
/// truncated; negatives clamp to 0; non-numeric values return `None` so
/// the caller falls through to the default. Mirrors the TS side's
/// `Math.max(0, n)` clamp.
fn coerce_non_negative_u32(v: &serde_json::Value) -> Option<u32> {
    let n = v.as_f64()?;
    if !n.is_finite() {
        return None;
    }
    if n < 0.0 {
        return Some(0);
    }
    let trunc = n.trunc();
    if trunc > u32::MAX as f64 {
        return Some(u32::MAX);
    }
    Some(trunc as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_returns_defaults_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = load(tmp.path()).await;
        assert_eq!(cfg.ticket_lifecycle.auto_close_resolved_after_hours, 24);
        assert_eq!(cfg.ticket_lifecycle.auto_escalate_open_after_hours, 24);
        assert!(cfg.ticket_lifecycle.escalate_on_admin_reply);
        assert!(cfg.ticket_lifecycle.escalate_on_agent_crash);
    }

    #[tokio::test]
    async fn load_full_override() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".openit")).unwrap();
        std::fs::write(
            tmp.path().join(".openit").join("config.json"),
            r#"{
                "ticketLifecycle": {
                    "autoCloseResolvedAfterHours": 0,
                    "autoEscalateOpenAfterHours": 48,
                    "escalateOnAdminReply": false,
                    "escalateOnAgentCrash": false
                }
            }"#,
        )
        .unwrap();
        let cfg = load(tmp.path()).await;
        assert_eq!(cfg.ticket_lifecycle.auto_close_resolved_after_hours, 0);
        assert_eq!(cfg.ticket_lifecycle.auto_escalate_open_after_hours, 48);
        assert!(!cfg.ticket_lifecycle.escalate_on_admin_reply);
        assert!(!cfg.ticket_lifecycle.escalate_on_agent_crash);
    }

    #[tokio::test]
    async fn load_partial_override_merges_with_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".openit")).unwrap();
        std::fs::write(
            tmp.path().join(".openit").join("config.json"),
            r#"{ "ticketLifecycle": { "escalateOnAdminReply": false } }"#,
        )
        .unwrap();
        let cfg = load(tmp.path()).await;
        // Overridden:
        assert!(!cfg.ticket_lifecycle.escalate_on_admin_reply);
        // Defaulted:
        assert_eq!(cfg.ticket_lifecycle.auto_close_resolved_after_hours, 24);
        assert_eq!(cfg.ticket_lifecycle.auto_escalate_open_after_hours, 24);
        assert!(cfg.ticket_lifecycle.escalate_on_agent_crash);
    }

    #[tokio::test]
    async fn load_per_field_tolerant_one_bad_field_does_not_drop_others() {
        // A wrong-typed numeric field (e.g. fractional or negative)
        // must NOT poison the rest of the struct — booleans alongside
        // it should still apply, mirroring the TS loader's per-field
        // merge.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".openit")).unwrap();
        std::fs::write(
            tmp.path().join(".openit").join("config.json"),
            r#"{
                "ticketLifecycle": {
                    "autoCloseResolvedAfterHours": 0.5,
                    "autoEscalateOpenAfterHours": -5,
                    "escalateOnAdminReply": false,
                    "escalateOnAgentCrash": false
                }
            }"#,
        )
        .unwrap();
        let cfg = load(tmp.path()).await;
        // Float truncates to 0; negative clamps to 0.
        assert_eq!(cfg.ticket_lifecycle.auto_close_resolved_after_hours, 0);
        assert_eq!(cfg.ticket_lifecycle.auto_escalate_open_after_hours, 0);
        // Booleans next to the numerics still apply — the whole-struct
        // deserialize would have dropped these silently before the fix.
        assert!(!cfg.ticket_lifecycle.escalate_on_admin_reply);
        assert!(!cfg.ticket_lifecycle.escalate_on_agent_crash);
    }

    #[tokio::test]
    async fn load_per_field_tolerant_wrong_type_falls_through() {
        // String where bool is expected → ignore the field, keep
        // others. Mirrors `mergeOpenitConfig`'s `typeof === "boolean"`
        // gate on the TS side.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".openit")).unwrap();
        std::fs::write(
            tmp.path().join(".openit").join("config.json"),
            r#"{
                "ticketLifecycle": {
                    "escalateOnAdminReply": "yes",
                    "autoCloseResolvedAfterHours": 48
                }
            }"#,
        )
        .unwrap();
        let cfg = load(tmp.path()).await;
        // Wrong-typed bool falls through to default `true`.
        assert!(cfg.ticket_lifecycle.escalate_on_admin_reply);
        // Sibling numeric still applies.
        assert_eq!(cfg.ticket_lifecycle.auto_close_resolved_after_hours, 48);
    }

    #[tokio::test]
    async fn load_falls_back_to_defaults_on_parse_error() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".openit")).unwrap();
        std::fs::write(tmp.path().join(".openit").join("config.json"), "not json").unwrap();
        let cfg = load(tmp.path()).await;
        // Defaults apply — no panic, no propagated error.
        assert_eq!(cfg.ticket_lifecycle.auto_close_resolved_after_hours, 24);
    }
}
