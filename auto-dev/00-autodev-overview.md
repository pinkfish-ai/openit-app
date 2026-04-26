# OpenIT — project + dev-process overview

## Thesis

Claude Code is the substrate for modern IT ops — admins describe their service desk in plain English and Claude authors workflows, schemas, and integrations as files on disk. OpenIT is **scaffolding** around that, not architecture: a Tauri shell + a plugin (in `/web`) that ships skills, `CLAUDE.md` context, and **Node scripts**. Both the OpenIT app and Claude-in-the-terminal invoke the same scripts — single code path. A user without OpenIT can run Claude in `~/OpenIT/<org>/` and get identical behavior.

Claude orchestrates by:
- (a) **calling Pinkfish-owned MCPs directly** (`pinkfish-sidekick`, `agent-management`, `knowledge-base`, `filestorage`, `datastore-structured`, `http-utils`) — for specialized reads like `knowledge-base_ask` or `datastore-structured_natural_query`. Stable contracts we own.
- (b) **calling third-party MCPs via the gateway** — `mcp_discover` → `capabilities_discover` → `capability_details` → invoke. Anything touching a connector (Slack, Zendesk, Salesforce, Jira, Okta, GitHub, GCP, AWS, Azure, …). Never invoke third-party MCPs directly — the gateway resolves which connection to use per org.
- (c) **calling the platform REST API directly** (`/automations`, `/user-agents`, `/resources`, `/memory/items`) — for any Pinkfish-entity CRUD. REST is the canonical source.
- (d) **running local scripts shipped with the plugin** (sync, conflict resolution, entity-management — anything OpenIT could do, Claude can do)
- (e) **triggering Pinkfish workflows** the user has built
- (f) **calling system CLIs** on the user's machine (`gcloud`, `bq`, `az`, `aws`, `kubectl`, `okta`, `gh`, …) — **if a CLI can answer the question well, prefer it.** Don't reinvent.

**Quick decision tree:** investigating with a system tool → CLI. Pinkfish entity, mutating or syncing → REST. Pinkfish entity, specialized read (semantic / NL query / ask) → built-in MCP. Anything in a connected SaaS → gateway discover/invoke. Sync engine itself → plugin scripts.

Wider product context: `/Users/benrigby/Documents/GitHub/autonomous-dev/research/itsm/pinkfish-itsm-concept.md`.
Channel strategy: `auto-dev/plans/2026-04-25-bidirectional-sync-plan.md` § "Channel selection".

## What syncs on connect

Every entity prefixed `openit-` mirrors between `~/OpenIT/<orgId>/` and Pinkfish:
- Claude plugin (manifest at `https://dev20.pinkfish.dev/openit-plugin/manifest.json` or the user's env)
- Datastores (create 2 defaults if none exist)
- Filestores (create 1 default if none exist)
- Knowledge bases (create 1 default if none exist)
- Workflows
- Agents

On connect, anything with a `updatedAt` newer than the local file pulls down. Then every 60s the same diff runs as a background poll.

## Tech

Tauri desktop wrapper for Claude Code targeted at IT admins building Pinkfish ITSM solutions. **Scaffolding around Claude Code, not a forked IDE** — launches a Claude session in an embedded terminal plus file explorer, viewer, Versions drawer, and Deploy button. Everything OpenIT writes to disk is identical to what a regular terminal writes; users can graduate to a terminal any time without changing the project.

### Repos
- `/openit-app` — this app (Tauri + React).
- `/web` — Claude plugin and scripts live here for public download.

### Prerequisites
- macOS (Windows + Linux supported by Tauri but not yet tested)
- Node.js 20+
- Rust stable (`rustup`)
- Xcode Command Line Tools on macOS (`xcode-select --install`)

### Develop
```bash
npm install
npm run tauri dev
```
Dev window opens with an embedded terminal. If `claude` is on PATH it launches automatically; otherwise it falls back to your shell.

### Build
```bash
npm run tauri build
```
Produces an unsigned `.app` / `.dmg` in `src-tauri/target/release/bundle/`. Code signing tracked separately.

### Plugin script dev loop
Sync logic lives in plugin scripts shipped from `/web/packages/app/public/openit-plugin/scripts/`. To iterate:
1. Connect once — scripts land in `~/OpenIT/<orgId>/.claude/scripts/`.
2. Edit in place there. Test via sync, or `node .claude/scripts/sync-pull.mjs` directly.
3. When working, copy back to `/web/.../scripts/`, bump `manifest.json` version, push.
4. Don't reconnect mid-dev — manifest sync overwrites local edits with canonical.

---

# Dev process

4 stages. Each produces a concrete artifact.

- **01-brief.md** — write a brief in Linear (the *why* + scope).
- **02-impl-plan.md** — implementation plan as a dated markdown file under `auto-dev/plans/`. Becomes the contract for the work.
- **03-testing.md** — tests written + green locally before opening the PR.
- **04-PR.md** — PR opened, BugBot loop run to clean.

Skip the ceremony for trivial fixes (one-line bug, doc typo). Use it for anything that would benefit from being reviewed against an explicit plan.

**BugBot stop-condition:** keep iterating until the only remaining findings are Low-severity. At that point reply with rationale (or fix), resolve, merge.
