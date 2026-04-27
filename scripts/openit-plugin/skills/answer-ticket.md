---
name: answer-ticket
description: Walks the IT admin through responding to an escalated ticket — read it, draft an answer, deliver the reply, capture the answer as a KB article so the same question gets auto-answered next time. The "answer once" principle.
---

## When to use

Invoked when the admin clicks the **Solve with Claude** button on the escalated-ticket banner, or directly via `/answer-ticket <ticket-path>` for a specific ticket. The caller will name the ticket file path(s); if not, scan `databases/tickets/` for rows with `status: "escalated"` and surface them.

**Status terms used below.** `escalated` = agent gave up, admin needs to act. `open` = active conversation, agent answered last turn or admin replied last turn — waiting on asker. `resolved` = case fully closed (asker confirmed fixed, or admin marked done). After this skill runs, the ticket lands in `open` (most common — admin replied with a clarifying question or partial answer, asker may follow up) or `resolved` (admin is sure the case is finished).

## The principle — answer once

When the admin writes a reply, **capture it as a knowledge-base article in `knowledge-bases/default/`.** The next time someone asks the same question, the triage agent will answer from the KB without anyone touching it. (If the admin explicitly asks you to file the article in a custom KB collection — `knowledge-bases/<custom>/` — write it there instead. The default is `default`.)

If the ticket is action-shaped (the admin had to *do* something rather than just answer — reset a password, grant access, run a command), flag it for the admin so they're aware future automation could capture it as a workflow. **Workflows themselves are V2** — for V1, just note it.

## For each ticket, in order

### 1. Read the ticket and the conversation

- `Read` the ticket JSON at the path you were given.
- `Read` `databases/tickets/_schema.json` to refresh on field meanings (the schema's field IDs are plain language — `subject`, `description`, `status`, `asker` — so this is mostly a sanity check).
- List `databases/conversations/<ticketId>/` (the thread subfolder for this ticket), sort by `timestamp`. `Read` each turn.

### 2. Summarise it for the admin

Plain language. Show who asked, what they asked, when, and any context from the conversation thread. Quote the exact question text.

### 3. Sanity-check the KB

`Glob "knowledge-bases/**/*.md"` (covers default + any custom KBs). Read filenames. The triage agent already searched but might have missed something. Try once more with the admin's perspective on the question. If you find a match, point the admin at it: *"This article looks relevant — should I just send the user the answer from `knowledge-bases/default/how-to-reset-vpn.md`?"*

### 4. Draft a reply with the admin

Show what you'd write. Iterate with the admin until they're happy. Be concise; lead with the answer.

### 5. Deliver the reply (writing the conversation turn IS the delivery for chat-channel tickets)

How the reply reaches the asker depends on `askerChannel` (look it up on the ticket file you read in step 1):

- **`askerChannel: "chat"`** — the asker filed via the localhost OpenIT chat (the Intake link in the header). The chat UI polls `databases/conversations/<ticketId>/` for new turns and renders them automatically. **Writing the admin conversation turn in step 6 IS the reply delivery.** No copy/paste needed; the asker will see your message in their chat browser within a couple seconds. Do NOT tell the admin to manually email or Slack the asker for chat tickets — they're already wired up.
- **`askerChannel: "slack" | "teams" | "email" | "web" | "api"`** — those channels don't have egress wired up in V1. After writing the conversation turn (step 6), tell the admin to manually send the reply to the asker via that channel and note it in the conversation log. (When cloud channel ingest+egress lands in a future phase, this becomes automatic too.)

Treat the chat case as the default unless the ticket clearly says otherwise.

### 6. Update the ticket and log the conversation turn

- `Edit` the ticket:
  - `status` → `"open"` if the admin's reply is conversational (asking for more info, partial answer, ack-while-investigating). The asker may follow up; the conversation is alive but no banner fires.
  - `status` → `"resolved"` only if the admin is confident the case is fully done (the answer fixes it, no follow-up expected). Don't preemptively close — `open` is the safer default.
  - Append cited KB filenames (if any) to `kbArticleRefs`, set `updatedAt` to now. If the admin assigned themselves, set `assignee`.
- `Write` a conversation turn at `databases/conversations/<ticketId>/msg-<timestamp>-<rand>.json` (same thread subfolder as the asker's turns):

  ```json
  {
    "id":        "msg-<timestamp>-<rand>",
    "ticketId":  "<the ticket id>",
    "role":      "admin",
    "sender":    "<admin's email or name>",
    "timestamp": "<ISO-8601>",
    "body":      "<the reply text>"
  }
  ```

### 7. Capture the answer as a KB article — DEFAULT YES

This is the load-bearing step. **Skipping it costs the org the same answer being escalated again next week.**

- Suggest a kebab-case filename matching the question's intent (not the user's exact wording): `how-to-reset-vpn-password.md`, `granting-staging-gcp-access.md`.
- Draft the article: short title (`# How to reset a VPN password`), the question phrased generally, the answer, any related links.
- Confirm with the admin before writing. On approval, `Write` to `knowledge-bases/default/<filename>.md` (unless the admin asked for a different KB collection — then `knowledge-bases/<that>/<filename>.md`).
- If the admin says no (e.g. *"this was a one-off, doesn't generalize"*), skip the capture but note it in the ticket's `notes` or `description` field so we know why.

### 8. Tell the admin what happened

Brief summary. Adapt to the ticket's `askerChannel`:

For a **chat** ticket (delivery already happened in step 6):
```
Replied to ticket-XXX → status: open (waiting on asker's reply).
Logged the admin reply as a conversation turn — the asker is seeing it in their chat browser now.
Captured the answer as `knowledge-bases/default/how-to-reset-vpn-password.md`.
```

For a **slack/teams/email/web/api** ticket (no egress yet):
```
Drafted reply for ticket-XXX → status: open.
Logged the admin reply as a conversation turn (audit trail).
Captured the answer as `knowledge-bases/default/how-to-reset-vpn-password.md`.

Still to do (manual): send the reply to <asker> via <channel> — V1 doesn't have <channel> egress wired up yet.
```

If the admin chose `resolved` instead of `open`, swap the status word but keep the rest the same.

## Action-shaped tickets

Some tickets aren't questions — they're requests for the admin to *do* something (reset a password, grant access, provision a resource). For those:

- **Skip the KB-article capture step.** A doc article doesn't help next time; the admin still has to do the work.
- Flag it for the admin: *"This was an action, not just an answer. In a future version, OpenIT will capture admin-handled actions as workflows so the next identical request runs automatically. For now, just note it."*
- The action gets logged in the conversation thread anyway, so there's a record.

## After all tickets are processed

If cloud is connected, end with: *"Sync these changes to Pinkfish? (yes/no)"* — on yes, run `node .claude/scripts/sync-push.mjs`.

If cloud is not connected, just confirm done. Local files are the source of truth.

## What you don't do

- **Don't invent answers.** If you can't read the question, the conversation history doesn't clarify it, and the KB / docs don't have it — **ask the admin.** They're the human in the loop precisely because the agent couldn't answer.
- **Don't close tickets the admin hasn't approved.** Always confirm the reply before updating the row.
- **Don't skip the KB capture step** for answer-shaped tickets without checking. Default yes; skip only on explicit admin direction.
- **Don't use gateway tools for the local file ops** in steps 1–7. `Read`, `Write`, `Edit`, `Glob`, `Grep` is all you need. The gateway is for connected third-party systems (Pro tier) — see CLAUDE.md.
