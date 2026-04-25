# PIN-5707: OpenIT Claude Code Plugin — CLAUDE.md + Skills

**Date:** 2026-04-25
**Prerequisite:** Datastores, agents, workflows, filestores synced to disk (PR #7)

---

## Context

When a user drags a database record, agent, or workflow into Claude Code, Claude sees a text reference like `[Pinkfish Datastore Row: openit-tickets/CS0001237 ...]` but doesn't know what to do with it. It doesn't know how to query datastores, run workflows, create agents, or upload to filestores.

This plan adds a Claude Code plugin (`.claude/` directory) that OpenIT downloads into the project folder on first boot. The plugin provides:

1. **CLAUDE.md** — project-level instructions so Claude understands the Pinkfish entity model and knows how to work with databases, agents, workflows, filestores, and knowledge bases
2. **Skills** — reusable slash commands for common operations (run a workflow, query a datastore, create an agent, etc.)

---

## How Claude Code Plugins Work

- **CLAUDE.md** at the repo root — Claude reads this automatically on every conversation start. Contains global instructions, conventions, and context.
- **`.claude/skills/<name>/SKILL.md`** — each skill is a YAML-frontmattered markdown file with `name` and `description`. Claude Code discovers them from the `.claude/skills/` directory. Users invoke them via `/skill-name` or Claude selects them based on relevance.
- Skills are always local files — no remote registry. They're either committed to the repo or placed in `~/.claude/skills/`.

---

## What the Plugin Contains

### CLAUDE.md (appended to existing or created)

Sections to add:

```markdown
## Pinkfish Platform

This project is managed by OpenIT, a desktop wrapper for Pinkfish ITSM solutions.
The project folder contains synced Pinkfish resources:

### Directory Layout
- `knowledge-base/` — synced KB files (markdown, PDFs, images)
- `filestore/` — synced filestore documents
- `databases/<collection>/` — structured datastore rows as JSON files + `_schema.json`
- `agents/<name>.json` — agent configurations
- `workflows/<name>.json` — workflow configurations

### Working with Databases
- Each database has a `_schema.json` that defines fields (id, label, type, options)
- Row files contain field values keyed by field ID (f_1, f_2, etc.)
- To understand a row, cross-reference field IDs with the schema
- Databases are Pinkfish datastores — use the `datastore-structured` MCP server to create/update rows

### Working with Agents
- Agent JSON contains: id, name, description, instructions, selectedModel
- Use the `agent-management` MCP server to create, update, or invoke agents
- Key tool: `agent_invoke` with agentId + message to run an agent

### Working with Workflows
- Workflow JSON contains: id, name, description, triggers, inputs
- Workflows are automations that can be triggered via API, schedule, email, or interface
- Use the `pinkfish-sidekick` MCP server for workflow operations
- Key tools: `workflow_run` (execute), `workflow_create`, `workflow_update`
- To run a workflow: `workflow_run` with automationId + inputs object
- To write/modify workflow code: `workflow_update` with automationId + code + changeDescription

### Working with Knowledge Bases
- Files in `knowledge-base/` are synced to a Pinkfish KB collection
- Use `knowledge-base_ask` to query the KB with natural language
- Supported file types: pdf, txt, md, json, csv, docx, xlsx, pptx, jpg, png, gif, webp

### Working with Filestores
- Files in `filestore/` are synced to a Pinkfish filestore collection
- Use `filestorage_create_file_from_content` to upload new files

### Pinkfish Gateway (preferred interface)

Instead of calling individual MCP servers directly, use the **Pinkfish Gateway** — a unified API that handles connection injection, capability discovery, and tool invocation.

#### Gateway Tools

| Tool | Purpose | When to use |
|------|---------|-------------|
| `capabilities_discover` | Find relevant tools, connections, resources for a task | First step — describe what you want to do in natural language, get back recommended tools + their server names |
| `capability_details` | Get full tool schemas (input/output) and skill content | After discover — get the exact arguments a tool needs before calling it |
| `gateway_invoke` | Call any MCP tool on any server | The main workhorse — pass server, tool name, and arguments. Connections auto-injected |
| `code-execution_execute` | Run JavaScript with access to all MCP tools | For multi-step operations, data processing, or when results may be large |
| `gateway_list_workspace` | List all connections and resources | When you need to enumerate everything (connections, datastores, filestores, KBs) |
| `gateway_write_artifact` | Create a downloadable file | For generating reports, CSVs, exports |
| `gateway_read_artifact` | Read artifact content with search/pagination | For reading back large results |

#### Connected Services

The gateway gives you access to **every MCP server the user has connected** in their Pinkfish workspace — not just built-in tools. This includes:
- Email: Gmail, Outlook
- Chat: Slack, Teams
- CRM: Salesforce, HubSpot
- Storage: Google Drive, OneDrive, Dropbox
- Dev: GitHub, Jira, Linear
- And 100+ other services

Use `capabilities_discover` to find what's available for any task, or `gateway_list_workspace` to see all connected services. You don't need to know which services the user has — just describe what you want to do and the gateway finds the right tools.

#### How to use the Gateway

1. **Discover capabilities first:**
   ```
   gateway_invoke: capabilities_discover({ request: "send an email via gmail", types: ["tool", "connection"] })
   ```
   Returns recommended tools with server names + user's matching connections with PCIDs.

2. **Get tool details if needed:**
   ```
   gateway_invoke: capability_details({ items: ["gmail_send_email"], types: ["tool"] })
   ```
   Returns full inputSchema with all required/optional arguments.

3. **Invoke the tool:**
   ```
   gateway_invoke: gateway_invoke({ server: "gmail", tool: "gmail_send_email", arguments: { to: "...", subject: "...", body: "..." } })
   ```
   Connection is auto-injected — do NOT pass PCID unless the user has multiple connections for the same service.

4. **For complex operations, use code execution:**
   ```
   gateway_invoke: code-execution_execute({
     code: `
       const emails = await callTool("gmail", "gmail_search_emails", { query: "is:unread" });
       const csv = emails.map(e => \`\${e.from},\${e.subject}\`).join('\\n');
       await codeExec.createArtifact('unread.csv', csv, 'csv');
       return { count: emails.length };
     `
   })
   ```

#### Key rules for Gateway usage
- **Always discover first** — don't guess tool names or server paths
- **Connections are auto-injected** — never pass PCID in arguments, use the top-level PCID param only when disambiguating multiple connections
- **Use code-execution for large results** — gateway_invoke returns full results; code-execution auto-saves large outputs as artifacts
- **No unbounded loops in code-execution** — each `callTool()` is an HTTP round-trip; bounded loops over local data are fine

### Direct MCP Server Reference (for advanced use)

When you know the exact server and tool, you can call them directly via `gateway_invoke`:

| Server | Purpose | Key tools |
|--------|---------|-----------|
| `datastore-structured` | Database CRUD | `batch_create_items` |
| `agent-management` | Agent CRUD + invoke | `agent_create`, `agent_update`, `agent_invoke`, `agent_list` |
| `pinkfish-sidekick` | Workflow operations | `workflow_run`, `workflow_create`, `workflow_update`, `workflow_list` |
| `knowledge-base` | KB operations | `knowledge-base_ask`, `knowledge-base_create_collection` |
| `filestorage` | File storage | `filestorage_create_file_from_content`, `filestorage_create_collection` |
```

### Skills

| Skill | Description | What it does |
|-------|-------------|--------------|
| `run-workflow` | Run a Pinkfish workflow by name or ID | Reads workflow JSON, invokes `workflow_run` with inputs, polls `workflow_run_status` for results |
| `query-database` | Query a Pinkfish datastore | Lists rows matching a filter by reading local JSON files, or invokes MCP for server-side query |
| `create-agent` | Create a new Pinkfish agent | Scaffolds agent config, invokes `agent_create`, writes JSON to `agents/` |
| `update-workflow` | Update workflow code | Reads current workflow, applies changes via `workflow_update`, writes updated JSON |
| `add-to-kb` | Add a file to the knowledge base | Copies file to `knowledge-base/`, triggers sync upload |
| `deploy` | Deploy changes to Pinkfish | Commits changes, pushes KB/filestore/databases to Pinkfish cloud |
| `reports` | Generate a weekly digest report | Queries datastores, summarizes activity, outputs markdown |
| `access` | Map access and permissions | Reviews agent/workflow configs, outputs access matrix |
| `people` | Look up people/contacts | Queries the people datastore, presents matching records |

### Prompt Bubbles

The prompt bubbles at the bottom of the chat pane (currently hardcoded as Reports, Access, People) should also come from the remote plugin. This lets us add/remove/rename bubbles without an app update.

**Manifest format** — the plugin manifest includes a `bubbles` array:
```json
{
  "version": "2026-04-25-001",
  "files": [...],
  "bubbles": [
    { "label": "Get Started", "skill": "/get-started" },
    { "label": "Reports", "skill": "/reports weekly-digest" },
    { "label": "Access", "skill": "/access map" },
    { "label": "People", "skill": "/people" }
  ]
}
```

**How it works:**
1. `pluginSync` fetches the manifest and writes `bubbles` to `.claude/plugin-bubbles.json`
2. `PromptBubbles.tsx` reads from this file (or receives bubbles via props from the sync state)
3. Clicking a bubble types the skill command (e.g. `/reports weekly-digest`) into the Claude Code terminal
4. We can add new bubbles at any time by updating the manifest — no app release needed
5. The hardcoded `DEFAULT_BUBBLES` in `PromptBubbles.tsx` become the fallback only when the remote manifest hasn't loaded yet

**Modified: `src/shell/PromptBubbles.tsx`**
- Accept remote bubbles from plugin sync state
- Fall back to defaults if remote hasn't loaded
- Conflict bubbles (from KB sync) still merge on top via `extraBubbles`

---

## Implementation Steps

### Step 1: Create the plugin content on the platform

**Where it lives:** A new directory in the `platform` repo (or a standalone repo) that contains the CLAUDE.md template and skill files. These are version-controlled and can be updated independently.

Proposed location: `platform/servers/agentic/mcp/src/servers/embedded/openit-plugin/`

Or simpler: a `plugin/` directory in the `openit-app` repo itself that contains the template files, and the app copies them into the project folder.

### Step 2: Host plugin content in the web repo's public directory

The plugin content lives in the web repo at `packages/app/public/openit-plugin/` — served as static files at the root URL. NOT bundled in the OpenIT app. This lets us push updates by merging a PR to the web repo.

**Location:** `packages/app/public/openit-plugin/`

**URLs:**
- Prod: `https://app.pinkfish.ai/openit-plugin/manifest.json`
- Dev: `https://<env>.pinkfish.dev/openit-plugin/manifest.json`

**Files:**
```
packages/app/public/openit-plugin/
  manifest.json                    ← version + file list + bubbles config
  claude-md.template.md            ← CLAUDE.md template with {{mustache}} vars
  skills/
    run-workflow.md
    query-database.md
    create-agent.md
    update-workflow.md
    add-to-kb.md
    deploy.md
    get-started.md
```

**URL derivation in OpenIT:** The plugin base URL is derived from the user's token URL the same way other URLs are derived (see `pinkfishAuth.ts:derivedUrls`). For prod token URL → `https://app.pinkfish.ai/openit-plugin/`. For dev → `https://<env>.pinkfish.dev/openit-plugin/`.

**The app has zero bundled plugin files.** Everything is fetched from the web app's static hosting.

### Step 3: Plugin sync module

**New file: `src/lib/pluginSync.ts`**

Polls for plugin updates every 5 minutes. On first run (no local `.claude/`), does a full install. On subsequent runs, checks the manifest hash and only downloads changed files.

```typescript
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function startPluginSync(args: {
  creds: PinkfishCreds;
  repo: string;
  orgName: string;
  orgId: string;
  datastores: DataCollection[];
  agents: Agent[];
  workflows: Workflow[];
}): Promise<void>

export function stopPluginSync(): void
```

**Flow on each tick:**
1. Fetch remote manifest: `GET openit-plugin/manifest.json` → `{ version, files: [{ path, hash }] }`
2. Compare with local `.claude/plugin-version.json`
3. If version matches, skip
4. Download changed files, write to `.claude/skills/<name>/SKILL.md`
5. Render CLAUDE.md template with current org context (datastores, agents, workflows with their schemas/inputs)
6. Write rendered CLAUDE.md to project root (merging with any user-added sections outside `## Pinkfish Platform`)
7. Update local `.claude/plugin-version.json`

### Step 4: Template rendering

The CLAUDE.md template uses simple `{{var}}` replacement with project-specific values:
- `{{org_name}}` — the Pinkfish org name
- `{{org_id}}` — for MCP server headers
- `{{datastores}}` — list of available datastores with their schemas
- `{{agents}}` — list of available agents
- `{{workflows}}` — list of available workflows with their triggers/inputs

Re-rendered on every plugin sync tick so the CLAUDE.md always reflects the current set of resources.

### Step 5: Auto-start on project open

**Modified: `src/App.tsx`**

After auth + project bootstrap, start plugin sync alongside KB/filestore sync:
```typescript
startPluginSync({
  creds, repo, orgName, orgId,
  datastores, agents, workflows,
}).catch(e => console.error("plugin sync failed:", e));
```

### Step 6: Skill file format

Each skill follows Claude Code's format:

```markdown
---
name: run-workflow
description: Run a Pinkfish workflow by name or ID. Reads the workflow config, prompts for inputs, executes via the Pinkfish API, and returns results.
---

## Instructions

1. Read the workflow JSON from `workflows/<name>.json` to understand its inputs and triggers
2. If the workflow has required inputs, ask the user for them
3. Use the `pinkfish-sidekick` MCP server to execute:
   - Tool: `workflow_run`
   - Arguments: `{ automationId: "<id from JSON>", inputs: { <user-provided values> } }`
4. Poll `workflow_run_status` with the returned runId until complete
5. Report the results to the user
```

---

## Update Mechanism

**Everything is remote — nothing is bundled in the app binary.**

Plugin content (CLAUDE.md template + skill files) lives on the Pinkfish platform. OpenIT polls every 5 minutes. This means we can:

- Push new skills (e.g. `/audit-access`) without an app release
- Update workflow authoring instructions as the platform evolves
- Fix CLAUDE.md guidance based on what we learn from user sessions
- A/B test different instruction styles across orgs
- Roll out changes instantly to all OpenIT users

The 5-minute poll is lightweight — just a manifest hash check (single GET). Actual file downloads only happen when something changed.

---

## Files Summary

| File | Action |
|------|--------|
| `src/lib/pluginSync.ts` | **New** — 5-min poll for remote plugin updates, CLAUDE.md template rendering |
| `src/App.tsx` | **Modify** — start plugin sync on project open |
| **Web repo (`packages/app/public/openit-plugin/`)** | |
| `manifest.json` | **New** — version hash + file list + bubbles config |
| `claude-md.template.md` | **New** — CLAUDE.md template with `{{mustache}}` vars |
| `skills/run-workflow.md` | **New** — skill to run workflows |
| `skills/query-database.md` | **New** — skill to query datastores |
| `skills/create-agent.md` | **New** — skill to create agents |
| `skills/update-workflow.md` | **New** — skill to update workflow code |
| `skills/add-to-kb.md` | **New** — skill to add files to KB |
| `skills/deploy.md` | **New** — skill to deploy changes |
| `skills/get-started.md` | **New** — onboarding skill for new users |

## Verification

1. `npm run tauri dev` — app launches
2. Open a project folder → `.claude/` directory created with skills + CLAUDE.md
3. Start a Claude Code session in the embedded terminal
4. Type `/run-workflow` → skill activates, prompts for workflow selection
5. Drag a database record into chat → Claude understands the context from CLAUDE.md
6. Drag a workflow into chat → Claude knows how to run it
7. Update OpenIT → plugin version bumps, skills updated automatically
