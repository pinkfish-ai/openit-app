# 2026-04-26 — Escalated ticket banner (Phase B)

**Status:** Draft. Stacks on `feat/triage-agent-bootstrap` (Phase A).

## Why

Phase A creates the triage agent and the ticket flow. When the agent escalates a ticket (KB doesn't have an answer), the ticket sits as a JSON file with `status: "open"` and there's no signal to the IT admin that something needs attention — they'd have to remember to look in `databases/openit-tickets-<orgId>/` themselves.

Phase B closes the loop: a banner at the top of OpenIT, parallel to the conflict banner, says *"N escalated ticket(s)"* with a **Solve with Claude** button. Clicking it pastes a prompt into the active Claude session that walks Claude through reading the ticket, drafting a reply, and capturing the answer as a KB article so the next identical question gets answered automatically. **Answer once.**

## What

Three pieces:

1. **Detection** (`src/lib/ticketStatus.ts` or similar): walk `databases/openit-tickets-*/` files on the fs-tick interval; parse each, identify ones with an open/escalated status. Emit via a subscribe-style API mirroring `subscribeConflicts`.

2. **Banner component** (`src/shell/EscalatedTicketBanner.tsx`): subscribes to (1), renders a single line at the top of the shell when count > 0, has a "Solve with Claude" button that pastes the prompt and a "Dismiss" button (with the same `refreshTick` reset semantic the conflict banner has).

3. **Skill** (`scripts/openit-plugin/skills/answer-ticket.md`): the prompt body. Walks Claude through:
   - Read the ticket JSON.
   - Read `databases/openit-tickets-*/_schema.json` to map field IDs to human labels.
   - Draft a reply with the user.
   - Reply to the ticket's user via the channel field (TBD — for V1, just print the reply for the admin to send manually).
   - Update the ticket row: status=`answered`, add the answer text.
   - Offer to capture the answer as a KB article in `knowledge-base/`. Default yes — that's the "answer once" principle.

## Detecting escalated status

The ticket schema comes from the `case-management` template. Field IDs are opaque (`f_1`, `f_2`, …). To know which field carries status, the helper reads `_schema.json` for the collection and looks for a field whose label/name matches `status` (case-insensitive). Falls back to scanning every string field for value `"open"` if no schema field is named status.

Open / escalated detection:

- Field labelled `status` (or matches a small allowlist: `status`, `state`, `ticket_status`) with value matching `open`, `escalated`, `needs-human`, or `pending` (case-insensitive).
- A separate boolean field whose label contains `escalat` set to `true`.

Both branches; the helper returns true on either match.

## Banner UX

```
⚠  3 escalated ticket(s) need a human.    [Solve with Claude]   [Dismiss]
```

Click "Solve with Claude" → pastes:

```
/answer-ticket

Tickets:
- databases/openit-tickets-XXX/row-1234.json
- databases/openit-tickets-XXX/row-5678.json
- databases/openit-tickets-XXX/row-9012.json
```

The skill body handles the rest. Same lean-prompt pattern as the conflict banner: standing logic in the skill, banner just lists the targets.

## Implementation plan

1. **`src/lib/ticketStatus.ts`** — exports:
   - `subscribeEscalatedTickets(fn)` — same shape as `subscribeConflicts`.
   - `refreshEscalatedTickets(repo)` — recompute from disk; called on `fsTick` change in Shell.
   - Internal: walks `databases/openit-tickets-*/` dirs, parses JSONs, classifies, emits.
2. **`src/shell/EscalatedTicketBanner.tsx`** — banner. Mirrors `ConflictBanner.tsx` (refreshTick prop for dismiss-clear, paste-into-active-session via bracketed escapes).
3. **`src/shell/Shell.tsx`** — mount the new banner near the existing one. Wire up the `fsTick` → `refreshEscalatedTickets(repo)` on change.
4. **`scripts/openit-plugin/skills/answer-ticket.md`** — the skill content.
5. **`scripts/openit-plugin/CLAUDE.md`** — add `answer-ticket` to the Skills table.
6. **`web/.../openit-plugin/`** — copy skill, bump manifest, add to files list (for future deploys, doesn't block this PR).

## Tests

- Unit tests for `ticketStatus`:
  - Schema-aware detection: status field labelled "status" with value "open" → counted.
  - Schema-aware detection: status field with value "answered" → not counted.
  - Fallback: no labelled status field, but JSON contains `"status": "open"` somewhere → counted.
  - Missing `_schema.json` → graceful degrade to fallback only.
  - Empty datastore dir → 0.
- Component test for the banner is harder without rendering; skip in V1.

## Out of scope

- **Sending the reply to the user** via Slack/email. Phase D (channel ingest) wires both directions; for V1 the admin copies the drafted reply manually.
- **Workflow capture** for action-shaped tickets — Phase C.
- **Closing the ticket on the user's side** if they have an external channel. Same Phase D dependency.
