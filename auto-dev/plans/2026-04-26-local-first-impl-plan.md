# OpenIT Local-First — Implementation Plan

**Status:** Draft. Concrete plan beneath the strategic doc (`2026-04-26-local-first-plan.md`). This document maps the strategy to specific files, functions, schemas, and edge cases.

**Goal of this doc:** surface every gotcha before we hit it. Better to argue about an open question now than discover it mid-implementation.

---

## Table of contents

1. [Architecture audit: what assumes cloud](#architecture-audit-what-assumes-cloud)
2. [The connection-state model](#the-connection-state-model)
3. [Per-entity local representation](#per-entity-local-representation)
4. [Default schemas (bundled)](#default-schemas-bundled)
5. [The bootstrap flow](#the-bootstrap-flow)
6. [The agent runtime in local mode](#the-agent-runtime-in-local-mode)
7. [Local KB-ask](#local-kb-ask)
8. [Local ticket intake](#local-ticket-intake)
9. [The plugin distribution problem](#the-plugin-distribution-problem)
10. [The "Connect to Pinkfish" upgrade flow](#the-connect-to-pinkfish-upgrade-flow)
11. [Workflow runtime in local mode](#workflow-runtime-in-local-mode)
12. [Migration story for existing users](#migration-story-for-existing-users)
13. [Per-file change inventory](#per-file-change-inventory)
14. [Phase-by-phase implementation order](#phase-by-phase-implementation-order)
15. [Gotchas (consolidated)](#gotchas-consolidated)
16. [Open questions](#open-questions)
17. [Test strategy](#test-strategy)

---

## Architecture audit: what assumes cloud

Before deciding what changes, here's what currently runs against Pinkfish on startup or on first connect:

| Code path | Assumes Pinkfish? | Notes |
|---|---|---|
| `App.tsx` `useEffect` startup | Yes — calls `loadCreds()`, `startAuth()`, then `start*Sync` for all 5 entities | Conditional on creds being present, but dev mode auto-bootstraps. |
| `PinkfishOauthModal.tsx` | Yes — entire purpose is Pinkfish auth | Onboarding requires it today. |
| `kbSync.startKbSync` → `resolveProjectKb` | Yes — REST call to skills API to list/create KB collections | Creates `openit-<orgSlug>` on Pinkfish. |
| `filestoreSync.startFilestoreSync` → `resolveProjectFilestores` | Yes — REST list/create filestore collections | Creates `openit-docs-<orgId>`. |
| `datastoreSync.startDatastoreSync` → `resolveProjectDatastores` | Yes — REST list/create datastore collections | Creates `openit-people-<orgId>`, `openit-tickets-<orgId>` from `case-management` template. **The template is server-side** — we don't currently bundle the schema. |
| `agentSync.startAgentSync` → `resolveProjectAgents` | Yes — REST `/service/useragents` list | Read-only today; PR #20's bootstrap was going to add a POST. |
| `workflowSync.startWorkflowSync` | Yes — REST `/service/automations` list | Read-only. |
| `skillsSync.syncSkillsToDisk` | Yes — fetches plugin manifest from `https://<env>/openit-plugin/manifest.json` | Phase manifest delivers CLAUDE.md, skills, scripts. |
| Engine 60s polling | Yes — every adapter's `listRemote` hits Pinkfish | Fine to disable when local-only. |
| Conflict-resolve script | Touches local manifest only | No network. **Already cloud-agnostic.** |
| `sync-push.mjs` | Triggers app-side `pushAllEntities` which hits Pinkfish | Only relevant when connected. |
| `pushAllEntities` (kb / filestore / datastore push) | Yes — REST writes | Only invoked from connected mode. |

**What's already local-only:**

- The bidirectional sync engine's manifest format (`.openit/<entity>-state.json`).
- Conflict-shadow file convention (`<base>.server.<ext>`).
- Conflict aggregate + banner.
- `git_ops` (`.gitignore`, `git_ensure_repo`, auto-commit).
- File explorer, viewer, source-control tab, terminal pane.
- `_welcome.md`, project bootstrap (folder + dirs).

The engine's primitives — manifest, lock, shadow rule, conflict aggregate — are mode-agnostic. They just don't engage when no adapter calls `pullEntity`.

---

## The connection-state model

Single boolean throughout the app: `cloudConnected` (boolean, derived from `loadCreds()` returning non-null).

`App.tsx` becomes:

```ts
const [cloudConnected, setCloudConnected] = useState(false);

// On startup: only start sync engines if cloud is connected.
useEffect(() => {
  Promise.all([stateLoad(), loadCreds()]).then(([s, creds]) => {
    setRepo(s.last_repo);
    if (creds) {
      setCloudConnected(true);
      startKbSync(...);
      startFilestoreSync(...);
      // ... etc
      syncSkillsToDisk(...);
    }
    // else: local-only mode. No sync engines. fs-watcher still runs.
  });
}, []);
```

The `stop*Sync` functions exist already; they're just no-ops if nothing started. `cloudConnected: false` keeps the engines dormant.

Connection state is surfaced in:

- The header pill — *"Local"* (no cloud) vs *"Pinkfish: connected"* (cloud).
- The Sync tab — its push button no-ops in local mode (or hides; see [Sync UI in local mode](#sync-ui-in-local-mode) below).
- The connect/disconnect controls — moved from forced-on-onboarding into a settings toggle.

### Sync UI in local mode

The Sync tab's "Sync to Pinkfish" button doesn't make sense if there's nowhere to sync to. Options:

- **A.** Hide the Sync tab entirely when `cloudConnected === false`. Pro: cleaner UX. Con: breaks muscle memory for users who flip cloud on/off.
- **B.** Show the tab but the button reads *"Connect Pinkfish to sync"* and opens the connect modal.
- **C.** Show the tab with the local git history (commits land regardless), but disable cloud-push.

Lean **C** — git history is genuinely useful local-only (track your own changes), and a disabled-but-visible button explains what cloud unlocks.

### sync-push.mjs in local mode

The script writes a marker file and polls for a result. In local-only mode, the marker handler in `Shell.tsx`:

- Reads the marker.
- Writes a result file with `status: error, error: { code: "not_connected", message: "Pinkfish is not connected. Connect via the header to sync." }`.
- Doesn't run `pushAllEntities` (would fail; creds are null).

Claude (when invoking the script) sees the error and tells the user how to connect.

---

## Per-entity local representation

For each, what local-only means concretely.

### Knowledge base

- **Storage:** markdown files under `knowledge-base/<filename>.md`.
- **Search (V1):** Claude reads files via `Read` / `Glob` / `Grep`. Works for ~tens of articles.
- **Search (V2):** `kb-ask.mjs` script (see [Local KB-ask](#local-kb-ask)).
- **Authoring:** any markdown editor; or Claude writes via the `Write` tool.
- **Schema:** none — markdown is the schema.
- **Engine impact:** when cloud-disconnected, the KB adapter never runs. The directory is just files.

### Datastore

- **Storage:** JSON files under `databases/<collection-name>/<row-id>.json`. `_schema.json` lives next to them describing fields.
- **Validation (V1):** advisory only. Claude reads `_schema.json` and tries to follow it; we don't reject malformed rows. The bidirectional sync will reject mismatches when cloud is connected.
- **Validation (V2):** a `validate-row.mjs` script Claude can run before writing. Optional.
- **Operations:**
  - Create row: `Write` a new JSON file.
  - Update row: `Edit` the JSON file.
  - List rows: `Glob` the dir.
  - Query rows: Claude reads + filters; or a `query.mjs` script for big tables.
  - Delete row: `Bash rm` the file.
- **IDs:** when cloud-disconnected, IDs are filenames (e.g., `row-<uuid>.json`). When connected, the engine maps filename ↔ Pinkfish row-id via the manifest.

### Filestore

- **Storage:** files under `filestore/<filename>`. Any extension.
- **Operations:** standard FS.
- **No schema, no validation.**
- **Engine impact:** none in local-only.

### Agents

- **Storage:** JSON config files under `agents/<name>.json`.
- **Shape:** mirrors Pinkfish's `entities.UserAgent` minimal subset — `name`, `description`, `instructions`, `selectedModel`, optional `isShared`. **No `id` field while local-only.** When connected, the engine adds the server-issued `id` on first push/pull.
- **Runtime:** **Claude in OpenIT chat** when invoked by the user. Pinkfish runtime additionally when cloud-connected (channel ingest, always-on).
- **Bundled defaults:** the triage agent, written on bootstrap. See [The agent runtime in local mode](#the-agent-runtime-in-local-mode).

### Workflows

- **Storage:** JSON files under `workflows/<name>.json`.
- **Shape:** `name`, `description`, `triggers[]`, `steps[]`. The `steps` reference gateway-tool calls when invoking third-party systems (those are Pro-tier-only at runtime).
- **Runtime (V1):** Claude reads the workflow JSON and follows it inline. No separate runner.
- **Runtime (V2 / cloud):** Pinkfish workflow runtime runs them on schedule / trigger.

### Tickets

- A datastore. `databases/openit-tickets-<projectName>/`. The schema (`_schema.json`) is the same case-management template; bundled.

### People

- A datastore. `databases/openit-people-<projectName>/`. Schema is the contacts template; bundled.

---

## Default schemas (bundled)

This is the highest-stakes gotcha. **Currently the case-management and contacts templates are server-side** — Pinkfish creates them when we POST to the datacollection API with `templateId`. Locally, we need to ship the same shape.

### What's needed

A bundled `_schema.json` for each default datastore, baked into OpenIT's binary (or its plugin) and written to disk on bootstrap.

### Where the schemas come from

Two paths:

- **A.** Reverse-engineer them from a connected Pinkfish org (run a connect, fetch the schema from a freshly-created collection, snapshot the JSON, bundle).
- **B.** Reach into `/platform` or wherever the templates are defined and lift the schema source.

Lean **A** for V1 — cheap, gets us a known-good snapshot. (B) is the long-term answer when we want server-side template updates to flow into local.

### Schema versioning

The bundled schemas need a version number. Future updates need:

- A way to detect old-version local schemas → migrate.
- A way to coexist with Pinkfish-side schema changes (e.g., a new field added by the platform team).

Decision: each `_schema.json` has a top-level `schemaVersion: <date-ish-string>`. Bootstrap writes the bundled version. Migration logic (Phase 7+) compares on connect, reconciles.

For V1 we won't ship migration. The bundled schema is locked. If Pinkfish's case-management template changes upstream, we re-snapshot and ship a new OpenIT version — users update OpenIT to pick up the new schema.

### Field-id stability

Pinkfish schemas use opaque field IDs (`f_1`, `f_2`). The bundled schemas need to match the field IDs Pinkfish would use, otherwise:

- A locally-created ticket has `{f_1: "VPN broken"}` per local schema.
- User connects to Pinkfish.
- The case-management template on Pinkfish has its own `f_1` mapping (maybe `f_1` is `subject` server-side, but the bundled local schema has `f_1` as `description`).
- Field semantics shift on push. Bad.

The bundled schema MUST exactly match Pinkfish's case-management template — same field IDs, same labels, same types. (A) above is the way to guarantee this; we snapshot a real Pinkfish schema and bundle it verbatim.

**Risk:** if Pinkfish's template changes after we snapshot, locally-created data and Pinkfish's expectations diverge silently. Mitigation: the schema versioning above + a connect-time check ("local schema version X, Pinkfish version Y — let's reconcile"). Phase 7 work.

### Bundled schema location in repo

`scripts/openit-plugin/schemas/openit-tickets._schema.json` — versioned with the rest of the plugin source.

`project_bootstrap` (Rust) reads them from the plugin path on first run and writes to disk. Or `skillsSync` syncs them along with skills/scripts.

Lean: **`skillsSync`** path. Schemas are part of the plugin distribution. The plugin manifest gets a new entry type:

```json
{ "path": "schemas/openit-tickets._schema.json" }
```

`syncSkillsToDisk` routes `schemas/<col>._schema.json` to `databases/<col>-<projectName>/_schema.json` on disk. (Path-traversal validation as we did for scripts.)

---

## The bootstrap flow

What happens on first run, by mode.

### Local-only (no creds)

1. App starts. `loadCreds()` returns null.
2. **No onboarding modal.** Instead: a "Welcome to OpenIT" splash that says *"Create a project to get started."*
3. User clicks *"Create project"*. Modal asks for a project name (free-form text — *"My Helpdesk"*).
4. Slug → `~/OpenIT/<slug>/`. Bootstrap that folder via `project_bootstrap`.
5. **Plugin distribution kicks in** (see below) — write CLAUDE.md, skills, scripts, schemas to disk.
6. Default datastores get scaffolded: `databases/openit-tickets-<slug>/_schema.json` + `databases/openit-people-<slug>/_schema.json`. Empty rows.
7. Triage agent JSON written: `agents/openit-triage-<slug>.json`.
8. Empty `knowledge-base/welcome.md` (a starter article).
9. Engine sync NOT started — no creds.
10. App lands on the project. Claude pane spawns; user can ask the agent a question right away.

**Time-to-first-value:** if the plugin is bundled (no network), this should be under 5 seconds.

### Cloud-connected (existing flow)

Mostly preserved:

1. App starts. `loadCreds()` returns creds.
2. Skip the local welcome splash.
3. Existing connect-flow: bootstrap project, run all `start*Sync` engines, fetch plugin manifest from Pinkfish.
4. Engine pulls down agents, datastores, KB, filestore, workflows.

The difference from today: no automatic creation of default datastores from Pinkfish templates *if they already exist locally*. The connect flow becomes "merge local + cloud," not "fetch cloud over local."

### Cloud-connected after starting local

This is the upgrade flow. See [The "Connect to Pinkfish" upgrade flow](#the-connect-to-pinkfish-upgrade-flow).

### Project picker

OpenIT scans `~/OpenIT/` for existing projects (folders with a `.openit/` or `agents/` dir). On startup, if any exist, show a picker: *"Open <project>"* / *"Create new project"*. Same picker for switching projects.

State persisted: `last_repo` already exists in app state.

---

## The agent runtime in local mode

The crux of the local-first story. **Claude in OpenIT IS the triage agent runtime.** No separate process, no Pinkfish runtime needed for V1.

### How Claude knows it's the triage agent

Three signals in concert:

1. **CLAUDE.md** has a section: *"This project has a triage agent at `agents/openit-triage-<slug>.json`. When the user sends a question that looks like a support request (someone needs help with an IT thing), behave as the triage agent: read the agent's `instructions` field and follow it. The instructions tell you to log the ticket, search the KB, and answer or escalate."*

2. **The agent JSON** has the actual instructions string. Claude reads the JSON, finds `.instructions`, treats those as its working prompt for this loop.

3. **A skill: `/triage <user-question>`** is the explicit invocation form. The skill body says *"Read the user's input, then act per `agents/openit-triage-<slug>.json`'s `instructions`."*

Both work. Implicit (CLAUDE.md → triage) for natural-feel; explicit (`/triage`) for "yes, please run the triage flow on this." User picks.

### What the agent's instructions look like (local-first)

Same shape as today (PR #20's instructions text), but the action verbs change:

```
You are openit-triage, an IT helpdesk triage agent.

When you receive a question:

1. **Log the ticket.** Generate a row id (timestamp + 4 random chars).
   Read `databases/openit-tickets-<slug>/_schema.json` to learn field IDs
   and labels. Write a JSON file at
   `databases/openit-tickets-<slug>/<row-id>.json` with:
     - the question text in the description/body field
     - status field set to "open"
     - asker name if available
     - the timestamp
   Use the `Write` tool. Do not call any gateway / network tool.

2. **Search the knowledge base.** Use the `Glob` and `Read` tools to
   list `knowledge-base/*.md` and read the relevant files. Match by
   filename and section headings.
   - If you find a confident answer, write a clear reply to the user
     using that information. Then `Edit` the ticket row: status →
     "answered", append the answer text to the response field, note
     which KB article(s) you cited.
   - If you don't find a confident answer, reply: "I don't have an
     answer for that yet — I've logged your question and an admin
     will follow up." Leave the ticket status as "open".

3. **Always log, always reply.** No silent drops.

Rules:
- Never invent answers. If KB doesn't know, escalate.
- Be concise — lead with the answer or next step.
- If the question is unclear, ask ONE clarifying question, then log
  the ticket once you have the answer.
```

The instructions never mention `gateway_invoke`. They reference Claude Code's built-in tools only.

### When cloud is connected, both runtimes work

The same agent JSON gets pushed to Pinkfish. Pinkfish's runtime runs it on channel events (Slack DM → triage agent → reply). When the user is in OpenIT, Claude-in-OpenIT also runs it on direct chat input.

Two runtimes, one spec. The agent file is the source of truth.

This means the cloud-mode instructions need to ALSO work server-side — or we maintain two versions. The simpler path: instructions describe what to do in plain English; both runtimes interpret. Pinkfish's runtime reads the instructions and uses gateway tools (because that's what it has); local Claude reads the same instructions and uses Read/Write/Edit (because that's what it has). The instructions don't dictate the *mechanism*, just the *intent*.

**Proposed instruction style:** describe the intent (*"create a ticket row in the openit-tickets datastore"*) without dictating the tool. Each runtime picks its own mechanism. Test both. If runtimes drift, version the instructions per-runtime as a fallback.

---

## Local KB-ask

The triage agent needs to find answers. Three escalating implementations.

### V1 — Claude reads files

For ~tens of articles. Claude lists `knowledge-base/`, reads filenames, reads the most likely-relevant 2-3 files based on filename match + reading the first paragraph of each, returns the relevant info.

This is what Claude does naturally with `Glob` + `Read`. No new code. Works.

### V2 — `kb-ask.mjs` script

For ~hundreds of articles. A script that takes a question, returns the top 3 matching articles by simple lexical scoring (BM25 / TF-IDF on the markdown content). Claude calls it as a tool.

```bash
node .claude/scripts/kb-ask.mjs "vpn password reset"
# → JSON: { matches: [{ path, score, snippet }, ...] }
```

Lightweight, no dependencies (pure Node), no embeddings. Bundled with the plugin.

### V3 — Local embeddings

For thousands of articles. Sentence-transformers via `@xenova/transformers` (runs in Node, distilled models). Builds an index on KB write. Replaces V2's lexical match with a vector search.

Punt to Phase 4. V1 is enough until it isn't.

### When cloud is connected

The agent's instructions say *"search the KB."* Local Claude grep-reads files. Cloud Pinkfish runtime uses `knowledge-base_ask` (semantic, embeddings-backed). Same intent, different mechanism. Cloud is genuinely better at large KBs — that's a real value-prop for the upgrade.

---

## Local ticket intake

How does a "ticket" enter the system in local-only mode?

### V1 — admin types in chat

The IT admin opens OpenIT. Their team member texts/emails/Slacks them: *"My VPN is broken."* Admin pastes into Claude: *"I have a question from Alice: my VPN is broken."* Claude (acting as triage) runs the loop.

Crude, but: the loop runs end-to-end on day-1, no infrastructure.

### V1.5 — incoming-ticket banner

A new banner (parallel to escalated-ticket) detects rows with `status: "incoming"` (a new status value distinct from `open`). When detected, banner: *"1 new ticket — handle with Claude"*. Click → pastes a prompt invoking triage on those rows.

The banner needs the row to come from somewhere. In V1 the admin uses Claude's `Write` tool to create the row, but at that point why not just use V1?

The intent here is: when V1.5's web form (or a future intake mechanism) writes to disk, the banner fires automatically. Decouples the trigger from "admin types in chat."

### V1.5.b — localhost web form

A tiny HTTP server, spawned by Tauri, on `localhost:<port>` (random per launch). Single-page form: name, email, question. POST writes a row file with `status: "incoming"`. The fs-watcher fires; the incoming-banner shows.

User shares the URL on their LAN. Coworkers file tickets through the form without OpenIT installed.

Tauri can spawn an HTTP server via the `axum` crate (or similar) inside the Rust side. Trivial.

**Security consideration:** the form is on `localhost` so other LAN users can hit it only if they're on the same machine, OR if OpenIT explicitly binds to `0.0.0.0`. The default should be `127.0.0.1` only; "share with my LAN" is an opt-in checkbox in settings that switches the bind. Public exposure (over a router) is intentionally hard — that's the Pro tier with channel ingest.

### V2 — channel ingest (Pro)

Slack / email / Teams bridge from Pinkfish into the local triage flow. Pinkfish receives the channel message, writes a row into the user's project (via the bidirectional engine), the local-side incoming-banner fires (or Pinkfish's runtime answers directly).

Out of scope for V1.

---

## The plugin distribution problem

Today the plugin is fetched from Pinkfish at `https://<env>/openit-plugin/manifest.json`. Local-only mode has no such URL.

### The fix

**Bundle the plugin with OpenIT.** Tauri can include resource files via `tauri.conf.json` → `bundle.resources`. The plugin's `manifest.json`, `CLAUDE.md`, `skills/*.md`, `scripts/*.mjs`, and `schemas/*.json` get baked into the OpenIT binary.

`syncSkillsToDisk` becomes:

1. Try cloud manifest fetch (`skills_fetch_manifest`). If it succeeds, use cloud's manifest (latest version, may have new skills).
2. If cloud isn't connected (or fetch fails), fall back to the bundled manifest.

This means cloud-connected users get latest plugin updates automatically; local users get the version bundled with their installed OpenIT. They miss nothing functional; cloud is just one extra path to get plugin updates.

### Tauri-side: reading the bundled manifest

A new Tauri command: `skills_fetch_bundled_manifest()` that reads from the resource directory and returns the JSON. `skillsSync` calls it as the fallback.

### Schemas through the same channel

`scripts/openit-plugin/schemas/openit-tickets._schema.json` lives in the plugin source. Manifest entry:

```json
{ "path": "schemas/openit-tickets._schema.json" }
```

`syncSkillsToDisk` routes:

```
schemas/<colName>._schema.json → databases/<colName>-<slug>/_schema.json
```

(With the same path-traversal validation we added for scripts in PR #19.)

---

## The "Connect to Pinkfish" upgrade flow

The user has a working local helpdesk. They want cloud features. What happens?

### The button

In settings (or header connect-pill), *"Connect to Pinkfish"*. Click → existing OAuth flow. On success:

1. Creds stored in keychain.
2. `cloudConnected` flips to true.
3. Trigger a one-shot **mirror-up** operation.
4. Start the engine's per-entity sync.

### Mirror-up

For each local entity, push to Pinkfish:

- **KB:** if the user's Pinkfish org has no `openit-<slug>` KB collection, create it. Push every local markdown file.
- **Filestore:** ditto.
- **Datastore (people, tickets, custom):** for each local collection, create it on Pinkfish via the datacollection API. Push every row.
- **Agents:** POST every local agent JSON to `/service/useragents`. Records the server-issued ID in the local agent JSON for round-trip.
- **Workflows:** same for `/service/automations`.

This is essentially a pre-pull-skip-disabled push of everything. The engine's existing `pushAllEntities` does most of the work; we just have to seed the manifest with `pulled_at_mtime_ms = 0` for every entry so push sees everything as local-changed.

After mirror-up, normal bidirectional sync engages. Existing engine code handles ongoing changes.

### Schema reconciliation

Most-likely gotcha: the user's local datastore schemas (bundled snapshot from a few months ago) don't match what `case-management` template currently produces server-side.

**Decision tree on connect:**

- Local schema version === Pinkfish schema version → trivial, no reconciliation.
- Local schema older than Pinkfish → migrate locally (rename/add fields, leave existing rows alone).
- Local schema newer than Pinkfish → push the local schema as authoritative. Pinkfish accepts user-modified schemas.
- Schemas diverged in incompatible ways (rare; field semantics changed) → surface to the user, ask which side wins.

For V1 of the connect flow, lean **"local schema is authoritative on first connect"**: we push the schema as part of mirror-up. Server accepts it. Future schema drift becomes a sync conflict like any other.

### Reverse: disconnect

Settings: *"Disconnect from Pinkfish"*. Drops creds, stops sync engines, leaves all local files alone. User keeps everything they had locally; future edits don't reach Pinkfish until reconnect.

### Identity mapping

When local-only, agents/workflows have no `id` field. After mirror-up, Pinkfish issues IDs. We record them in the local JSON. Subsequent disconnect/reconnect cycles preserve the IDs (the JSON stays).

If the user connects to a *different* Pinkfish org (rare but possible), the IDs are wrong. Detection: on connect, the user's Pinkfish org id changes vs. what's stored in `.openit/<entity>-state.json`. Strip stale IDs, treat as fresh mirror-up.

---

## Workflow runtime in local mode

The capture-workflow skill writes `workflows/<name>.json`. Who runs it?

### V1 — Claude as runtime

When a triage event matches a workflow's trigger, Claude (still acting as triage) reads the workflow JSON and follows the steps inline. Same pattern as the agent: instructions are data, Claude is the interpreter.

The triage agent's CLAUDE.md gets a section: *"Before falling back to KB search, list `workflows/`. If any workflow's trigger matches the incoming ticket, follow the workflow's steps instead."*

### V2 — workflow runner script

`node .claude/scripts/run-workflow.mjs --workflow <name> --ticket <path>`. Walks the steps, calls Claude as a sub-process where needed.

Punt unless V1 turns out to be unreliable.

### V3 / cloud — Pinkfish workflow runtime

Existing infrastructure. Workflows pushed to Pinkfish run server-side on triggers (channel events, schedules, API calls) without anyone's laptop being on. Pro tier.

---

## Migration story for existing users

Current testing org: `~/OpenIT/653713545258/` (Pinkfish org-id-keyed folder). After local-first ships:

- This existing folder keeps working **as-is**, in cloud-connected mode. The detection: it has a `.openit/` with manifests pointing at Pinkfish data. We treat that as "this is a cloud-bound project."
- New projects (not Pinkfish-org-keyed) start local. Folder name = user-chosen project name slug.
- Folder layout convention: `~/OpenIT/<project-slug-or-orgid>/`. Both styles coexist.

The project picker on startup lists all `~/OpenIT/*/` dirs and shows them with their mode (Local / Cloud-connected).

### Existing-cloud-project users won't see local-first

Until they create a new project. They keep using their current cloud-bound flow.

### Bringing an existing cloud project to local

A "Disconnect from Pinkfish" gesture in settings: stops engines, drops creds, the project becomes local-only. All the Pinkfish-side data they pulled to disk stays. Future edits don't push.

To rejoin: reconnect.

---

## Per-file change inventory

Concrete files and what changes in each.

### Phase 1: skill + agent reframing (no engine work)

| File | Change |
|---|---|
| `scripts/openit-plugin/CLAUDE.md` | Lead with *"Read and edit local files first. Reach for the gateway only for connected systems."* Move the gateway section under "When cloud is connected." Add a section: *"This project has a triage agent at `agents/openit-triage-<slug>.json` — read and follow its instructions when handling support questions."* |
| `scripts/openit-plugin/skills/answer-ticket.md` | Rewrite the per-ticket steps to use `Read` / `Write` / `Edit`. Replace `gateway_invoke datastore-structured create_item` with *"Write a row file to `databases/openit-tickets-<slug>/<row-id>.json`."* Replace `gateway_invoke knowledge-base ask` with *"List and Read `knowledge-base/*.md`."* |
| `scripts/openit-plugin/skills/capture-workflow.md` | Same rewrite. Step instructions use file ops; example workflow JSON's gateway-tool steps stay (those run cloud-side when triggered). |
| `src/lib/agentSync.ts` | Strip the cloud bootstrap logic from PR #20 (which closed). Keep the existing read-only sync flow gated on `cloudConnected`. |

### Phase 2: bootstrap scaffold (no engine work)

| File | Change |
|---|---|
| `src-tauri/src/project.rs` | Bootstrap writes `_schema.json` for default datastores (read from the bundled plugin), the triage agent JSON, an empty `knowledge-base/welcome.md`. Write all on first run. |
| `src/lib/skillsSync.ts` | New routing: `schemas/<col>._schema.json` → `databases/<col>-<slug>/_schema.json`. Path-traversal validation as for scripts. |
| `src-tauri/src/skills.rs` | New command `skills_fetch_bundled_manifest()` reading from Tauri resource dir. Returns the bundled manifest JSON. |
| `src/lib/skillsSync.ts` | `fetchSkillsManifest`: try cloud first; on failure (or no creds), fall back to bundled. |
| `tauri.conf.json` | Add `bundle.resources` entry pointing at the plugin's source dir. |
| `scripts/openit-plugin/manifest.json` | Bump version. Add schema entries. (Already exists in `/web`; add to repo too.) |
| `scripts/openit-plugin/schemas/openit-tickets._schema.json` | New. Snapshot from a connected Pinkfish org. |
| `scripts/openit-plugin/schemas/openit-people._schema.json` | New. Same. |
| `scripts/openit-plugin/agents/openit-triage.template.json` | New. The triage agent's bundled config. Schema-token replaced with `<slug>` at write time. |

### Phase 3: connection-state model + UI

| File | Change |
|---|---|
| `src/App.tsx` | `cloudConnected` state. Gates all `start*Sync` calls. Local-only path: skip onboarding modal, render project picker / create-project. |
| `src/PinkfishOauthModal.tsx` | No longer onboarding-required. Becomes the "Connect to Pinkfish" flow, invoked from settings or header. |
| `src/Onboarding.tsx` | Repurposed as the local-only welcome / project picker / create-project flow. |
| `src/shell/Shell.tsx` | Header connection pill: `Local` vs `Pinkfish: connected`. |
| `src/shell/SourceControl.tsx` | Sync button disabled with explainer when cloud-disconnected. |

### Phase 4: incoming-ticket banner

| File | Change |
|---|---|
| `src/lib/ticketStatus.ts` | Already detects escalated. Add `incoming` status; emit a separate aggregate. |
| `src/shell/IncomingTicketBanner.tsx` | New banner, parallel to EscalatedTicketBanner. *"1 new ticket — handle with Claude"* → pastes triage invocation. |
| `src/shell/Shell.tsx` | Mount IncomingTicketBanner after the existing two. |
| `src/App.css` | New banner palette (green-leaning to read as "actionable, not alarming"). |
| `scripts/openit-plugin/skills/triage.md` | New skill. The full triage flow. Invoked on `/triage <question>` or by the incoming-ticket banner. |

### Phase 5: localhost intake form (V1.5)

| File | Change |
|---|---|
| `src-tauri/src/intake_server.rs` | New. Tiny `axum` HTTP server bound to `127.0.0.1:<port>`. Single endpoint `POST /ticket` writes a row JSON. Returns the URL. |
| `src-tauri/src/lib.rs` | Wire the intake server lifecycle to project open/close. |
| `src/shell/Settings.tsx` (or similar) | Show the intake URL. Toggle for "Allow LAN access" (binds to `0.0.0.0`). |

### Phase 6: connect-flow / mirror-up

| File | Change |
|---|---|
| `src/lib/cloudConnect.ts` | New. `connectToPinkfish(creds, repo)` orchestrates auth + mirror-up + sync-engine start. |
| `src/lib/cloudConnect.ts` | `mirrorUp(repo)` — creates Pinkfish-side collections for each local entity, pushes everything, records server-issued IDs back into local manifests. Uses the engine's existing push paths with a "treat everything as local-changed" override. |
| `src/PinkfishOauthModal.tsx` | After auth success, kick mirror-up. Show progress. |
| `src/lib/cloudConnect.ts` | `disconnectFromPinkfish()` — stops engines, clears creds. Keeps local files. |

### Phase 7+: local KB-ask V2, embeddings, schema migration

Out of scope for the initial implementation. Stubs in the plugin for `kb-ask.mjs` later.

---

## Phase-by-phase implementation order

Strict dependency order. Each phase ships as a stacked PR.

### Phase 1 — Skill + agent reframing (1 day)

**No engine work. Pure prompt rewriting.**

Outcome: in a connected project, asking Claude "VPN broken" results in Claude using `Write` to create a ticket file and `Read` on `knowledge-base/` to search, instead of routing through gateway. The triage flow runs locally even in a cloud-connected project, because Claude is now the runtime.

Testable: existing `~/OpenIT/653713545258/` project. Reload OpenIT, ask Claude a question. Verify it writes to `databases/openit-tickets-<orgId>/`.

### Phase 2 — Bundle plugin + ship default schemas (2-3 days)

Cloud-mode-compatible: the bundled plugin is a fallback; cloud-connected users still get the latest manifest from Pinkfish.

Outcome: a Tauri build that doesn't need network for the plugin. Existing users see no change. Lays the foundation for Phase 3.

Testable: kill network, reload OpenIT, plugin still loads.

### Phase 3 — Connection-state model + local-only flow (2-3 days)

The big UX shift. Onboarding split. Project picker. `cloudConnected` gates engines.

Outcome: install OpenIT fresh, skip Pinkfish, create a local project, ask the agent a question — full helpdesk on disk.

Testable: erase `~/OpenIT/`, reset keychain, install OpenIT, walk through.

### Phase 4 — Incoming-ticket banner + `/triage` skill (1 day)

Outcome: writing a row with `status: "incoming"` triggers a banner. Clicking it pastes the triage flow into Claude.

Testable: manually `Write` an incoming ticket file. Banner appears. Click. Triage runs.

### Phase 5 — Localhost intake form (2-3 days)

Outcome: a coworker hits a URL on the IT admin's machine, fills a form, files a ticket. Banner fires.

Testable: open the URL in a browser, submit the form, watch the row appear and the banner show.

### Phase 6 — Connect-to-Pinkfish upgrade flow (3-5 days)

Outcome: local project + Connect button → fully cloud-bound, all local data mirrored, engine takes over for ongoing sync.

Testable: start fresh local, accumulate some tickets/KB articles, connect, verify everything appears in Pinkfish.

### Phase 7 — Local KB-ask V2 + schema migration (when needed)

Punt unless a user complains.

### Total

Phases 1-6: ~12-15 working days for the implementation. Plus testing / iteration.

---

## Gotchas (consolidated)

The list, in priority order. Each one needs a decision before its blocking phase.

| # | Gotcha | Where it bites | Decision |
|---|---|---|---|
| 1 | Default schemas need to match Pinkfish's case-management template exactly (field IDs + labels). | Phase 2 / Phase 6. | Snapshot from a real Pinkfish org. Bundle. Version the schema. Phase 7 handles drift. |
| 2 | Plugin manifest is fetched from Pinkfish today. | Phase 2. | Bundle as Tauri resource. Cloud is an override; local is the fallback. |
| 3 | Engine adapters all hit Pinkfish. | Phase 3. | Gate `start*Sync` on `cloudConnected`. No code changes inside the engine. |
| 4 | Agent runtime ambiguity: who runs the triage flow? | Phase 1. | **Claude in OpenIT IS the runtime.** CLAUDE.md + agent JSON + a `/triage` skill all point at it. Cloud Pinkfish runtime ALSO runs it server-side when connected. |
| 5 | Agent IDs (`agent-123`) only exist server-side. | Phase 6. | Local-only agents have no `id`. On first push, Pinkfish issues one; we record it back into the JSON. |
| 6 | Pinkfish's schema for case-management may evolve after we snapshot. | Long term. | Schema versioning + a connect-time reconciliation step (Phase 7). |
| 7 | The intake form needs to work without exposing the user's machine to the internet. | Phase 5. | Bind `127.0.0.1` by default. "Share with my LAN" is opt-in (`0.0.0.0`). Public exposure stays Pro-tier. |
| 8 | Mirror-up on first connect needs to push everything, including new schemas/agents. | Phase 6. | Engine's existing push path with `pulled_at_mtime_ms = 0` override. New agents POST'd; new datastore collections created via the datacollection API. |
| 9 | Multi-org local — can a user have two separate local helpdesks? | Phase 3. | Yes. Project name → folder name. Project picker on startup. |
| 10 | Existing cloud-bound projects (`~/OpenIT/<orgId>/`) need to keep working unchanged. | Phase 3. | Detect via existing manifests + creds. They take the cloud path. New projects take the local path. |
| 11 | Conflict-resolve script + content-equivalence + force-push sentinel — all PR #19 / pre-PR #19 work — should be no-op locally. | Phase 3. | They are. They only fire inside `pullEntity`, which only runs when an adapter calls it, which only happens when `cloudConnected`. |
| 12 | The plugin's `CLAUDE.md` describing the gateway will be wrong for local users. | Phase 1. | Rewrite to lead with file ops; gateway is "when cloud is connected." |
| 13 | Triage agent's instructions need to work for BOTH runtimes (local Claude + Pinkfish runtime). | Phase 1. | Describe the *intent* (*"create a ticket row"*), not the *mechanism*. Each runtime picks its own tools. |
| 14 | Workflow JSON shape needs to match Pinkfish's runtime expectation (so it works server-side after push). | Phase 6 + capture-workflow skill update. | Snapshot the actual workflow shape from `pinkfish-sidekick`. Skill body's example matches it. |
| 15 | Local KB-ask V1 (Claude reads files) doesn't scale past tens of articles. | Phase 4 / Phase 7. | V2 = `kb-ask.mjs` lexical scoring. V3 = embeddings. Punt until a user complains. |
| 16 | Privacy claim "fully local" needs to be defensible. | Phase 3. | Network audit. Identify any default-on calls. Plugin manifest fetch is the main one — Phase 2 fixes it. Document what remains. |
| 17 | OpenIT's `_welcome.md` is written at bootstrap and gitignored (PR #19). New scaffolded files (schemas, agents, default KB article) need similar treatment — should they be gitignored? | Phase 2. | NO. Schemas + default agent JSON are user-editable; they should be tracked. Welcome.md is the exception (frequently regenerated). |
| 18 | The dev-mode `VITE_DEV_*` env vars currently auto-bootstrap with creds. | Phase 3. | Add `VITE_DEV_LOCAL_ONLY=true` to skip auth in dev. Or: dev mode uses creds if env present, local otherwise. |
| 19 | When user runs `/triage` and the agent JSON references `<slug>`, who substitutes the slug? | Phase 1 / Phase 2. | Bootstrap writes the agent JSON with the literal slug substituted (e.g., `openit-tickets-my-helpdesk`). Skill body references the agent file by literal path; agent's instructions reference the datastore by literal name. |
| 20 | The intake form's HTTP server lifecycle is tied to project open. What if the user switches projects? | Phase 5. | Restart server with the new project's intake destination on switch. Easy. |
| 21 | A user might bind two OpenIT instances to the same `~/OpenIT/<slug>/` (e.g., dev + main on the same machine). | Phase 5 — intake server. | Port collision. Fail gracefully — second instance picks a different port or skips intake. |
| 22 | Cloud-bound project with stale local data: user disconnects, edits offline, reconnects. | Phase 6. | Engine handles via the existing conflict-resolve flow. Disconnect simply stops the engine; local edits accumulate; reconnect fires conflict detection + resolution. |
| 23 | The bundled triage agent's `selectedModel` is `sonnet`. Pinkfish-side runtime needs to know which model. Does Claude-in-OpenIT respect this field? | Phase 1. | Local Claude is whatever the user has running (typically Claude Code's default). The `selectedModel` field is metadata for the cloud runtime, not enforced locally. Document this. |
| 24 | Schema-token substitution — the bundled `_schema.json` may need the project slug interpolated (e.g., for collection-name fields). | Phase 2. | Snapshot what real schemas contain. If they're slug-free, no substitution needed. Likely the case. |
| 25 | What happens if a local-only user wants to share a project with a coworker? | Pro tier. | Cloud connection is the answer. Pre-cloud, they can ZIP the folder and email it (it's just files). Document. |

---

## Open questions

These need confirmation before implementation:

1. **Schema snapshot:** can we run a real connect against a Pinkfish org and capture the case-management + contacts schemas verbatim? Or do we need source access to `/platform`?

2. **Pinkfish runtime — does it actually accept arbitrary instructions?** The plan assumes the cloud-side agent runtime can run any instructions text. Need to confirm: are there hard schema requirements (specific tools mentioned, specific format) we'd need to comply with?

3. **Workflow JSON shape.** Phase 6's mirror-up needs to push workflows to `pinkfish-sidekick`. What's the exact JSON shape that runtime accepts? The capture-workflow skill's example needs to match.

4. **What's the long-term story for the connect modal?** Is it being phased out in favor of programmatic connect (settings panel)? If yes, Phase 3's UI work shouldn't lean too hard on it.

5. **Pricing model commitment.** The plan assumes "free local + paid cloud." Is that the actual go-to-market plan? If not (e.g., paid-from-day-1, with a free trial), the implementation doesn't need the local mode to be production-grade.

6. **Tauri resource bundling — does the build pipeline already do this elsewhere?** If not, Phase 2 includes setting it up. Tauri docs are clear on how but it's a config change worth verifying.

7. **OpenIT's "telemetry" / network calls.** Need to grep for any analytics, error reporting, etc. that fire by default. Local-first claim breaks if any of those phone home unconditionally.

---

## Test strategy

Per phase, the things to verify.

### Phase 1 — agent + skill reframing

- Unit: skill markdown files don't reference `gateway_invoke` for own-data ops. (Grep test.)
- Integration: in the existing testing org, ask Claude a question. Verify a row file lands in `databases/openit-tickets-<orgId>/` and Claude doesn't try to call gateway tools for it.

### Phase 2 — bundled plugin

- Unit: `skills_fetch_bundled_manifest` returns valid JSON.
- Integration: kill network, reload OpenIT, plugin loads from bundle. Skills still run.
- Schema match: bundled `_schema.json` deeply equals what Pinkfish would create from the case-management template. (Run a connect against a fresh Pinkfish org, fetch the resulting schema, deep-compare.)

### Phase 3 — connection-state + local-only

- Unit: `cloudConnected: false` doesn't call any `start*Sync`.
- Integration: erase `~/OpenIT/`, no creds in keychain, install OpenIT. Splash → create project → end up in a working project. Triage agent answers a question. Verify zero network calls.
- Regression: existing cloud-bound project still works.

### Phase 4 — incoming-ticket banner

- Unit: `subscribeIncomingTickets` emits when an `incoming` row appears.
- Integration: write a row file with status incoming. Banner shows. Click → `/triage` invocation lands in Claude.

### Phase 5 — localhost intake

- Unit: `intake_server` returns 201 on valid POST, writes the row file.
- Unit: 127.0.0.1-only by default; LAN bind opt-in.
- Integration: open URL in browser, submit form, row appears, banner fires.

### Phase 6 — connect flow

- Integration: local project with N tickets / M KB articles → click Connect → all N+M land on Pinkfish.
- Conflict edge: local edit + Pinkfish has a different value for the same row → engine's conflict-resolve flow fires.
- Disconnect: drops creds, leaves local files.

---

## Bottom line

This plan walks the local-first vision down to specific files, schemas, and gotchas. The biggest risks are (1) **schema parity with Pinkfish** (gotcha #1 — needs a clean snapshot), (2) **the agent-runtime-on-both-sides framing** (gotcha #4 / #13 — instructions need to work for both Claude-in-OpenIT and Pinkfish runtime), and (3) **the connect-flow's mirror-up** (gotcha #8 — pushing everything as local-changed without surprises).

Phases 1-3 are mechanical and ship a working local helpdesk. Phase 6 is where the bidirectional sync engine we've already built earns its keep.
