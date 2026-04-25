---
name: OpenIT
description: IT operations and service management plugin for Claude Code. Manage tickets, provision employees, query systems, and automate workflows.
---

## Thesis

Claude Code is the substrate for modern IT ops — admins describe their service desk in plain English and Claude authors workflows, schemas, and integrations as files on disk. OpenIT is **scaffolding** around that, not architecture: a Tauri shell + a plugin (in `/web`) that ships skills, `CLAUDE.md` context, and **Node scripts**. Both the OpenIT app and Claude-in-the-terminal invoke the same scripts — single code path. A user without OpenIT can run Claude in `~/OpenIT/<org>/` and get identical behavior.

Claude orchestrates by:
- (a) **calling Pinkfish-owned MCPs directly** (`pinkfish-sidekick`, `agent-management`, `knowledge-base`, `filestorage`, `datastore-structured`, `http-utils`) — for specialized reads like `knowledge-base_ask` or `datastore-structured_natural_query`. Stable contracts we own.
- (b) **calling third-party MCPs via the gateway** — `mcp_discover` → `capabilities_discover` → `capability_details` → invoke. Anything touching a connector (Slack, Zendesk, Salesforce, Jira, Okta, GitHub, GCP, AWS, Azure, …). Never invoke third-party MCPs directly — the gateway resolves which connection to use per org.
- (c) **calling the platform REST API directly** (`/automations`, `/user-agents`, `/resources`, `/memory/items`) — for any Pinkfish-entity CRUD. REST is the canonical source.
- (d) **running local scripts shipped with the plugin** (sync, conflict resolution, entity-management — anything OpenIT could do, Claude can do)
- (e) **triggering Pinkfish workflows** the user has built
- (f) **calling system CLIs** on the user's machine (`gcloud`, `bq`, `az`, `aws`, `kubectl`, `okta`, `gh`, …) — **if a CLI can answer the question well, prefer it.** Investigating an Azure AD permission, a BigQuery row count, a GCP IAM grant, a Kubernetes pod state? The native CLI is faster and more accurate than bespoke automation. Don't reinvent.

**Quick decision tree:** investigating with a system tool → CLI. Pinkfish entity, mutating or syncing → REST. Pinkfish entity, specialized read (semantic / NL query / ask) → built-in MCP. Anything in a connected SaaS → gateway discover/invoke. Sync engine itself → plugin scripts.

Wider product context: `/Users/benrigby/Documents/GitHub/autonomous-dev/research/itsm/pinkfish-itsm-concept.md`. Detailed channel strategy: `auto-dev/plans/2026-04-25-bidirectional-sync-plan.md` § "Channel selection".

---

On Connect, we sync: 
* Claude plugin with manifest here: https://dev20.pinkfish.dev/openit-plugin/manifest.json (or whichever env user has set in their connect details)
* databases (create 2 default dbs if none exist)
* filestores (create 1 defailt if none exist)
* knowledge bases (create 1 defailt if none exist)
* workflows
* agents

In each of these cases, we're looking for entities prefixed with "openit-"
Everything should SYNC after connect. ALL assets (that have dates newer than what's on the file system). 

And then every 60s, we check for new assets on the remote (that have dates newer than what's on the file system). 


# Tech

Tauri desktop wrapper for Claude Code, targeted at IT admins building Pinkfish ITSM solutions.

This is **scaffolding around Claude Code, not a forked IDE**. It launches a Claude Code session in an embedded terminal, plus a file explorer, file/results viewer, Versions drawer, and Deploy button. Everything OpenIT writes to disk is identical to what Claude Code in a regular terminal writes — users can graduate from OpenIT to a terminal at any time without changing the project.

See `auto-dev/plans/` for the implementation plan.

## Prerequisites

- macOS (Windows + Linux supported by Tauri but not yet tested)
- Node.js 20+
- Rust stable (`rustup`)
- Xcode Command Line Tools on macOS (`xcode-select --install`)

## Develop

```bash
npm install
npm run tauri dev
```

The dev window opens with an embedded terminal. If `claude` is on your PATH, it launches automatically; otherwise it falls back to your shell.

## Build

```bash
npm run tauri build
```

Produces an unsigned `.app` / `.dmg` in `src-tauri/target/release/bundle/`. Code signing is tracked separately.

## Repos
/openit-app (this app)
/web (claude plugin and scripts live here for public download)

## Script dev workflow

Sync logic lives in plugin scripts shipped from `/web/packages/app/public/openit-plugin/scripts/`. To iterate:

1. Connect once — scripts land in `~/OpenIT/<orgId>/.claude/scripts/`.
2. Edit them in place there. Test by running sync (or `node .claude/scripts/sync-pull.mjs` directly).
3. When working, copy back to `/web/packages/app/public/openit-plugin/scripts/`, bump `manifest.json` version, push.
4. Don't reconnect mid-dev — the manifest sync overwrites local edits with the canonical version.
