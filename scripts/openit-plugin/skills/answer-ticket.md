---
name: answer-ticket
description: Walks the IT admin through responding to an escalated ticket — read it, draft an answer, deliver the reply, capture the answer as a KB article so the same question gets auto-answered next time. The "answer once" principle.
---

## When to use

Invoked when the admin clicks the **Solve with Claude** button on the escalated-ticket banner, or directly via `/answer-ticket <ticket-path>` for a specific ticket. The caller will name the ticket file path(s); if not, scan `databases/tickets/` for rows with `status: "open"` and surface them.

## The principle — answer once

When the admin writes a reply, **capture it as a knowledge-base article.** The next time someone asks the same question, the triage agent will answer from the KB without anyone touching it.

If the ticket is action-shaped (the admin had to *do* something rather than just answer — reset a password, grant access, run a command), flag it for the admin so they're aware future automation could capture it as a workflow. **Workflows themselves are V2** — for V1, just note it.

## For each ticket, in order

### 1. Read the ticket and the conversation

- `Read` the ticket JSON at the path you were given.
- `Read` `databases/tickets/_schema.json` to refresh on field meanings (the schema's field IDs are plain language — `subject`, `description`, `status`, `asker` — so this is mostly a sanity check).
- List `databases/conversations/<ticketId>/` (the thread subfolder for this ticket), sort by `timestamp`. `Read` each turn.

### 2. Summarise it for the admin

Plain language. Show who asked, what they asked, when, and any context from the conversation thread. Quote the exact question text.

### 3. Sanity-check the KB

`Glob "knowledge-base/*.md"`. Read filenames. The triage agent already searched but might have missed something. Try once more with the admin's perspective on the question. If you find a match, point the admin at it: *"This article looks relevant — should I just send the user the answer from `kb/how-to-reset-vpn.md`?"*

### 4. Draft a reply with the admin

Show what you'd write. Iterate with the admin until they're happy. Be concise; lead with the answer.

### 5. Send the reply

For V1, OpenIT doesn't have channel ingest yet — show the admin the final text and tell them to copy it to wherever the user is (email, Slack DM, etc.). Note this in the conversation log so the audit trail is intact.

(When cloud channel ingest lands in a future phase, this becomes automatic.)

### 6. Update the ticket and log the conversation turn

- `Edit` the ticket: set `status: "answered"`, append cited KB filenames (if any) to `kbArticleRefs`, set `updatedAt` to now. If the admin assigned themselves, set `assignee`.
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
- Confirm with the admin before writing. On approval, `Write` to `knowledge-base/<filename>.md`.
- If the admin says no (e.g. *"this was a one-off, doesn't generalize"*), skip the capture but note it in the ticket's `notes` or `description` field so we know why.

### 8. Tell the admin what happened

Brief summary:

```
Drafted reply, updated ticket-XXX → status: answered.
Captured the answer as `knowledge-base/how-to-reset-vpn-password.md`.
Logged the admin's reply as a conversation turn.

Still to do (manual): copy the reply to Alice via Slack/email.
```

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
