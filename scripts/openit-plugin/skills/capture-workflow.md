---
name: capture-workflow
description: Turn an action-shaped IT ticket the admin just handled into a Pinkfish workflow so future identical requests run on autopilot. Used after answer-ticket when the response was a series of actions, not just an answer.
---

## When to use

Triggered after the admin handles a ticket that required *doing* something (resetting a password, granting access, provisioning a resource) rather than just answering. The `answer-ticket` skill flags these and offers to invoke `capture-workflow`. You can also be invoked directly when the admin says "let's turn this into a workflow."

The principle: **next time someone asks for the same thing, a workflow should handle it without the admin doing anything.**

## How to think about it

The output is `workflows/<name>.json` — a Pinkfish workflow JSON describing the trigger conditions and the steps. Pinkfish workflows compose gateway tool calls (server + tool + arguments), with optional human-in-the-loop checkpoints for actions that need approval.

You're translating *what the admin just did* into *what the workflow should do*. Pull both: the ticket (the input shape — what kind of request triggered this) and the admin's actions (the steps).

## What to do

For each ticket the admin wants to turn into a workflow:

1. **Read the ticket.** Open the JSON. Read `_schema.json` to map field IDs to plain language. Note the *type* of request — what would distinguish this kind of ticket from another? (E.g., the question contains `vpn` and `password reset`; or the user's role is `external contractor`.)

2. **Reconstruct what the admin did.** Walk the recent chat / tool-call history. List the concrete actions:
   - Gateway tool calls (e.g., `gateway_invoke` with `agent-management`, `datastore-structured`, third-party MCPs).
   - File edits in the project folder.
   - Anything done out-of-band that you need to surface as a human checkpoint.

3. **Confirm the trigger pattern with the admin.** Show what you'd match against:
   ```
   This workflow will run when a ticket comes in matching:
     - Subject contains: "vpn", "password reset"
     - User role: "employee"
   Sound right?
   ```
   Adjust based on the admin's input. Don't be too narrow (workflow never fires) or too broad (workflow fires on unrelated tickets).

4. **Draft the workflow JSON.** Structure (bare minimum):
   ```json
   {
     "name": "vpn-password-reset",
     "description": "Resets an employee's VPN password and emails them confirmation.",
     "triggers": [
       {
         "type": "ticket-match",
         "match": {
           "questionContains": ["vpn", "password reset"],
           "userRole": "employee"
         }
       }
     ],
     "steps": [
       {
         "kind": "gateway",
         "server": "okta",
         "tool": "okta_reset_user_password",
         "arguments": {
           "userId": "{{ ticket.user.id }}"
         }
       },
       {
         "kind": "gateway",
         "server": "knowledge-base",
         "tool": "knowledge-base_ask",
         "arguments": {
           "question": "vpn password reset"
         }
       }
     ]
   }
   ```
   Use the actual server/tool names from the admin's recent calls. If the admin needs to approve a step, mark it `"requiresApproval": true`.

5. **Write the file** to `workflows/<kebab-case-name>.json`. Show the admin the diff.

6. **Tell the admin what's next:**
   - To make this workflow auto-run on matching tickets: open the triage agent's instructions and add a routing rule pointing at this workflow. (V2 will automate this; for now it's a manual step.)
   - To test: ask the admin to run the workflow directly (`/run-workflow <name>`) on a copy of the ticket to confirm.
   - To push to Pinkfish: invoke the `deploy` skill (`node .claude/scripts/sync-push.mjs`).

## Format the result

Same rules as the rest of the plugin (CLAUDE.md "How to talk to me about changes"):

- Plain language. Schema labels, not field IDs.
- Show the workflow JSON before writing — the admin needs to sanity-check the trigger pattern and steps.
- Quote what the admin will see; don't make them dig.

## What you don't do

- **Don't auto-fire the workflow.** Capturing it is a separate decision from running it. Leave the workflow as a draft on disk; the admin pushes when ready.
- **Don't capture sensitive credentials in the workflow JSON.** Secrets live in connections (auto-injected via PCIDs); the workflow references them by tool, not by literal value.
- **Don't generalize too aggressively.** A workflow that fires on any ticket containing "password" will misfire. When in doubt, narrow the match and let the admin broaden it later if it under-fires.
- **Don't worry about the routing rule** in the triage agent (auto-pick the right workflow based on incoming ticket) — that's V2. For V1 the admin invokes the workflow themselves on next matching ticket.
