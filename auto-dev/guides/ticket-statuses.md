# Ticket Statuses

## In simple terms

A ticket moves through five states: **agent-responding → open → escalated → resolved → closed**. Most tickets only see three or four of those — `agent-responding`/`open` is the "agent is working" phase, `resolved` is "answered", `closed` is "archived".

The `status` field is an enum on the tickets schema (`scripts/openit-plugin/schemas/tickets._schema.json`). It drives the inbox tab strip, the ticket banner state, and a few activity-rail behaviors. Always one of these five values.

> **Note (PIN-5864):** the schema previously had a sixth value, `incoming`, intended as the transient "just landed, agent hasn't started" state. No code path ever set it — first-turn ticket creation went straight to `agent-responding`. Removed in PIN-5864 as dead value.

---

## The states

| Status | What it means | Who sets it |
|---|---|---|
| `agent-responding` | A `claude -p` subprocess is actively running this turn (or about to). The activity banner only fires in this state. Set on first ticket creation and on every follow-up turn before the subprocess runs. | `intake.rs:1819` (first creation), `intake.rs:1867` (follow-up turns). |
| `open` | Agent finished its turn (KB hit, replied to asker). Conversation alive, agent idle waiting for the asker's next message. No banner. | `intake.rs:715` — agent's `<<STATUS:answered>>` outcome. |
| `escalated` | Admin needs to look at this. **Four trigger paths** (see below). Escalated banner fires for the admin. | Multiple — see "Escalation triggers" table. |
| `resolved` | Asker's question fully answered, conversation done. Reopenable — a follow-up asker turn flips back to `agent-responding` and the agent re-decides. | `intake.rs:719` (agent `<<STATUS:resolved>>`), `Viewer.tsx:1954` ("Mark as resolved" admin button). |
| `closed` | No further action. Archived. Off the active list. | `entityRouting.ts` auto-close walker — `resolved` for >24h (configurable). |

---

## Escalation triggers (all four)

Any of these sets `status = "escalated"`:

| Trigger | Where | Default | Tunable via `.openit/config.json` |
|---|---|---|---|
| Agent emits `<<STATUS:escalated>>` (KB miss / agent gave up) | `intake.rs:723` | always on | not configurable — agent's call, no point gating |
| `claude -p` subprocess crashed mid-turn | `intake.rs` agent-crash branch | always on | `escalateOnAgentCrash` (set `false` to leave crashed tickets in `agent-responding` for diagnosis) |
| Admin replies on the ticket — agent is no longer the sole driver | `Viewer.tsx` reply path | always on | `escalateOnAdminReply` (set `false` to allow admin commentary on resolved threads without re-opening) |
| Ticket sat in `open` past stale-window — agent effectively stalled waiting for the asker | `entityRouting.ts` auto-escalate walker | 24h | `autoEscalateOpenAfterHours` (`0` disables) |

---

## Resolved vs closed

Two terminal states, easy to confuse. The distinction matters because they answer different questions:

- **`resolved`** — *"is the asker satisfied?"* Set when we believe the answer landed and the thread is done. Soft terminal — if the asker comes back and says "still broken", they reopen this ticket; the same thread continues.
- **`closed`** — *"is this ticket archived?"* Hard terminal. The thread is done with from a workflow perspective. To pick it back up later, file a new ticket.

The transition `resolved → closed` is automated by the auto-close walker in `entityRouting.ts`: any ticket with `status: "resolved"` whose `updatedAt` is older than `autoCloseResolvedAfterHours` (default 24) gets flipped on next render of the conversations list. Tagged `auto-closed` so the audit trail is visible.

---

## `.openit/config.json` — admin-tunable knobs

A `.openit/config.json` with the default values is written on first project bootstrap so the file is discoverable in the explorer. Edit it to override; missing fields fall through to their compiled-in defaults so a partial file is fine. Subsequent bootstraps do not overwrite — admin edits survive app launches.

```json
{
  "ticketLifecycle": {
    "autoCloseResolvedAfterHours": 24,
    "autoEscalateOpenAfterHours": 24,
    "escalateOnAdminReply": true,
    "escalateOnAgentCrash": true
  }
}
```

| Field | Default | Effect |
|---|---|---|
| `autoCloseResolvedAfterHours` | `24` | Hours on `resolved` before auto-close walker flips to `closed`. `0` disables. |
| `autoEscalateOpenAfterHours` | `24` | Hours on `open` (no asker reply) before auto-escalate walker flips to `escalated`. `0` disables. |
| `escalateOnAdminReply` | `true` | Admin reply flips ticket to `escalated`. Set `false` for resolved-thread commentary without re-opening. |
| `escalateOnAgentCrash` | `true` | `claude -p` crash flips ticket to `escalated`. Set `false` for diagnostic mode (crashed tickets stay in `agent-responding`). |

The file is local-only state — not synced to Pinkfish. Persists across plugin syncs.

Both walkers run **passive-on-view**: they fire when the conversations list is rendered, not on a background timer. An admin who never opens the conversations list won't see transitions happen — same limitation the auto-escalate walker has had since it shipped. Trade-off: simpler architecture, no scheduler to manage; admins should expect transitions to happen "next time you open the inbox".

---

## How this compares to industry norms

Most IT helpdesks (Zendesk, ServiceNow, Jira Service Desk, Freshdesk) converge on roughly the same shape:

| Industry term | OpenIT equivalent |
|---|---|
| New / Submitted | (no separate state — first turn writes `agent-responding`) |
| In Progress / Working | `agent-responding` |
| Open / Awaiting reply | `open` |
| Pending / On Hold | (we don't have this — covered by `open` waiting for asker) |
| Escalated / Triaged | `escalated` |
| Solved / Resolved | `resolved` |
| Closed / Archived | `closed` |

The pattern we don't replicate:

- **Pending / On Hold** — explicit "waiting on customer reply" or "blocked on external dependency". We collapse this into `open`. If a backlog ever needs that distinction, it's an enum addition, not a workflow rewrite.

The auto-close-after-N-days pattern is now in (default 24h, configurable). Industry defaults vary: Zendesk auto-closes solved tickets after 4 days, ServiceNow defaults to 7. We chose 24h because OpenIT's chat-intake loop is short-cycle — a typical thread resolves in minutes, and stale-resolved tickets pile up fast without aggressive close.

---

## UI surface (today)

The inbox tab strip filters by status. As of 2026-04-30 it shows: **All / Open / Resolved / Escalated**. There's no Closed tab. A `closed` ticket lands in **All** only.

Decision deferred: whether to add a Closed tab. Industry norm is yes (closed tickets stay searchable but out of active view). Skipped for the PIN-5864 scope — purely a UX call.

---

## Related

- Schema: `scripts/openit-plugin/schemas/tickets._schema.json`
- Sample data: `scripts/openit-plugin/seed/tickets/sample-ticket-*.json`
- Auto-escalate / auto-close walkers: `src/shell/entityRouting.ts` (search for `autoEscalateOpenAfterHours` / `autoCloseResolvedAfterHours`)
- Status setters: `src-tauri/src/intake.rs` (`mark_status`), `src/shell/Viewer.tsx` (admin reply + Mark-as-resolved)
- Config loader: `src/lib/openitConfig.ts` (TS), `src-tauri/src/openit_config.rs` (Rust)
- Activity banner state machine: tied to `agent-responding` and `escalated` only — those are the two states the admin gets a notification for.
