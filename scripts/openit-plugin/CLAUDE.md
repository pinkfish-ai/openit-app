## Pinkfish Platform

This project is managed by **OpenIT**. The project folder contains synced Pinkfish resources.

### Directory Layout
- `knowledge-base/` — synced KB files (markdown, PDFs, images, docs)
- `filestore/` — synced file storage documents
- `databases/<collection>/` — structured datastore rows as JSON + `_schema.json`
- `agents/<name>.json` — agent configurations
- `workflows/<name>.json` — workflow configurations

### How to interact with Pinkfish resources

Use the **Pinkfish Gateway** — a unified API to all connected services.

**Pattern for every operation:**
1. `capabilities_discover` — describe what you want to do in natural language, get back tool + server names
2. `capability_details` — get the full tool schema (arguments, types, descriptions)
3. `gateway_invoke` — call the tool with `{ server, tool, arguments }`

**Servers for built-in resources:**
| Resource | Server | Example tools |
|----------|--------|---------------|
| Databases | `datastore-structured` | `create_item`, `list_items`, `search`, `natural_query` |
| Agents | `agent-management` | `agent_create`, `agent_invoke`, `agent_list` |
| Workflows | `pinkfish-sidekick` | `workflow_run`, `workflow_create`, `workflow_list` |
| Knowledge Base | `knowledge-base` | `knowledge-base_ask`, `knowledge-base_upload_file` |
| File Store | `filestorage` | `filestorage_create_file_from_content`, `filestorage_list_items` |

**For external services** (Gmail, Slack, Salesforce, etc.), always start with `capabilities_discover`. The gateway gives access to 100+ connected services — don't guess tool names.

**For complex multi-step operations**, use `code-execution_execute` to run JavaScript with `callTool()` access to all MCP tools.

### Working with local files

All Pinkfish resources are synced to local JSON files. You can:
- **Read** any resource by reading the local file (fastest, no API call needed)
- **Edit** local files directly — modify a database row JSON, update an agent's instructions, etc.
- **Commit** changes via the Deploy tab to sync edits back to Pinkfish

This means for simple edits (update a ticket status, fix an agent's instructions), just edit the JSON file. No Gateway call needed. The user commits when ready.

Use the Gateway for operations that don't map to file edits: running workflows, invoking agents, querying KBs with natural language, or interacting with external services.

### Key rules
- **Read local files first** — databases/, agents/, workflows/ have the data on disk already
- **Edit local files for simple changes** — modify the JSON, user commits to sync
- **Use Gateway for actions** — running workflows, invoking agents, querying KBs, external services
- **Always discover first** — use `capabilities_discover` before invoking unfamiliar tools
- **Connections are auto-injected** — never hardcode PCIDs
- **Read the schema** — always check `_schema.json` before working with database rows

### Scripts and skills

Plugin scripts live at `.claude/scripts/`. Invoke via `node .claude/scripts/<name>.mjs <args>`. Each prints a single JSON line on stdout (`{"ok": true, ...}` or `{"ok": false, "error": ...}`) so you can branch on it.

| Script | What it does |
|---|---|
| `sync-resolve-conflict.mjs --prefix <p> --key <k>` | Marks a single sync conflict as resolved (rewrites the manifest entry, removes the leftover `.server.<ext>` shadow). Doesn't push. `<p>` is `kb` / `filestore` / `datastore` / `agent` / `workflow`; `<k>` is the manifest key. |
| `sync-push.mjs [--timeout <s>]` | Pushes every bidirectional entity (KB, filestore, datastore) to Pinkfish via the running OpenIT app. Blocks until done. Times out with `app_not_running` if OpenIT isn't open. |

For the sync conflict and push flows, prefer the **skills** that wrap these scripts — they walk the merge logic + when-to-ask + cleanup in one place:

| Skill | Use when |
|---|---|
| `resolve-sync-conflict` | The user (or the conflict banner) hands you sync conflicts. Skill body details the per-conflict merge + resolve-script call + optional push at the end. |
| `answer-ticket` | The user (or the escalated-ticket banner) hands you tickets the triage agent couldn't answer. Skill walks the response loop and captures the answer as a KB article — "answer once". |
| `capture-workflow` | The user just handled an action-shaped ticket (something to *do*, not just answer) and wants to turn it into a Pinkfish workflow that runs on autopilot for the next identical request. Invoked from `answer-ticket` or directly. |
| `deploy` | The user wants to push current local state to Pinkfish without resolving anything. |

### How to talk to me about changes

**Don't make me do more work than I have to.** That's the principle. Make the call yourself when you can, surface the result so I can scan it, and only stop and ask when there's a genuine decision I need to make.

**Just do it when you're confident.** If I gave a direct instruction or the right answer is obvious from context, write the file and tell me what changed. Don't ask "OK to apply?" for unambiguous edits — that's friction, not safety.

**Show what changed, in plain language.** Use human terms ("email", "name", "phone number"), not field IDs ("f_2") — map to schema labels from `_schema.json` when available. Quote the before/after values so I can sanity-check from the message alone; don't assume I have the file open.

```
Updated Bob's record in the People database:
  - email: "alice@a.com" → "bob@example.com"
```

**Ask only for genuine decisions.** If both sides of a sync conflict changed the same field to different values, or I asked for something where the right call isn't obvious, surface both candidates and let me pick. Never decide silently for a field where you can't infer the intent.

```
The email field changed on both sides — which should win?
  - local:    "alice@a.com"
  - Pinkfish: "bob@example.com"
```

**The anti-pattern** is a bare summary that hides the values:

- ❌ "Updated 3 fields on row-123" — what fields, what values?
- ❌ "Resolved the conflict by keeping your local change" — kept what?

Show the change. Auto-apply when confident. Ask only when there's a real choice to make.

### Permissions

Claude Code skills in this project need filesystem access to explore your project structure, read databases, and scan resources. When you first use skills like "Get Started" or "Triage Tickets", Claude will ask permission to:

- **Bash** — list and explore directories
- **Read** — examine resource files and configuration

**You can approve these once** — Claude Code remembers your choice for this project, so you won't see the prompt again. This enables skills to:
- Discover what databases you have
- Read ticket and people data from local JSON
- Scan the knowledge base for available solutions
- Check your connected systems and workflows
