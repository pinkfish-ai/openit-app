# Ticket Statuses

## In simple terms

A ticket moves through six states: **incoming → agent-responding → open → escalated → resolved → closed**. Most tickets only see three or four of those — incoming/agent-responding/open is the "agent is working" phase, resolved is "answered", closed is "archived".

The `status` field is an enum on the tickets schema (`scripts/openit-plugin/schemas/tickets._schema.json`). It drives the inbox tab strip, the ticket banner state, and a few activity-rail behaviors. Always one of these six values.

---

## The states

| Status | What it means | Who sets it |
|---|---|---|
| `incoming` | Just landed in the chat-intake server. Server hasn't kicked off the agent yet. **Transient** — should flip to `agent-responding` within a second or two. | Chat-intake on first turn. |
| `agent-responding` | A `claude -p` subprocess is actively running this turn. The activity banner only fires in this state. | Chat-intake while the subprocess runs. |
| `open` | Agent finished its turn (KB hit, replied to asker). Conversation alive, agent idle waiting for the asker's next message. No banner. | Chat-intake at end-of-turn. |
| `escalated` | KB miss / agent gave up. Escalated banner fires for the admin. The "answer-ticket" workflow takes over from here. | Agent on KB miss. |
| `resolved` | Asker's question fully answered, conversation done. Reopenable — if the asker pings again, it goes back to `agent-responding`. | Admin (or explicit confirmation flow). |
| `closed` | No further action. Archived. Off the active list. | Admin (manual today; auto-close worker is a future option). |

---

## Resolved vs closed

Two terminal states, easy to confuse. The distinction matters because they answer different questions:

- **`resolved`** — *"is the asker satisfied?"* Set when we believe the answer landed and the thread is done. Soft terminal — if the asker comes back and says "still broken", they reopen this ticket; the same thread continues.
- **`closed`** — *"is this ticket archived?"* Hard terminal. The thread is done with from a workflow perspective. To pick it back up later, file a new ticket.

In practice, the lifecycle is `resolved` → admin or system flips it to `closed` after some quiet period. The `closed` tab is "old tickets I might want to search" — out of the way of active work.

---

## How this compares to industry norms

Most IT helpdesks (Zendesk, ServiceNow, Jira Service Desk, Freshdesk) converge on roughly the same six-state shape:

| Industry term | OpenIT equivalent |
|---|---|
| New / Submitted | `incoming` |
| In Progress / Working | `agent-responding` |
| Open / Awaiting reply | `open` |
| Pending / On Hold | (we don't have this — covered by `open` waiting for asker) |
| Escalated / Triaged | `escalated` |
| Solved / Resolved | `resolved` |
| Closed / Archived | `closed` |

The two patterns we don't replicate:

- **Pending / On Hold** — explicit "waiting on customer reply" or "blocked on external dependency". We collapse this into `open`. If a backlog ever needs that distinction, it's an enum addition, not a workflow rewrite.
- **Auto-close after N days of inactivity** — the most common pattern (Zendesk auto-closes solved tickets after 4 days; ServiceNow defaults to 7). Without an auto-close worker, `closed` is admin-only and tends to get neglected. If we ship one, the resolved → closed transition stops being a manual step.

---

## UI surface (today)

The inbox tab strip filters by status. As of 2026-04-30 it shows: **All / Open / Resolved / Escalated**. There's no Closed tab. A `closed` ticket lands in **All** only.

Two reasonable directions when this gets revisited:

1. **Add a Closed tab.** Matches industry. Closed tickets stay searchable but out of active view.
2. **Drop `closed` from the schema.** If we never build auto-close and admins don't manually close, the state is dead weight. `resolved` is the only real terminal state.

Either is consistent. Picking depends on whether multi-week archival is a workflow we want to support.

---

## Related

- Schema: `scripts/openit-plugin/schemas/tickets._schema.json`
- Sample data: `scripts/openit-plugin/seed/tickets/sample-ticket-*.json`
- Inbox UI tabs: search the codebase for `Inbox` / `TicketTabs` (subject to refactor — don't rely on a specific path here)
- Activity banner state machine: tied to `agent-responding` and `escalated` only — those are the two states the admin gets a notification for.
