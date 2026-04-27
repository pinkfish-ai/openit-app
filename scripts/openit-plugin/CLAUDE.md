# OpenIT — local-first IT helpdesk

This project is the user's IT helpdesk. They are the admin — they own and run it. Tickets, knowledge base, agents, and contacts all live as plain files on disk in this folder. OpenIT runs entirely locally by default; if the user has connected the project to Pinkfish (their cloud account), the "When cloud is connected" section near the bottom describes the additional capabilities that turn on (channel ingest, third-party integrations via MCP, multi-device sync, semantic KB search).

You're Claude, helping the admin run this helpdesk. Most of what they'll ask you to do is read, edit, or create files in this folder.

## Directory layout

| Path | What's there |
|---|---|
| `databases/tickets/*.json` | Ticket rows, structured. `_schema.json` next to them documents fields. |
| `databases/people/*.json` | Contacts directory, structured. |
| `databases/conversations/<ticketId>/msg-*.json` | One subfolder per ticket thread; one JSON file per turn inside it. **Unstructured** — no schema enforcement. Subfolder name = `ticketId` so all turns for a ticket live together. |
| `knowledge-base/*.md` | Solution articles. Markdown. The "answer once" capture target. |
| `filestores/library/*` | Curated reference files — runbooks, scripts, recurring docs the admin keeps handy. Cloud-synced via the existing filestore sync engine. |
| `filestores/attachments/<ticketId>/*` | Operational attachment storage — files dropped into the chat intake by the asker, or files the admin attached to a reply. One subfolder per ticket so attachments stay tied to their thread. |
| `agents/<name>.json` | Agent configurations. The triage agent lives at `agents/triage.json`. |
| `workflows/<name>.json` | (Future, V2.) Captured action playbooks. |

The directory names are stable — same in local mode and after connecting to cloud. The cloud sync engine maps these to per-org collections on Pinkfish at push time; the local layout doesn't change.

## How to interact with the data — local file ops first

Everything is on disk. Default to the built-in tools:

- **Read** — open a file. Lists with `Glob`. Search content with `Grep`.
- **Write** — create a new file (e.g., new ticket, new KB article).
- **Edit** — update an existing file (e.g., set a ticket's status to `resolved`, append a turn to a conversation).
- **Bash** — list directories, count files, run scripts the project provides.

You don't need to call any gateway / network tool to read or write tickets, KB articles, agent configs, or contact records. Those are just files. Reach for the gateway only when the user is asking you to do something involving a connected third-party system (Slack, Okta, GitHub, GCP) — and even then, only when cloud is connected.

## The triage agent

The triage agent's persona lives at `agents/triage.json` (`name`, `selectedModel`, `instructions`). It's invoked by the `ai-intake` skill — see Skills below — once per turn the chat-intake server runs. Edit the `instructions` field there to tweak how the agent talks to end users; that's the source of truth for the agent's voice.

You don't normally run the triage flow yourself — `ai-intake` does. But if the admin asks you ad-hoc questions about ticket / conversation / people data, the file conventions you'd use are:

- **Ticket** → `databases/tickets/ticket-<id>.json`. Status enum: `incoming` → `agent-responding` (chat is live, agent composing) → `resolved` (answered) or `escalated` (needs admin). `closed` for fully done. `databases/tickets/_schema.json` has the full field list in plain-language labels.
- **Person** → `databases/people/<sanitized-email>.json`. Idempotent — skip the write if a row with that email already exists. Schema next door.
- **Conversation turn** → `databases/conversations/<ticketId>/msg-<unix-ms>-<rand>.json`. Subfolder name = `ticketId`. Fields: `id`, `ticketId`, `role` (`asker` / `agent` / `admin`), `sender`, `timestamp` (ISO-8601 UTC), `body`.
- **KB lookup** → `Glob "knowledge-base/*.md"` then `Read` the most relevant. Filename + headings usually enough cue.

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
| `connect-to-cloud` | Admin (desktop) | The user wants to connect this project to Pinkfish (cloud companion) — for public intake URL, channel ingest, multi-device sync, always-on agents. Conversational walkthrough: one step at a time, confirm, advance. |
| `resolve-sync-conflict` | Admin (desktop) | The conflict banner hands you sync conflicts (cloud mode only). Per-conflict merge + resolve-script call + optional push. |
| `deploy` | Admin (desktop) | Push current local state to Pinkfish. Cloud-connected only. |

## Scripts

Plugin scripts live at `.claude/scripts/`. Each prints one JSON line (`{"ok": true, ...}` or `{"ok": false, "error": ...}`) so you can branch on it.

| Script | What it does |
|---|---|
| `sync-resolve-conflict.mjs --prefix <p> --key <k>` | Marks one conflict resolved (rewrites the manifest entry, removes leftover shadow). Cloud mode only. |
| `sync-push.mjs [--timeout <s>]` | Pushes local entities to Pinkfish via the running OpenIT app. Cloud mode only. |

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

## Permissions

Claude Code skills in this project need filesystem access. When a skill asks for `Bash` / `Read` / `Write` permission, approve once — Claude Code remembers per-project. The skills need it to:

- List and read files under `databases/` / `knowledge-base/` / `agents/`.
- Write new ticket / conversation rows.
- Read `_schema.json` to map field IDs to plain language.
