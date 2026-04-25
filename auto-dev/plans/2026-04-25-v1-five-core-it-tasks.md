# V1: Five Core IT Tasks

**Date:** 2026-04-25
**Goal:** Deliver a working ITSM in a box using only what we already have — the OpenIT app, existing Pinkfish MCPs, Slack/Teams, and the two default datastores.

---

## What we already have

- `openit-tickets` — structured datastore (Case Number, Subject, Customer Name, Status, Priority, Category, Assigned To, Assignment Group, etc.)
- `openit-people` — structured datastore (contacts template)
- Knowledge base collection (synced to `knowledge-base/`)
- Filestore collection (synced to `filestore/`)
- Agents + Workflows (synced, can be created via MCP)
- Slack/Teams connections via Gateway
- All Pinkfish MCPs (datastore, agent-management, pinkfish-sidekick, knowledge-base, filestorage)
- Claude Code with CLAUDE.md + skills

## The 5 core tasks

### 1. Ticket intake — "Employee asks for help in Slack"

**What happens:** Employee DMs the Slack bot or posts in an IT channel. An agent receives the message, creates a ticket in `openit-tickets`, tries to resolve immediately from the KB, and responds.

**What we need to create:**
- **Agent:** `openit-helpdesk` — instructions tell it to:
  - Greet the user
  - Classify the request (category, priority)
  - Search the KB for an existing solution (`knowledge-base_ask`)
  - If found: share the solution, ask if it helped, close if resolved
  - If not found: create a ticket in `openit-tickets` (`datastore-structured_create_item`), assign to the right group, tell the user their ticket number
