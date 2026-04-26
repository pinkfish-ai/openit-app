---
name: answer-ticket
description: Walks the IT admin through responding to an escalated ticket — read it, draft an answer, send the reply, and capture the answer as a KB article so the same question gets auto-answered next time. The "answer once" principle.
---

## When to use

Invoked when the user (an IT admin) hands you escalated tickets to resolve — typically via the **Solve with Claude** banner at the top of OpenIT, which pastes a list of ticket file paths under your invocation. If no tickets were named, scan `databases/openit-tickets-*/` for rows whose status field is `open` / `escalated` / `pending` / `needs-human` and surface them.

## The principle

**Answer once.** When the admin writes a reply, capture it as a knowledge-base article. The next time someone asks the same question, the triage agent will answer from the KB without anyone having to write a reply.

If the ticket is action-shaped (the admin had to *do* something rather than just answer), offer to capture it as a workflow instead — that's Phase C territory and deferred for now, but flag it for the admin so it's on their radar.

## For each ticket, in order

1. **Read the ticket.** Open the JSON file. Read `_schema.json` in the same collection to map field IDs (`f_1`, `f_2`, …) to human labels.

2. **Summarise it for the admin** in plain language. Use the schema labels — show who asked, what they asked, when, and any context. Quote the exact question text.

3. **Search the KB** quickly to confirm there really is no existing answer. If you find one, point the admin at it — the agent might have missed it. Ask the admin if they want to use it.

4. **Draft a reply** with the admin. Show them what you'd write. Iterate until they're happy. Be concise; lead with the answer.

5. **Send the reply.** For V1, OpenIT doesn't have channel ingest yet, so just show the admin the final text and tell them to copy it to wherever the user is (email, Slack DM, etc.). Once Phase D lands, this becomes automatic.

6. **Update the ticket row.** Set the status field (use the schema-mapped name) to `answered` and write the reply text into a `response` / `answer` / `notes` field if one exists; if none does, append to the description with a clear separator. Save the file.

7. **Offer to capture as a KB article** — *default yes*. Draft a markdown article in `knowledge-base/` named for the question's intent (kebab-case, e.g. `how-to-reset-vpn-password.md`). Structure: short title, the question phrased generally (not the user's exact wording), the answer, any related links. Confirm with the admin before writing.

8. **Tell the admin what happened.** "Drafted reply → updated ticket → wrote KB article `<filename>`." That's it. Don't make them dig.

## After all tickets are processed

Tell the admin to push: "Sync these changes to Pinkfish to land the KB article(s) and ticket updates? (yes/no)" — on yes, run `node .claude/scripts/sync-push.mjs`.

## Action-shaped tickets

Some tickets aren't questions — they're requests for the admin to *do* something (reset a password, grant access, provision a resource). For those:

- Skip the KB-article capture step. A doc article doesn't help next time; the admin still has to do the work.
- Instead ask the admin: *"This was an action, not just an answer. Want to turn it into a workflow so the next identical request runs automatically?"*
- On yes, invoke the **capture-workflow** skill on this ticket. That skill walks the workflow-authoring flow.
- On no, skip; the admin can come back to it later.

## What you don't do

- **Don't invent answers.** If you can't read the question or the KB / docs / connected systems don't have what's needed, ask the admin. They're the human in the loop precisely because the agent couldn't answer.
- **Don't close tickets the admin hasn't approved.** Always confirm the reply before updating the row.
- **Don't skip the KB capture step** for answer-shaped tickets without checking. The whole point is "answer once" — silently dropping the capture costs the org the same answer being escalated again next week.
