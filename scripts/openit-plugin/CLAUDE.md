# OpenIT — local-first IT helpdesk

This project is the user's IT helpdesk. They are the admin — they own and run it. Tickets, knowledge base, agents, and contacts all live as plain files on disk in this folder. OpenIT runs entirely locally by default; if the user has connected the project to Pinkfish (their cloud account), the "When cloud is connected" section near the bottom describes the additional capabilities that turn on (channel ingest, third-party integrations via MCP, multi-device sync, semantic KB search).

You're Claude, helping the admin run this helpdesk. Most of what they'll ask you to do is read, edit, or create files in this folder.

## Directory layout

| Path | What's there |
|---|---|
| `databases/tickets/*.json` | Ticket rows, structured. `_schema.json` next to them documents fields. |
| `databases/people/*.json` | Contacts directory, structured. |
| `databases/conversations/<ticketId>/msg-*.json` | One subfolder per ticket thread; one JSON file per turn inside it. **Unstructured** — no schema enforcement. Subfolder name = `ticketId` so all turns for a ticket live together. |
| `knowledge-bases/default/*.md` | Solution articles. Markdown. The "answer once" capture target — write new articles here unless the admin explicitly asks for a different KB collection. Admins can `mkdir knowledge-bases/<custom>/` to add more KBs; `kb-search` walks all of them. |
| `filestores/library/*` | Curated reference files — runbooks, scripts, recurring docs the admin keeps handy. Cloud-synced via the existing filestore sync engine. |
| `filestores/attachments/<ticketId>/*` | Operational attachment storage — files dropped into the chat intake by the asker, or files the admin attached to a reply. One subfolder per ticket so attachments stay tied to their thread. |
| `agents/<name>/` | Agent configurations — one folder per agent. The triage agent lives at `agents/triage/` with `triage.json` (structured fields: model, sharing, resources, tools) plus three markdown blocks: `common.md` (shared persona), `cloud.md` (Pinkfish runtime HOW-TO), and `local.md` (OpenIT runtime HOW-TO). The `openit-` prefix is added automatically when the agent is synced to Pinkfish. |
| `workflows/<name>.json` | (Future, V2.) Captured action playbooks. |
| `reports/<YYYY-MM-DD-HHmm>-<slug>.md` | Generated helpdesk reports. Newest sorts to the top by filename. The "Generate overview" button in the explorer writes a canned status snapshot; the `/report` skill writes freeform reports authored by Claude. |
| `.claude/` | Plugin manifest territory — Claude Code's own conventions live here too (`.claude/skills/<name>/SKILL.md`, `.claude/scripts/*`, `.claude/settings.local.json`). **Owned by the plugin sync.** Overwritten on every reconnect / version bump. Don't write user state here — it'll get clobbered. Hidden from the explorer by default; the "show system files" toggle reveals it. |
| `.openit/` | OpenIT runtime state — Slack workspace pointer (`slack.json`), listener session and delivery ledgers (`slack-sessions.json`, `slack-delivery.json`), Skill Canvas state (`skill-state/<skill>.json`), plugin-version sentinel. **Owned by the running OpenIT app and its child processes.** Survives plugin syncs. Hidden from the explorer by default; the "show system files" toggle reveals it. Gitignored. |

The directory names are stable — same in local mode and after connecting to cloud. The cloud sync engine maps these to per-org collections on Pinkfish at push time; the local layout doesn't change.

### Why `.claude/` and `.openit/` are split (architectural decision)

Two dot-directories with related-looking content but different ownership and lifetime. Mixing them would be wrong; here's why:

- **`.claude/` is owned by the plugin sync** (`syncSkillsToDisk` in `src/lib/skillsSync.ts`). On every Pinkfish reconnect or version bump, it fans out the manifest into this directory — overwriting anything with the same name. It's also Claude Code's own contract surface: Claude reads `.claude/skills/`, `.claude/settings.local.json`. Putting OpenIT runtime state under `.claude/` would mean either the sync clobbers it or we teach the sync to preserve a sub-tree (annoying special case). It also risks colliding with future Claude Code conventions in the same namespace.

- **`.openit/` is owned by the running app and its child processes** (Tauri side `intake.rs` / `slack.rs` / `skill_canvas.rs`, plus the Node listener). Survives plugin syncs because the sync never touches it. Evolves with actual usage — sessions accrue, canvas progress advances, version sentinels roll. If we ever want to wipe runtime state without re-running the plugin sync (`rm -rf .openit/` to reset), the split makes that clean.

