---
name: intake-chat
description: Per-turn helpdesk responder for the localhost chat intake. Reads the conversation context, searches the knowledge base, and writes either an answer (KB hit → status `resolved`) or an escalation reply (KB miss → status `escalated`). The ticket, asker turn, and people row are pre-written by the server before this skill runs.
---

## Context

This skill runs inside a `claude -p` subprocess spawned by OpenIT's chat-intake server, once per chat turn. The chat is a long-lived surface — the user can keep messaging after their initial question, follow up with new info, ask a different question entirely, or react to your reply.

The prompt you receive includes:

- The persona block from `agents/triage.json`.
- An **operational context block** with the asker's email and the ticket id for this conversation.
- The conversation history so far (one ticket per session — never create a second).
- The user's new message.

## What's already done

The intake server (Rust) has already done these writes before invoking you, on every turn:

- **Ticket file** at `databases/tickets/<ticketId>.json` — created on first turn (subject, description, asker, askerChannel, priority, tags, createdAt, updatedAt). On every subsequent turn, status is flipped back to `agent-responding` so the admin's activity banner fires.
- **Asker turn** at `databases/conversations/<ticketId>/msg-<unix-ms>-<rand>.json` — for the user's most recent message.
- **People row** at `databases/people/<sanitized-email>.json` — idempotent.

The server will ALSO write your agent reply turn after you finish, taking your stdout as the body and hardcoding `sender: "triage"`. **Do not write any msg-*.json files yourself** — they'll appear duplicated in the admin UI. Your only file write is the ticket status `Edit`.

## Your steps

### 1. Read context

- `Read` the ticket at `databases/tickets/<ticketId>.json`.
- `Glob "databases/conversations/<ticketId>/msg-*.json"`, `Read` each, sort by timestamp. This is the canonical conversation thread (the in-memory history in your prompt is correct but disk is the source of truth).

### 2. Search the knowledge base

```bash
node .claude/scripts/kb-search.mjs "<query summarizing the user's current question>"
```

Output:

```json
{ "matches": [{ "path": "knowledge-base/foo.md", "score": 0.83, "snippet": "..." }, …] }
```

If the top match has `score > 0.5`, `Read` it and judge whether it actually answers the user's question. (Score alone isn't enough — word overlap can score high without being relevant.)

Re-search on every substantive user turn. If a follow-up gives you new info ("oh it's only the VPN, not email"), the new search may hit where the prior didn't — which means the ticket can transition from `escalated` back to `resolved`.

### 3. Update ticket status

**Do NOT write any conversation turn files.** The server already wrote the asker turn before invoking you, and it will write your agent reply turn from your stdout after you finish. Writing a turn yourself causes duplicates in the admin UI.

Your only file write is `Edit`-ing the ticket at `databases/tickets/<ticketId>.json`:

**3a. KB has a confident answer** — `status: "answered"`, append cited filename(s) to `kbArticleRefs`, bump `updatedAt`. Your reply text leads with the answer and cites the article casually ("Per our VPN guide, you can…").

**3b. KB has no confident answer — escalate** — `status: "escalated"`, bump `updatedAt`. Your reply text: *"Thanks — I don't have a definitive answer yet. I've escalated this to the team; someone will follow up here when they're ready."* (Adjust to the situation.)

**3c. Conversational holding turn (mid-clarification)** — if the user's message is too vague to KB-search or you need one more piece of info ("can you tell me which system?"), reply with the clarifying question and leave the ticket as `agent-responding` (Edit it explicitly back to that status so `updatedAt` bumps). Don't escalate yet — you're still working on it.

### 4. End your output with the reply text

The last thing in your stdout becomes the user's chat bubble (the server reads stdout and writes it as the agent turn with sender `triage`). Don't narrate the file writes — just the conversational reply.

## Conversation conventions

Conversation turns are unstructured rows under `databases/conversations/<ticketId>/`. Field shape:

```json
{
  "id":         "msg-<unix-ms>-<4-char-rand>",
  "ticketId":   "<ticketId>",
  "role":       "asker" | "agent" | "admin",
  "sender":     "<email for asker, 'triage' for agent, admin's name for admin>",
  "timestamp":  "<ISO-8601 UTC e.g. 2026-04-27T09:14:02Z>",
  "body":       "<message text>"
}
```

Generate timestamps as `date -u '+%Y-%m-%dT%H:%M:%SZ'` via Bash if you don't have one handy.

## Idempotency

If the ticket is already in a terminal state (`resolved` or `closed`) and the user sends a follow-up, treat it as a new conversational moment within the same ticket — log your reply turn, but don't write the ticket back to `agent-responding`. They've reopened the conversation but not necessarily reopened the case. Use judgment; if it's clearly a new escalation, set status back to `escalated`.

## Rules

- **Never invent answers.** If the KB doesn't know, escalate.
- **Sender for agent turns**: always `"triage"`. (Future: per-agent customization; for now hardcode.)
- **One ticket per session.** All turns from this user attach to the same `ticketId`. Even if they ask a new question mid-conversation, append it as another asker → agent exchange on the same ticket.
- **Use ISO-8601 UTC timestamps** with the `Z` suffix.
