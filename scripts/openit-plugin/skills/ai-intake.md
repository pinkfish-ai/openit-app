---
name: ai-intake
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

### 3. Decide the status

**Do NOT write any conversation turn files, and do NOT Edit the ticket's `status` field.** The server handles both writes — it wrote the asker turn before invoking you, will write your reply turn from stdout, and will set status from the marker you emit. Editing status yourself races against the server and may be clobbered.

Decide one of:

- **`resolved`** — KB hit, you confidently answered. (You may Edit `kbArticleRefs` to append cited filenames; that field doesn't race.)
- **`escalated`** — KB miss, or the question needs a human. Reply text: something like *"Thanks — I don't have a definitive answer yet. I've escalated this to the team; someone will follow up here when they're ready."*
- **`clarifying`** — you need one more piece of info before deciding ("can you tell me which system?"). Reply with the question; the ticket stays at `agent-responding`.

### 4. End with reply text + status marker

Your stdout shape:

```
<your conversational reply to the user>

<<STATUS:resolved>>
```

Replace `resolved` with `escalated` or `clarifying` per step 3. The server strips the marker before writing the turn, then sets ticket status. Missing or malformed marker → defaults to `escalated`, so the admin always sees a borked agent run.

Keep the reply conversational — no file paths, no status narration, no meta-commentary.

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