- **Slack channel wiring:** Connect the agent to a Slack channel (agent's `slack` config or a workflow trigger)

**How the admin sets it up (in Claude Code):**
> "Create a helpdesk agent that handles IT requests from Slack. It should search the knowledge base first, create tickets in the tickets database if it can't resolve, and assign based on category."

Claude uses `/create-agent` skill → creates the agent with the right instructions and resource bindings.

### 2. Ticket resolution — "IT team works and closes tickets"

**What happens:** IT staff sees open tickets in the database table view, works them, updates status. Or they tell Claude "close ticket CS0001237 with resolution: reset the user's password via Okta."

**What we need to create:**
- Nothing new — the admin or Claude edits the ticket JSON directly (change Status to "Resolved", add resolution notes)
- Or via Claude Code: "Update ticket CS0001237 status to Resolved" → Claude edits the local JSON or calls `datastore-structured_update_item`

**How it works:**
> Admin: "Show me all open high-priority tickets"
> Claude: reads `databases/openit-tickets/`, filters by Status=New/In Progress + Priority=High, presents table
>
> Admin: "Close CS0001241 — resolution: reinstalled VPN client"
> Claude: updates the JSON file, or calls the datastore MCP to update the row

### 3. KB auto-learning — "Closed tickets become knowledge"

**What happens:** When a ticket is resolved, the solution is automatically written to the knowledge base so the helpdesk agent can find it next time.

**What we need to create:**
- **Workflow:** `openit-kb-learner` — triggered periodically (schedule) or on ticket status change:
  1. List recently resolved tickets (`datastore-structured_list_items` filtered by Status=Resolved)
  2. For each resolved ticket that hasn't been captured yet:
     - Extract the problem (Subject + Category) and solution (resolution field)
     - Write a KB article: `knowledge-base_upload_file` with filename like `solution-{category}-{ticket-number}.md`
     - Mark the ticket as "KB Captured" (add a metadata flag or update a field)
  3. Over time, the KB grows organically from real solutions

**How the admin sets it up:**
> "Create a workflow that runs every hour. It should find all resolved tickets that haven't been added to the KB yet, write a solution article for each one, and mark them as captured."

Claude uses `/run-workflow` skill + `workflow_create` to build this.

**Simpler v1 alternative:** Instead of a workflow, make it a **skill** that the admin runs manually:
> Admin: "/learn-from-tickets"
> Claude: scans resolved tickets, writes KB articles, reports what it added

### 4. People lookup — "Who has access to what?"

**What happens:** Admin needs to look up a person, see their role, check what they have access to, or find all people in a department.

**What we need to create:**
- Nothing new — the `openit-people` database already has contacts
- Claude reads the local JSON files or uses `datastore-structured_search` / `datastore-structured_natural_query`

**How it works:**
> Admin: "Who are the Product Managers?"
> Claude: reads `databases/openit-people/`, filters by Role=Product Manager, presents results
>
> Admin: "What's Alice Johnson's email?"
> Claude: finds Alice in the people database, returns her details
>
> Admin drags a person record into chat: "What tickets has this person filed?"
> Claude: cross-references the person's name against `openit-tickets` Customer Name field

### 5. Reporting — "Show the CFO what IT delivered"

**What happens:** Admin asks Claude to generate a report from ticket data, people data, or any combination.

**What we need to create:**
- **Skill:** `reports` — a bare-bones skill that tells Claude to query the datastores and generate markdown/CSV reports

**How it works:**
> Admin: "/reports"
> Claude: "What kind of report? Options: weekly digest, ticket summary by category, open tickets by assignee, resolution time analysis"
>
> Admin: "Weekly digest"
> Claude: queries openit-tickets for last 7 days, summarizes: X new tickets, Y resolved, Z open, top categories, avg resolution time. Writes to `knowledge-base/reports/weekly-digest-2026-04-25.md`

---

## Implementation — what to build

### Phase 1: Create the resources (do this NOW in Claude Code)

These are one-time setup steps the admin does in Claude Code:

1. **Create the helpdesk agent** via `agent_create`:
   ```
   name: "openit-helpdesk"
   description: "IT helpdesk agent — handles requests from Slack, searches KB, creates tickets"
   instructions: [see below]
   ```

2. **Wire the agent to Slack** — connect via the agent's Slack channel config

3. **Create the KB learner workflow** via `workflow_create`:
   ```
   name: "openit-kb-learner"
   description: "Extracts solutions from resolved tickets and writes them to the knowledge base"
   ```

4. **Seed the KB** with a few starter articles (IT basics, common procedures)

### Phase 2: Skills to add to the plugin (web repo)

| Skill | What it does |
|-------|--------------|
| `reports` | Queries datastores, generates formatted reports |
| `learn-from-tickets` | Manual trigger: scan resolved tickets → write KB articles |
| `lookup-person` | Search the people database by any field |
| `triage-tickets` | Show open tickets grouped by priority/category/assignee |

### Phase 3: Update CLAUDE.md template

Add a section explaining the ITSM setup:
```
### Your IT Service Desk

This project is set up as an IT service desk with:
- **Tickets** — `databases/openit-tickets/` tracks all IT requests
- **People** — `databases/openit-people/` is your contact directory
- **Knowledge Base** — `knowledge-base/` contains solutions that grow from resolved tickets
- **Helpdesk Agent** — `agents/openit-helpdesk.json` handles Slack intake + auto-resolution
- **KB Learner** — `workflows/openit-kb-learner.json` writes solutions from closed tickets

Common tasks:
- "Show me open tickets" → reads the tickets database
- "Close ticket X with resolution Y" → updates the ticket, triggers KB learning
- "Who is [person]?" → searches the people database
- "Generate a weekly report" → analyzes ticket data
```

---

## The helpdesk agent instructions (draft)

```
You are the IT helpdesk for {{org_name}}. You handle requests from employees via Slack.

When someone asks for help:
1. Greet them warmly and acknowledge their request.
2. Search the knowledge base for an existing solution using knowledge-base_ask.
3. If you find a relevant solution:
   - Share it with the user
   - Ask if it resolved their issue
   - If yes, log the interaction and close
4. If no solution found:
   - Create a ticket in the openit-tickets database with:
     - Case Number: auto-generated (CS + timestamp)
     - Subject: brief summary of the request
     - Customer Name: the user's name
     - Status: "New"
     - Priority: assess from context (default Medium)
     - Category: classify (Hardware, Software, Network, Access, Data, Other)
     - Contact Type: "Chat"
   - Tell the user their ticket number and that IT will follow up
5. For access requests: check the openit-people database for the user's role and current access.
6. Always be helpful, professional, and concise.
```

---

### 6. Day-1 provisioning — "New employee starts Monday"

**What happens:** IT admin tells Claude a new person is starting. Claude walks through provisioning step by step — creating accounts, assigning groups, setting up hardware, notifying managers — calling MCPs as needed and confirming each step.

**Two delivery modes:**

**Mode A — Interactive walkthrough (skill):** The admin runs `/onboard-employee` and Claude walks them through it live:
1. Collect: name, role, department, start date, manager
2. Add to `openit-people` database
3. Discover available connections (`capabilities_discover` → Okta, Google Workspace, Slack, etc.)
4. For each connected system, propose actions and confirm:
   - "Create Okta account with groups [Engineering, All-Staff]? (y/n)"
   - "Add to Slack channels #general, #engineering? (y/n)"
   - "Assign laptop from inventory? (y/n)"
5. Execute each confirmed step via `gateway_invoke`
6. Create a checklist ticket in `openit-tickets` tracking what was done
7. Notify the manager via Slack

**Mode B — Automated workflow:** The admin asks Claude to build a reusable workflow:
> "Build me a day-1 provisioning workflow that fires when a new person is added to the people database"

Claude creates a workflow via `workflow_create` that automates the whole chain.

**What we need:**
- **Skill:** `onboard-employee` — the interactive walkthrough
- The skill itself is the product — it uses `capabilities_discover` to find whatever systems the org has connected and adapts accordingly

### 7. Offboarding — "Employee leaving Friday"

**Same two modes:**

**Mode A — Interactive walkthrough (skill):** `/offboard-employee`
1. Look up the person in `openit-people`
2. Discover all connected systems
3. For each system, propose revocations and confirm:
   - "Disable Okta account? (y/n)"
   - "Remove from all Slack channels? (y/n)"
   - "Transfer Google Drive files to manager? (y/n)"
   - "Revoke GitHub access? (y/n)"
4. Execute each confirmed step
5. Update person's status in `openit-people` to "Offboarded"
6. Create audit ticket in `openit-tickets` documenting everything revoked
7. Time-critical: all done in < 1 minute (the concept doc's "offboarding cascade")

**Mode B — Automated workflow:** Same as provisioning — Claude builds a reusable workflow.

### 8. User-created skills — synced across the IT team

**The big idea:** IT admins can create their own skills that get shared with the whole team. When one admin builds a custom provisioning checklist or a vendor-specific offboarding procedure, every team member gets it automatically.

**How it works:**

Skills are stored in a shared Pinkfish filestore collection (`openit-skills`). OpenIT syncs them to the local `.claude/skills/` directory alongside the platform-provided skills.

**Flow:**
1. Admin creates a skill (either manually or asks Claude to write one):
   > "Create a skill called 'vpn-setup' that walks through setting up VPN access for a new employee"
2. Claude writes the SKILL.md file to `.claude/skills/vpn-setup/SKILL.md`
3. OpenIT detects the new/changed skill file and uploads it to the `openit-skills` filestore collection
4. Other team members' OpenIT apps pull the updated skill on their next sync cycle (every 5 minutes)
5. Everyone on the team now has `/vpn-setup` available

**What we need to build:**
- **Skill sync module** (`src/lib/skillSync.ts`) — bidirectional sync between `.claude/skills/` and the `openit-skills` filestore collection. Same pattern as KB sync:
  - On startup: pull all skills from remote, write to `.claude/skills/`
  - Watch for local changes: new/modified SKILL.md files → upload to remote
  - Poll every 5 min for remote changes from other team members
- **Skill:** `create-skill` — tells Claude how to write a SKILL.md file with proper frontmatter (name, description) and instructions
- **Filestore collection:** `openit-skills` — auto-created alongside `openit-docs`

**What this enables:**
- Admin A builds `/onboard-contractor` for their specific vendor stack
- Admin B gets it automatically and can use it or improve it
- The team's collective IT knowledge compounds as skills, not tribal knowledge
- Skills are version-controlled via the filestore (and eventually git)

**Separation from platform skills:**
- Platform skills (from `app.pinkfish.ai/openit-plugin/`) → read-only, managed by Pinkfish
- Team skills (from `openit-skills` filestore) → read-write, created by the IT team
- Both land in `.claude/skills/` — Claude sees them all equally

---

## Updated implementation plan

### New skills to add to the plugin (web repo)

| Skill | What it does |
|-------|--------------|
| `onboard-employee` | Interactive day-1 provisioning walkthrough — discovers connected systems, proposes actions, confirms each step |
| `offboard-employee` | Interactive offboarding — revokes access across all systems, documents everything |
| `create-skill` | Helps write a new SKILL.md that gets shared with the team |

### New sync module (openit-app)

| File | What it does |
|------|--------------|
| `src/lib/skillSync.ts` | Bidirectional sync: `.claude/skills/` ↔ `openit-skills` filestore. Pull on startup, push on change, poll every 5 min |

### New filestore collection

| Name | Purpose |
|------|---------|
| `openit-skills` | Shared team skills — auto-created on first boot alongside `openit-docs` |

---

## What this delivers

An IT admin opens OpenIT, connects Pinkfish + Slack, and within minutes has:
- A Slack bot that takes IT requests, searches KB, creates tickets
- A ticket database they can view as a table, drag into Claude, query naturally
- A people directory they can search and cross-reference
- A knowledge base that grows automatically from resolved tickets
- On-demand reporting — any report, any format, just ask Claude
- Day-1 provisioning — Claude walks through onboarding across every connected system
- Offboarding in under a minute — Claude revokes everything, documents the audit trail
- Team skills that compound — every procedure one admin builds, the whole team gets

**No workflow UI. No admin console. No code.** Just Claude Code + data on disk + Pinkfish MCPs.

---

## Skills vs Workflows — when to use which

| | **Skill** (Claude Code) | **Workflow** (Pinkfish runtime) |
|---|---|---|
| **Who runs it** | The IT admin, in Claude Code | Anyone — employees via Slack, schedules, API triggers |
| **Intelligence** | Full Claude reasoning — adapts, fixes errors, asks questions | Deterministic — runs the same code every time |
| **Scope** | Unrestricted — can use any MCP, read any file, ask the admin | Scoped — only the tools/connections explicitly bound to it |
| **Cost** | LLM call per step — fine for admin-initiated, not for every ticket | Cheap — no agent loop, just code execution |
| **Best for** | Complex, judgment-heavy tasks the admin does occasionally (onboarding, offboarding, investigations, reports) | Repetitive tasks triggered by non-admins or on a schedule (ticket intake, KB learning, notifications) |

**The rule of thumb:**
- **Admin does it → Skill.** Claude reasons through each step, handles edge cases, confirms before acting. Perfect for provisioning, offboarding, investigations.
- **Employee triggers it from Slack → Workflow.** Scoped, deterministic, cheap. The employee shouldn't have full MCP access — the workflow does exactly what it's designed to do.
- **Runs on a schedule → Workflow.** KB learning, digest reports, access audits — these run unattended.
- **One-off or exploratory → Skill.** "Figure out why this person can't access Salesforce" — that's a Claude conversation, not a workflow.

**The hybrid pattern:** A skill can create a workflow. The admin uses `/onboard-employee` interactively the first few times. Once the process stabilizes, they say "turn this into a workflow that fires when a new person is added to the people database." Claude writes the workflow code using `workflow_create`.

---

The killer loop: **tickets → solutions → KB → better auto-resolution → fewer tickets → admins build skills → team gets faster.** The system gets smarter with every closed ticket and every skill the team writes.
