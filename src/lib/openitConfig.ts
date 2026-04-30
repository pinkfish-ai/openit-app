// `.openit/config.json` — admin-tunable lifecycle knobs.
//
// Mirror of the Rust loader (`src-tauri/src/openit_config.rs`). The TS
// side is read by the lifecycle code paths in `entityRouting.ts` and
// `Viewer.tsx`; the Rust side is read by `intake.rs` for the
// agent-crash escalation gate. Both sides ship the same defaults.
//
// Defaults are compiled in. Vanilla install has no `.openit/config.json` —
// `loadOpenitConfig(repo)` returns the default record. The file appears
// only when an admin overrides something. Partial overrides merge with
// defaults (a file specifying just `escalateOnAdminReply: false` keeps
// every other knob at its default).
//
// Local-only: not synced to Pinkfish (`.openit/` is local by design).

import { fsRead } from "./api";

export interface TicketLifecycleConfig {
  /// Hours after a ticket flips to `resolved` before the auto-close
  /// walker flips it to `closed`. `0` disables the transition.
  autoCloseResolvedAfterHours: number;
  /// Hours after a ticket sits in `open` (no asker reply) before the
  /// auto-escalate walker flips it to `escalated`. `0` disables.
  autoEscalateOpenAfterHours: number;
  /// When an admin replies on a ticket, flip the ticket to `escalated`.
  /// Default `true` — the agent is no longer the sole driver. Set
  /// `false` if your admins want to leave commentary on resolved threads
  /// without re-opening them.
  escalateOnAdminReply: boolean;
  /// When `claude -p` crashes mid-turn, flip the ticket to `escalated`
  /// so the admin notices. Default `true`. Set `false` for diagnostic
  /// mode — leaves the ticket in `agent-responding` so crash patterns
  /// stay legible.
  escalateOnAgentCrash: boolean;
}

export interface OpenitConfig {
  ticketLifecycle: TicketLifecycleConfig;
}

export const DEFAULT_TICKET_LIFECYCLE: TicketLifecycleConfig = {
  autoCloseResolvedAfterHours: 24,
  autoEscalateOpenAfterHours: 24,
  escalateOnAdminReply: true,
  escalateOnAgentCrash: true,
};

export const DEFAULT_OPENIT_CONFIG: OpenitConfig = {
  ticketLifecycle: { ...DEFAULT_TICKET_LIFECYCLE },
};

/// Merge a partial config payload (JSON parsed straight off disk) onto
/// the defaults. Per-field merge — a missing field falls through to its
/// default; a present field with the wrong type also falls through (we
/// don't trust user-edited JSON to be well-typed).
export function mergeOpenitConfig(
  raw: unknown,
): OpenitConfig {
  const out: OpenitConfig = {
    ticketLifecycle: { ...DEFAULT_TICKET_LIFECYCLE },
  };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const tl = r.ticketLifecycle;
  if (tl && typeof tl === "object") {
    const t = tl as Record<string, unknown>;
    if (typeof t.autoCloseResolvedAfterHours === "number" && Number.isFinite(t.autoCloseResolvedAfterHours)) {
      out.ticketLifecycle.autoCloseResolvedAfterHours = Math.max(0, t.autoCloseResolvedAfterHours);
    }
    if (typeof t.autoEscalateOpenAfterHours === "number" && Number.isFinite(t.autoEscalateOpenAfterHours)) {
      out.ticketLifecycle.autoEscalateOpenAfterHours = Math.max(0, t.autoEscalateOpenAfterHours);
    }
    if (typeof t.escalateOnAdminReply === "boolean") {
      out.ticketLifecycle.escalateOnAdminReply = t.escalateOnAdminReply;
    }
    if (typeof t.escalateOnAgentCrash === "boolean") {
      out.ticketLifecycle.escalateOnAgentCrash = t.escalateOnAgentCrash;
    }
  }
  return out;
}

/// Load `.openit/config.json`. Missing file → defaults. Parse error →
/// console.warn + defaults. Never throws — config is not load-bearing,
/// the lifecycle paths must keep working even when the file is broken.
export async function loadOpenitConfig(repo: string): Promise<OpenitConfig> {
  try {
    const raw = await fsRead(`${repo}/.openit/config.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn(
        `[openit-config] failed to parse .openit/config.json (${String(e)}); using defaults`,
      );
      return { ticketLifecycle: { ...DEFAULT_TICKET_LIFECYCLE } };
    }
    return mergeOpenitConfig(parsed);
  } catch {
    // No file (or fs error) → defaults.
    return { ticketLifecycle: { ...DEFAULT_TICKET_LIFECYCLE } };
  }
}
