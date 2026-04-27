# Auto-triage on intake — plan

**Goal**: every ticket that arrives via form (today) or chat (new) gets auto-handled by an agent before the admin ever sees it. The admin only sees tickets the agent escalated. No manual "triage in Claude" button click for the common case.

**Non-goals (V1)**: emailing the agent's reply back to the asker (the form submitter). Status feedback to the form user is a thank-you page only; email response is a future channel.

---

## State machine

Status enum simplifies to **3 active states + 2 terminal**:

| Status | Meaning | Who sets it |
|---|---|---|
| `incoming` | Just landed, agent hasn't run yet. **Transient** — should only persist if the app was killed mid-triage. | Intake (form/chat) |
| `answered` | Agent found a confident KB answer and replied. The asker has their answer. | Triage agent (KB hit) |
| `escalated` | Agent gave up, admin needs to handle. **Banner fires only on this.** | Triage agent (KB miss) |
| `resolved` | Admin (or asker confirmation) marked it done. | Admin via `/answer-ticket` |
| `closed` | No further action expected (won't-fix, duplicate, spam). | Admin |

Schema enum changes from `[incoming, open, answered, resolved, closed]` → `[incoming, answered, escalated, resolved, closed]`. The word "open" is dropped from the enum (it was ambiguous — meant "not resolved" colloquially). When admins say "open tickets" they mean `incoming | escalated`.

### Transitions

```
intake → incoming
incoming → answered    (agent KB hit)
incoming → escalated   (agent KB miss)
escalated → resolved   (admin handled, asker satisfied)
escalated → closed     (admin won't-fix / duplicate)
answered  → resolved   (asker confirmed fix; future, optional)
```

Banner trigger: `status === "escalated"`. Clears when admin moves it elsewhere.

---

## Component: the headless triage runner

Crux: when no admin chat session is open (form submitted at 3am), how does the agent run?

**Decision: spawn `claude -p` as a subprocess per ticket.** Each invocation is a fresh, isolated Claude run — context lives on disk in the ticket + conversation files. Subprocess writes the agent's turn + flips status, exits.

**Precedent**: `claudeGenerateCommitMessage` already spawns `claude -p` for commit messages. Same pattern.

### `triage_run` Tauri command (Rust)

```rust
#[tauri::command]
pub async fn triage_run(repo: String, ticket_id: String) -> Result<(), String> {
    let cmd = tokio::process::Command::new("claude")
        .arg("-p")
        .arg(format!("/triage databases/tickets/{}.json", ticket_id))
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn claude: {}", e))?;
    // tokio::spawn — fire and forget. Stream stdout/stderr to a Tauri
    // event so the admin can see triage activity in a debug log.
    tokio::spawn(async move {
        let _ = stream_to_event(cmd, "triage://output").await;
    });
    Ok(())
}
```

- `cwd = repo` so Claude finds `.claude/skills/triage/SKILL.md` and `agents/triage.json`
- `-p` invokes Claude in headless print mode
- Subprocess output streamed to a `triage://output` Tauri event (admin can subscribe to a "background activity" log; V2 surfaces it in UI)
- Authentication: relies on the user's local `claude` CLI auth (same as commit-message generation)

### When does triage_run fire?

Three trigger paths, all converging on the same Rust function:

1. **Form submission** (intake.rs): after writing ticket + asker turn + people row, fire `triage_run` as a fire-and-forget tokio task. Form returns thank-you page immediately; agent runs in background.
2. **Chat commit** (Phase B chat intake): when the chat-intake skill commits the ticket file, fire `triage_run`.
3. **App launch catch-up** (App.tsx startup): after bundled-files-on-disk check, scan `databases/tickets/` for any `status: "incoming"` tickets and fire `triage_run` on each. Handles the case where the app was killed mid-triage.

---

## Phase A — form auto-triage

### Scope

- New Rust `triage_run` command + helper to share between intake.rs and the catch-up scan
- intake.rs fires `triage_run` after the existing writes
- App.tsx startup runs catch-up scan
- IncomingTicketBanner → EscalatedTicketBanner (filter `status === "escalated"`, paste `/answer-ticket` not `/triage`)
- Schema enum updated (`open` → `escalated`); CLAUDE.md, triage.md, answer-ticket.md, agent template all reference the new value
- Form thank-you page wording: "Thanks — your ticket is in. We'll get back to you." Drops the implication that the user should refresh / wait.

### Files

| File | Change |
|---|---|
| `src-tauri/src/triage.rs` | New module — `triage_run` command + `spawn_triage(repo, ticket_id)` helper |
| `src-tauri/src/lib.rs` | Register new module + commands |
| `src-tauri/src/intake.rs` | After writes, call `spawn_triage(&state.repo, &id)` |
| `scripts/openit-plugin/schemas/tickets._schema.json` | enum: replace `open` with `escalated` |
| `scripts/openit-plugin/agents/triage.template.json` | "If KB has no confident answer → set `status: 'escalated'`" |
| `scripts/openit-plugin/skills/triage.md` | Same |
| `scripts/openit-plugin/skills/answer-ticket.md` | Reads `escalated` tickets; sets `resolved` on completion |
| `scripts/openit-plugin/CLAUDE.md` | Status table updated |
| `src/lib/incomingTickets.ts` → rename `escalatedTickets.ts` | Filter `status === "escalated"` |
| `src/shell/IncomingTicketBanner.tsx` → `EscalatedTicketBanner.tsx` | Click → paste `/answer-ticket <path>` (not `/triage`) |
| `src/App.tsx` startup | New: scan + fire catch-up triage on `incoming` tickets |
| `src/lib/api.ts` | `triageRun(repo, ticketId)` wrapper |

### Tests

- `triage::tests::spawn_triage_invokes_claude` — mock `claude` binary, verify args + cwd
- intake POST tests — verify `triage_run` is called after the writes (mock the spawn)
- Catch-up scan: tempdir with 3 mock incoming tickets, verify all get triaged

---

## Phase B — chat intake

### UX

- New page at `localhost:<port>/chat`
- Coworker types into a chat box, agent responds (gathering name → email → question, or freeform)
- Once agent has enough, it commits the ticket file + fires the same auto-triage
- The chat surface stays open after commit so the user can see the agent's resolution (if KB hit) or the "I've escalated this" message (if KB miss)

### Backend

- New axum routes:
  - `GET /chat` — single-page HTML
  - `POST /chat/turn` — `{ sessionId, message }` → `{ reply, ticketId? }`
- In-memory `Map<sessionId, Vec<Turn>>` (no persistence — chat session dies with browser tab)
- Per turn: spawn `claude -p` with prompt that includes:
  - The conversation so far (system prompt + user/assistant turns)
  - The `intake-chat` skill body
  - The new user message
- Skill body: "Gather name + email + question conversationally. When you have all three, write the ticket file at `databases/tickets/<id>.json`, write the asker's first turn at `databases/conversations/<id>/msg-...json`, write the people row at `databases/people/<sanitized-email>.json`, then return the ticket ID in your final message wrapped in `<ticket-committed>...</ticket-committed>` tags."
- Backend parses the final message: if it contains `<ticket-committed>`, extract the ID, fire `triage_run`, return reply minus the tag.

### Files

| File | Change |
|---|---|
| `src-tauri/src/intake.rs` | Add `/chat` GET + `/chat/turn` POST routes; in-memory session map; per-turn `claude -p` spawn |
| `scripts/openit-plugin/skills/intake-chat.md` | New skill — chat-intake gather logic |
| Form HTML | Add link "or chat with us" → `/chat` |

### Tradeoffs

- Each turn = a fresh `claude -p` (~3-5s latency). Acceptable for V1 — typical helpdesk traffic.
- V2: long-lived agent process with a shared context (lower latency, persistent state).

---

## Phase C — V2 / future hooks

Not in V1, but the architecture should accommodate:

- **Email response on form submit**: when triage finishes (agent answers OR escalates), enqueue an outbound email to the asker's email address. Adds an "outbox" — `databases/email-outbox/<id>.json` — that an external mailer (Pinkfish cloud or local SMTP) drains.
- **Email-incoming**: an email arrives at a help@ address → cloud receives → writes a ticket file with `askerChannel: "email"` → auto-triage flows identically. Local-only mode can't do this without a cloud relay; out of scope.
- **Slack/Teams ingest**: same pattern. Channel ingestor writes the ticket; auto-triage runs.
- **Long-lived chat agent**: replace the per-turn subprocess with a single Claude that handles all chat sessions, for snappier responses.
- **Triage retry/queue**: if `claude -p` fails, retry with backoff. Today: failure leaves status `incoming`, next-launch catch-up retries.

---

## Risks & edge cases

| Risk | Mitigation |
|---|---|
| Multiple intakes in 1 second → multiple `claude -p` running concurrently | V1: accept (typical traffic is low). V2: per-repo semaphore queue. |
| `claude` binary not installed on user's machine | `claude_detect` already runs at startup. If missing, log + skip. Banner shows the ticket as `incoming` (not `escalated`) so admin sees it. V2: explicit "install Claude" CTA when triage fails for this reason. |
| Triage agent hits API rate limit | Subprocess returns non-zero exit. Ticket stays `incoming`. Catch-up scan retries on next launch. V2: in-app retry with backoff. |
| App crashes mid-triage | Tokio task dies, subprocess may be orphaned but tokio runtime drop kills it. Ticket stays `incoming`. Catch-up handles. |
| Concurrent triage on the same ticket (same launch + form submit fast double-tap) | The triage skill should idempotently no-op if `status !== "incoming"` at start. Add a guard in the skill body. |
| Agent decides to escalate but forgets to set `status: "escalated"` | Skill body is explicit. Add a unit test that mocks `claude -p` output and verifies the file ends up in `escalated`. |
| Agent writes a reply turn but doesn't update status | Same — skill needs a final consistency check. |
| KB has 1000 articles → agent times out | Lexical search is fast; reading 5 candidates is fine. V2: `kb-ask.mjs` lexical-scoring helper to narrow candidates before Claude reads. |
| Form submitter expects to see the agent's reply | V1 form thank-you page makes no promises ("we'll get back to you"). V2 email channel delivers the reply. |
| Cost — every form submission spawns a Claude call | Acceptable for V1 (low traffic). V2: rate limit + admin opt-in. |

---

## Idempotency contract for the triage skill

The skill must be safe to invoke multiple times on the same ticket:

1. **Read the ticket first.** If `status !== "incoming"`, exit immediately with no writes. ("Already triaged" log line.)
2. Read existing conversation turns under `databases/conversations/<ticketId>/`. If an `agent` turn already exists, exit.
3. Otherwise: search KB, write agent turn, update ticket status atomically (single `Edit` call to the ticket file).

This protects against:
- Double-fire on app launch + intake-time race
- Re-running triage on a ticket that was already escalated
- Accidental admin re-trigger

---

## Banner re-wire

`EscalatedTicketBanner` (renamed from IncomingTicketBanner):
- Filter: `status === "escalated"`
- Click action: paste `/answer-ticket <relPath>` to the active Claude session (not `/triage`)
- Copy: "1 ticket needs your help — <subject>"
- Existing dismiss-key + multi-ticket prompt format ports over

The `/triage` skill stays — it's used by the headless `claude -p`. The skill's "two invocation shapes" doc collapses to one (an admin manually running `/triage <path>` is rare with auto-triage; we can leave the skill general but the banner no longer invokes it).

---

## Implementation order

**Day 1 (Phase A core)**:
1. Schema + docs: enum update, CLAUDE.md/triage.md/answer-ticket.md/agent template references
2. `triage.rs` Rust module + `triage_run` command + `spawn_triage` helper
3. intake.rs fires `spawn_triage` after writes
4. Banner rewire (filter + click action + rename)
5. App.tsx catch-up scan on launch

**Day 2 (Phase A polish + tests)**:
6. Idempotency guard in triage skill
7. Tests for `triage_run` (mocked claude binary)
8. Tests for catch-up scan
9. Smoke test: form submit → ticket auto-resolves end-to-end (real Claude)

**Day 3-4 (Phase B chat intake)**:
10. axum `/chat` routes
11. `intake-chat.md` skill
12. Per-turn subprocess wiring + session state
13. Single-page chat UI HTML

---

## Open question I'm still chewing on

**Where does the `claude -p` subprocess output go?** Three options:
a. Stderr only — invisible unless admin runs the app from a terminal
b. `triage://output` Tauri event → admin can subscribe via a debug panel (V2)
c. Append to `.openit/triage.log` — visible via filesystem

Going with **(a) + (c)** for V1: stderr for development, log file for forensics. (b) is V2 polish.

---

## Bottom line

This collapses the admin's day-to-day to: the chat pane is for new questions and admin work; the banner only fires when the agent gave up. Form intake is fully autonomous. Chat intake is a guided interactive funnel that ends in the same auto-triage. Email channel slots into the same pipeline when it's ready.