Rule of thumb when adding a new file:
- **Comes from the plugin manifest, gets refreshed periodically, user-doesn't-edit?** → `.claude/`.
- **Written by the running OpenIT app or a child process, evolves with usage, survives plugin updates?** → `.openit/`.

The explorer's "show system files" toggle reveals both at once, so the UX cost of the split is zero.

## How to interact with the data — local file ops first

Everything is on disk. Default to the built-in tools:

- **Read** — open a file. Lists with `Glob`. Search content with `Grep`.
- **Write** — create a new file (e.g., new ticket, new KB article).
- **Edit** — update an existing file (e.g., set a ticket's status to `resolved`, append a turn to a conversation).
- **Bash** — list directories, count files, run scripts the project provides.

You don't need to call any gateway / network tool to read or write tickets, KB articles, agent configs, or contact records. Those are just files. Reach for the gateway only when the user is asking you to do something involving a connected third-party system (Slack, Okta, GitHub, GCP) — and even then, only when cloud is connected.

## The triage agent

The triage agent's persona lives at `agents/triage/`. The structured fields (model, sharing, resources, tools, prompt examples, intro message) live in `triage.json`; the prose persona is split across three markdown blocks — `common.md` (universal voice + escalation rules), `cloud.md` (Pinkfish-runtime instructions, e.g. MCP tool names), and `local.md` (OpenIT-runtime instructions, e.g. file paths and the `ai-intake` skill). The chat-intake server assembles `common.md + local.md` and passes it as the agent's prompt; the cloud agent on Pinkfish gets `common.md + cloud.md` instead. Edit the markdown files to tweak how the agent talks to end users — those are the sources of truth for the agent's voice.

You don't normally run the triage flow yourself — `ai-intake` does. But if the admin asks you ad-hoc questions about ticket / conversation / people data, the file conventions you'd use are:

- **Ticket** → `databases/tickets/ticket-<id>.json`. Status enum: `incoming` → `agent-responding` (chat is live, agent composing) → `resolved` (answered) or `escalated` (needs admin). `closed` for fully done. `databases/tickets/_schema.json` has the full field list in plain-language labels.
- **Person** → `databases/people/<sanitized-email>.json`. Idempotent — skip the write if a row with that email already exists. Schema next door.
- **Conversation turn** → `databases/conversations/<ticketId>/msg-<unix-ms>-<rand>.json`. Subfolder name = `ticketId`. Fields: `id`, `ticketId`, `role` (`asker` / `agent` / `admin`), `sender`, `timestamp` (ISO-8601 UTC), `body`.
- **KB lookup** → `Glob "knowledge-bases/**/*.md"` (all collections) or `Glob "knowledge-bases/default/*.md"` (default only) then `Read` the most relevant. Filename + headings usually enough cue. Or run `node .claude/scripts/kb-search.mjs "<query>"` to score across every KB at once.

## How to talk to me about changes

**Don't make me do more work than I have to.** Auto-resolve / apply when confident; ask only when there's a real decision.

**Just do it when you're confident.** If I gave a direct instruction or the right answer is obvious from context, write the file and tell me what changed. Don't ask "OK to apply?" for unambiguous edits.

**Show what changed, in plain language.** Use human terms ("email", "name", "phone number"), not field IDs (this project's schema labels ARE plain language already, so there's no excuse). Quote the before/after values so I can sanity-check from the message alone — don't assume I have the file open.

```
Updated Bob's record in the People database:
  - email: "alice@a.com" → "bob@example.com"
```

**Ask only for genuine decisions.** If both sides of a sync conflict changed the same field to different values, or my request is genuinely ambiguous, surface candidates and let me pick. Never decide silently for a field where you can't infer the intent.

```
The email field changed on both sides — which should win?
  - local:    "alice@a.com"
  - Pinkfish: "bob@example.com"
```

The anti-pattern is a bare summary that hides the values:

- ❌ "Updated 3 fields on row-123" — what fields, what values?
- ❌ "Resolved the conflict by keeping your local change" — kept what?

Show the change. Auto-apply when confident. Ask only when there's a real choice to make.

## Skills

Naming convention: skills prefixed with **`ai-`** are agent-facing — auto-loaded by `claude -p` subprocesses, not invoked by humans. Unprefixed skills are admin-facing — slash-invoked by the OpenIT user in the desktop Claude pane (e.g. `/answer-ticket <ticket-path>`).

| Skill | Audience | Use when |
|---|---|---|
| `ai-intake` | Agent (claude -p) | Auto-loaded per chat-intake turn. The user opens the localhost chat URL, asks a question; the server invokes this skill to KB-search and decide answer-vs-escalate. Not normally invoked by hand. |
| `answer-ticket` | Admin (desktop) | The user (or the escalated-ticket banner) hands you tickets needing a human reply. Walks the response loop and captures the answer as a KB article — "answer once". |
| `conversation-to-automation` | Admin (desktop) | The admin clicked "Mark as resolved" on a ticket. Reads the resolution and harvests it into a KB article (asker auto-answer), a skill (admin workflow markdown), or a script (deterministic executable). Search-first, prefer updates over duplicates. |
| `connect-to-cloud` | Admin (desktop) | The user wants to connect this project to Pinkfish (cloud companion) — for public intake URL, channel ingest, multi-device sync, always-on agents. Conversational walkthrough: one step at a time, confirm, advance. |
| `resolve-sync-conflict` | Admin (desktop) | The conflict banner hands you sync conflicts (cloud mode only). Per-conflict merge + resolve-script call + optional push. |
| `deploy` | Admin (desktop) | Push current local state to Pinkfish. Cloud-connected only. |
| `report` | Admin (desktop) | The admin wants a custom helpdesk report — by tag, time window, asker, etc. Reads tickets / conversations and writes a markdown file to `reports/<timestamp>-<slug>.md`. The canned overview is a one-click button in the explorer; this skill is for anything more specific. |

## Capturing reusable workflows — proactive skill / script offer

When you observe the admin walking through a multi-step process that could plausibly recur on a future ticket — provisioning access, running a CLI sequence, navigating a series of dashboards, recovering from a known failure mode — **proactively offer to capture it as a skill or script**. Don't wait for "Mark as resolved" to do this; the explicit-trigger path covers ticket-side resolutions, but a lot of valuable workflows happen mid-session.

### When to offer

All three must be true:

1. **3+ discrete steps.** A one-liner ("how do I unzip a tar?") doesn't qualify — that's KB-shaped, and the Mark-as-resolved path catches it.
2. **At least one admin-only action** — a CLI invocation, a dashboard mutation, a permission grant, anything outside the asker's reach.
3. **Not already covered.** Glance at `filestores/skills/*.md` and `filestores/scripts/*` first. If a matching artifact exists, offer to *update* it instead of creating a new one (or just mention the existing one and don't write anything if it's already complete).

### What to offer

Pick **skill or script** based on the workflow's character:

- **Skill** — there are branches, judgment calls, or per-context decisions. Output is a markdown prompt the admin (or future-you) reads and follows. Ask: *"Want me to capture this as a skill at `filestores/skills/<slug>.md`?"*
- **Script** — the workflow is fully deterministic, same inputs always produce same outputs. Output is an executable. Ask: *"Want me to capture this as a runnable script at `filestores/scripts/<slug>.<ext>`?"*

If you're unsure, default to skill — easier to refactor a skill into a script later than the other way around.

### Etiquette

- Ask **once** per workflow per session. If the admin says no, drop it and don't re-ask.
- Don't write the artifact silently. Always confirm first.
- KB-article candidates (single-line answers) **don't** get a proactive offer — they're cheap enough that Mark-as-resolved alone covers them.
- If the admin says yes, follow the same write rules as `/conversation-to-automation` (frontmatter for skills, shebang for scripts, header comments naming the source) so the artifact is consistent with what the explicit path produces.

The `filestores/skills/` and `filestores/scripts/` files are the source of truth. The mirror copies them to `.claude/skills/<name>/SKILL.md` and `.claude/scripts/<name>.<ext>` so Claude Code's slash registry and `Bash` tool can discover them — but **always edit the filestore copy**, never the `.claude/` copy. The latter is overwritten on every sync.

## Scripts

Plugin scripts live at `.claude/scripts/`. Each prints one JSON line (`{"ok": true, ...}` or `{"ok": false, "error": ...}`) so you can branch on it.

| Script | What it does |
|---|---|
| `sync-resolve-conflict.mjs --prefix <p> --key <k>` | Marks one conflict resolved (rewrites the manifest entry, removes leftover shadow). Cloud mode only. |
| `sync-push.mjs [--timeout <s>]` | Pushes local entities to Pinkfish via the running OpenIT app. Cloud mode only. |
| `report-overview.mjs` | Reads tickets / people / conversations and writes a markdown helpdesk overview to `reports/<timestamp>-overview.md`. Pure file I/O — runs in <1s, no LLM. Triggered by the "Generate overview" button in the explorer; also runnable from the terminal. |

## When cloud is connected

If the user has connected this project to Pinkfish via the **Connect to Cloud** option, additional capabilities are available:

**The Pinkfish Gateway** — a unified API to all connected services (built-in MCPs + third-party connectors). Pattern:

1. `capabilities_discover` — describe what you want to do in natural language, get tool + server names back.
2. `capability_details` — get the full tool schema.
3. `gateway_invoke` — call the tool with `{ server, tool, arguments }`.

**Built-in MCP servers** (cloud-connected only):

| Resource | Server | Example tools |
|---|---|---|
| Databases (cloud) | `datastore-structured` | `create_item`, `list_items`, `search`, `natural_query` |
| Knowledge base (cloud) | `knowledge-base` | `knowledge-base_ask` (semantic search), `knowledge-base_upload_file` |
| File storage (cloud) | `filestorage` | `filestorage_create_file_from_content`, `filestorage_list_items` |
| Agents (cloud) | `agent-management` | `agent_create`, `agent_invoke`, `agent_list` |
| Workflows (cloud) | `pinkfish-sidekick` | `workflow_run`, `workflow_create`, `workflow_list` |

**Third-party connectors** (cloud-connected only) — Slack, Gmail, Salesforce, Okta, GitHub, GCP, AWS, Azure, and ~100+ others. Always start with `capabilities_discover` for these — don't guess tool names.

**Important:** even when cloud is connected, **prefer file ops for own-data operations.** A locally-edited ticket JSON syncs to Pinkfish through the engine; you don't need to also call `gateway_invoke datastore-structured update_item`. Reach for the gateway only when:

- The action targets a third-party system (e.g. *"send Alice a Slack DM"*).
- Semantic search would be meaningfully better than reading files (large KBs).
- The user explicitly asks for a gateway-shaped capability.

## Locally-installed CLI tools

OpenIT's **CLI** Workbench station maintains a marker block in this same `CLAUDE.md` listing the CLI tools the admin has installed locally — `gh`, `aws`, `gcloud`, `okta`, `op`, `tailscale`, etc. Each entry tells you what the tool is for and (for less-known tools) how to discover its surface, typically via `<tool> --help`.

When a request can be answered by an installed CLI, **prefer the CLI over hand-rolled API calls or scraping**. CLI tools auth through their own flows (`gh auth login`, `aws configure`, `okta login`, etc.); if a tool reports unauthenticated, surface that to the admin rather than guessing credentials.

### Marker block convention

OpenIT will sometimes ask you to install or uninstall CLI tools by writing a request into this chat. When that happens, you own the install (run brew, fall back to vendor docs if brew fails, debug as needed) AND the CLAUDE.md update. The block is bracketed by:

```
<!-- openit:cli-tools:start -->
## Installed CLI tools

These CLI tools are installed locally and available via Bash. Prefer them over hand-rolled API calls or scraping; for unfamiliar commands run `<tool> --help` to discover capabilities.

<!-- entry:aws -->- AWS CLI hint line here
<!-- entry:gh -->- GitHub CLI hint line here
<!-- openit:cli-tools:end -->
```

Rules:
- Each entry is one line keyed by `<!-- entry:ID -->`. The ID matches the catalog id from OpenIT's request.
- Sort entries alphabetically by id inside the block.
- Re-installing the same id replaces the line in place (no duplicates).
- If the marker block doesn't exist yet, append it at the end of `CLAUDE.md` with the standard preamble shown above.
- Removing the last entry strips the entire block (don't leave an empty scaffold).

## Permissions

Claude Code skills in this project need filesystem access. When a skill asks for `Bash` / `Read` / `Write` permission, approve once — Claude Code remembers per-project. The skills need it to:

- List and read files under `databases/` / `knowledge-bases/` / `agents/`.
- Write new ticket / conversation rows.
- Read `_schema.json` to map field IDs to plain language.
