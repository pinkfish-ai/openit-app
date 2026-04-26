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

### Formatting — what to show the user

Database rows under `databases/<collection>/` commonly hold PII: names, emails, phone numbers, employee IDs, addresses, ticket descriptions. **Don't echo raw row field values back into the chat**, even when the user asks ("what's the value", "what changed", etc.). The user has the file open in OpenIT and can see the values themselves; pasting them into the conversation just leaks them into transcripts and screenshots.

What this means in practice when you've edited a row:

- ✅ Good: *"Updated `f_1` (last name field) on `row-1777161749894.json`. Run `/deploy` to sync."*
- ✅ Good: *"Wrote 3 changes to `row-XYZ.json`."*
- ❌ Avoid: showing a diff that includes the values: ~~*"Updated f_1 from 'Bob Edgar' to 'Bob Edgaring'"*~~
- ❌ Avoid: tables of before/after values
- ❌ Avoid: quoting values inside narrative ("set the email to alice@example.com")

When you must reference a field, use the **field name** (`f_1`, `f_2`) or the **schema label** if `_schema.json` provides one (`name`, `email`). Never the value.

This rule applies any time you work with `databases/`. It does **not** apply to:
- `agents/` and `workflows/` — these are configurations the user authored, not user data; show diffs normally
- `knowledge-base/` and `filestore/` — same, show contents normally
- Edit/Write tool diffs — those are surfaced by Claude Code itself, you can't suppress them

### Permissions

Claude Code skills in this project need filesystem access to explore your project structure, read databases, and scan resources. When you first use skills like "Get Started" or "Triage Tickets", Claude will ask permission to:

- **Bash** — list and explore directories
- **Read** — examine resource files and configuration

**You can approve these once** — Claude Code remembers your choice for this project, so you won't see the prompt again. This enables skills to:
- Discover what databases you have
- Read ticket and people data from local JSON
- Scan the knowledge base for available solutions
- Check your connected systems and workflows
