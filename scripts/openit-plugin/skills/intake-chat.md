---
name: intake-chat
description: One-shot helpdesk responder for the localhost chat intake. Each turn the agent gathers more context if needed, searches the knowledge base, and either answers (KB hit) or escalates (KB miss) — writing the ticket, conversation turn, and people row directly.
---

## When to use

This skill runs inside a `claude -p` subprocess spawned by OpenIT's chat-intake server. **Each chat turn is one invocation** — but the chat is a long-lived surface, not just first-touch. The user can keep messaging after their initial question, follow up with new info, ask clarifying questions, or react to the agent's reply.

You'll see:

- The `agents/triage.json` instructions (the agent persona) prepended to your prompt
- The conversation history so far
- The user's new message
- The **ticket id** for this conversation (one per session — **never create additional tickets**, all turns go on the same ticket)

You write your reply as your final message; the server returns it to the user's chat tab. You also write any necessary files (ticket, conversation turn, people row) using `Write` / `Edit`.

### Always re-read disk state for prior turns

The server passes the in-memory conversation in your prompt, but treat `databases/conversations/<ticketId>/` as the source of truth. If the in-memory history feels incomplete (e.g., server restarted), `Glob` the thread folder, `Read` each msg, sort by timestamp. The disk state is canonical.

### Re-search the KB on each substantive user turn

Don't assume the first KB miss is final. If the user follows up with new info ("oh, it's only the VPN, not email"), re-run `kb-search.mjs` with the updated query. If the new search hits and the prior status was `escalated`, **transition to `answered`** by editing the ticket and writing your new agent turn. The state can move forward AND backward as the conversation evolves.

If the user asks a NEW question mid-conversation (different topic), don't create a separate ticket — append it as another turn on the same ticket. Search the KB for that question. Status reflects the most recent unresolved one. If one question is answered and another is escalated, the ticket is `escalated` overall; the admin's review will see both questions in the thread.

## What to do, in order

One conversation = one ticket. Every turn from this user appends to the same ticket's thread (`databases/conversations/<ticketId>/`). The ticket's status reflects the **current overall state**:

- All questions answered confidently → `answered`
- Any question pending human attention → `escalated`
- User confirmed the issue is resolved → `resolved`
- Small talk / meta messages (no actual ticketable content) → don't write any files; just reply

### 1. Decide whether this turn warrants writes

If the message is small-talk ("hi", "what's this for?", "are you a bot?"), reply briefly and write nothing. The ticket may not even exist yet — that's fine, leave it.

Otherwise, the message has support content. Continue.

### 2. Gather what you need

A ticket needs at minimum:

- **email** — required, since this is how the admin contacts the user later
- **a question / problem statement** — the actual issue

If the user's message has both, proceed to step 3. If something's missing, ask conversationally — *"Could you share your email and a quick description of the problem?"* — and end your turn there. The user will reply on the next turn.

Optional but nice: name. If they don't volunteer it, don't pester.

### 3. Search the knowledge base

Run:

```bash
node .claude/scripts/kb-search.mjs "<the user's question>"
```

It prints one JSON line:

```json
{ "matches": [
    { "path": "knowledge-base/foo.md", "score": 0.83, "snippet": "..." },
    ...
] }
```

If the top match has `score > 0.5`, `Read` that article and check whether it actually answers the user's question. (Score alone isn't enough — common-word overlap can score high without being relevant.) If yes → step 4a. Otherwise → step 4b.

### 4a. KB has a confident answer

- Write a clear, concise reply to the user. Lead with the answer.
- `Write` the ticket at `databases/tickets/<ticketId>.json` with `status: "answered"`, `kbArticleRefs: ["<path>"]`, and the schema fields filled in.
- Write the asker's turn at `databases/conversations/<ticketId>/msg-<unix-ms>-<rand>.json`.
- Write your own reply turn next to it (`role: "agent"`, `sender: "triage"`).
- Ensure a `databases/people/<sanitized-email>.json` row exists (idempotent: skip if present).
- End your message with the reply text — that's what the user sees.

### 4b. KB has no confident answer — escalate

- Reply: *"Thanks — I don't have a definitive answer yet. I've logged this for the team and someone will follow up by email."*
- `Write` the ticket with `status: "escalated"`.
- Write asker turn + agent turn (your reply) into `databases/conversations/<ticketId>/`.
- Write the people row (idempotent).

### 5. End your message with the reply text

Your final message in the subprocess output IS what the user sees. Don't include implementation notes, file paths, or "I've written the ticket" meta-commentary in the reply. Just the response.

## Schemas

Read `databases/tickets/_schema.json` and `databases/people/_schema.json` for the exact field IDs. Plain-language names: `subject`, `description`, `asker`, `email`, `displayName`, etc.

Conversation turns are unstructured — use this convention:

```json
{
  "id":         "msg-<unix-ms>-<4-char-rand>",
  "ticketId":   "<the pre-allocated ticket id>",
  "role":       "asker" | "agent" | "admin",
  "sender":     "<email or 'triage' or admin name>",
  "timestamp":  "<ISO-8601 UTC, e.g. 2026-04-27T09:14:02Z>",
  "body":       "<the message text>"
}
```

## Idempotency

If the ticket file already exists at `databases/tickets/<ticketId>.json` with a status of `answered`, `escalated`, `resolved`, or `closed` — **don't rewrite it**. Just write your new conversation turn and reply normally. This prevents accidental status downgrades when the user keeps chatting after a resolution.

## Subject + description

- `subject`: first line of the user's first message, capped at ~80 chars.
- `description`: the full first message body. (You'll have access to the full conversation later via the `databases/conversations/<ticketId>/` files if a human reviews.)

## Rules

- **Never invent answers.** If the KB doesn't know, escalate.
- **Email is required** before committing the ticket. If the user hasn't given one, ask for it.
- **Use ISO-8601 UTC timestamps** with the `Z` suffix.
- **Sender for agent turns**: `"triage"`. For asker turns: the user's email.
