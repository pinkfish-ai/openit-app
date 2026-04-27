---
name: triage
description: Handle a new support question. Log the ticket, check the knowledge base, answer if found, escalate if not. The triage flow Claude runs as the openit-triage agent.
---

## When to use

Invoked when the user sends a support question — *"my VPN is broken"*, *"how do I get access to the staging GCP project?"*, *"alice can't log in"*. Either via `/triage <question>` or implicitly (CLAUDE.md tells you to behave as the triage agent for incoming support questions). Also invoked by the **incoming-ticket banner** when a row appears with `status: "incoming"` from a future intake channel.

## What to do

The triage agent's instructions live at `agents/openit-triage-<slug>.json`. **Read it once at the start of the loop** — the file is the source of truth for what the agent does. CLAUDE.md gives you the local-runtime mapping for the agent's intent steps (where files live, what tools to use). The skill body below is a quick reference.

### Step 1 — Log the ticket

A ticket exists for every incoming question. Even when you can answer instantly, log it — the audit trail matters.

- Find the project slug: look at the directory name `databases/openit-tickets-<slug>/`.
- Generate a ticket id: `ticket-<unix-timestamp-ms>-<4-char-rand>` (e.g. `ticket-1777234492000-x9q1`).
- Read `databases/openit-tickets-<slug>/_schema.json` once to confirm field IDs (they're plain language: `subject`, `description`, `asker`, `status`, etc.).
- `Write` a JSON file at `databases/openit-tickets-<slug>/<ticket-id>.json`:

  ```json
  {
    "subject":     "<short summary of the question>",
    "description": "<full text of what the user asked>",
    "asker":       "<name or email if known; 'unknown' if not>",
    "askerChannel":"openit",
    "status":      "open",
    "priority":    "normal",
    "tags":        [],
    "createdAt":   "<ISO-8601 timestamp now>",
    "updatedAt":   "<same as createdAt>"
  }
  ```

- Log the user's first turn as a conversation row: `Write` to `databases/openit-conversations-<slug>/msg-<timestamp>-<rand>.json`:

  ```json
  {
    "id":        "msg-<timestamp>-<rand>",
    "ticketId":  "<the ticket id>",
    "role":      "asker",
    "sender":    "<asker>",
    "timestamp": "<ISO-8601>",
    "body":      "<the user's question>"
  }
  ```

### Step 2 — Search the knowledge base

`Glob "knowledge-base/*.md"`. Read the filenames first — they're often enough to identify candidates. Read the top 3–5 likely matches (filename + headings + first paragraph).

When evaluating relevance, prefer specific over general. *"how-to-reset-vpn-password.md"* is a better match for *"VPN broken"* than *"general-troubleshooting.md"*.

### Step 3a — KB has a confident answer

- Write a clear, concise reply to the user. Lead with the answer, then any context the KB article gives.
- `Edit` the ticket row: set `status: "answered"`, append the cited filenames to `kbArticleRefs`, update `updatedAt`.
- `Write` your reply as a conversation turn: `role: "agent"`, `sender: "openit-triage"`.
- Surface the reply in the chat for the admin to send to the user (until cloud channel ingest does this automatically).

### Step 3b — KB doesn't have a confident answer

- Reply: *"I don't have an answer for that yet — I've logged your question and an admin will follow up."*
- Leave the ticket as `status: "open"` (NOT `"answered"`). The escalated-ticket banner will surface this to the admin.
- `Write` your reply as a conversation turn: `role: "agent"`, `sender: "openit-triage"`.

### Step 4 — Tell me what happened

Brief summary in the chat:

```
Logged ticket ticket-XXX (subject: "VPN broken").
Searched the KB — no confident match.
Replied to the user: "I've logged your question, an admin will follow up."
Ticket status: open. Escalated for admin review.
```

If you found an answer, include the cited filenames and the reply text. If not, say so.

## Rules

- **Never invent answers.** If the KB doesn't know, escalate. Don't guess.
- **Always log, always reply.** No silent drops. Even on KB miss, the user gets *some* response.
- **Be concise.** Lead with the answer or next step, then context.
- If the question is unclear, ask ONE clarifying question first. Once you have an answer to the clarifying question, log the ticket — don't go through multiple back-and-forths before logging.
- **Use plain timestamps.** ISO-8601 with `Z` for UTC (`2026-04-27T09:14:02Z`).
- **No gateway calls** for own-data operations. Use `Read` / `Write` / `Edit` directly. The gateway is for connected third-party systems and is only available when cloud is connected.

## Edge cases

- **Asker not identifiable.** Set `asker: "unknown"`. The admin can fix it later.
- **Multiple questions in one message.** Log one ticket per question. Be explicit when replying that you're treating them separately.
- **The user is asking about ticket-management itself** (e.g. *"how do I close a ticket?"*) — that's a meta-question, not a support ticket. Answer directly without going through the triage flow.
- **Existing ticket follow-up.** If the user is replying to an existing ticket (e.g. references a ticket id, or the conversation is clearly part of an open thread), don't create a new ticket. Append a conversation turn to the existing one.
