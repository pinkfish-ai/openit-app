# OpenIT Local-First — Progress Tracker

**Companion to:** `2026-04-26-local-first-plan.md` (strategy) and `2026-04-26-local-first-impl-plan.md` (detailed implementation plan with all gotchas).

**This doc is the working tracker.** Update checkboxes as work lands. Add notes inline when something turns out different than the plan said.

---

## Status snapshot

| | |
|---|---|
| **Current phase** | Pre-Phase 1 — ready to start |
| **Open questions resolved** | **7 / 7** ✅ |
| **PRs landed** | — |
| **PRs in flight** | #19 (general improvements, awaiting BugBot), #23 (the plans) |
| **Phase plan changes from Q&A** | Phase 2 = author schemas (not snapshot); conversations as **unstructured datastore** (not markdown files); **workflows DROPPED from V1** (V2 backlog); Phase 6 = surface schema-conflict choice on existing Pinkfish orgs |

---

## Open questions — RESOLVED

All seven answered (combination of user direction + repo research). Implications baked into the phase plans below.

- [x] **Q1. Schema snapshot? — No, we DESIGN schemas.** Local is the default, so we get to define our own shapes. Pinkfish datastores accept arbitrary schemas at sync time (as long as a schema doc is provided + data conforms). User flagged: ditch the current `case-management` + `contacts` shapes; redesign for real-world ticket / people use; add a separate **conversations** store for ticket follow-ups.
  - *Implication:* Phase 2 changes substantially. **No snapshotting from Pinkfish.** We author `_schema.json` files locally as the source of truth and push them to Pinkfish on connect. See the new "Schema design" section below.
  - *Conversations gap:* a ticket has many follow-up messages; needs its own store. Proposed: markdown files in `conversations/<ticket-id>.md` (append-only thread). Files-on-disk friendly, append-friendly, grep-friendly. Ticket row carries a `conversationFile` reference. Detailed below.

- [x] **Q2. Agent runtime accepts what? — System prompt + skills (which inject MCP tools).** Confirmed via `platform/agents/nodeclaude.go:411-486`: the runtime concatenates `agent.Instructions` with preamble, chat history, file list, etc., into the system prompts for Claude. Skills with the `mcp` tag inject tool lists; non-MCP skills inject prose. **MCP tools are the cloud-only piece.** Local mode: Claude in OpenIT reads the agent JSON, treats `instructions` as system prompt, uses its built-in tools (Read/Write/Edit/Bash). No MCPs locally — that's the "Connect to Cloud" upgrade.
  - *Implication:* dual-runtime story is clean. Instructions describe **intent** in plain language; each runtime uses what it has. CLAUDE.md is the local-runtime adapter (*"the tickets datastore lives at `databases/openit-tickets-<slug>/`; create rows with `Write`"*). Cloud runtime adapts via the MCP `datastore-structured` server.
  - *Optional future:* even local agents could call MCPs via the gateway as a paid feature. User leaning toward "MCPs are part of cloud package" — clean pricing line.

- [x] **Q3. Workflow JSON shape — answered for V2.** Confirmed via `platform/entities/entities.go:1119` (`Step` struct): each step has `prompt` + optional JS `code` + `agentId` + `skillIds` (MCP tools). **User decision: workflows are NOT V1.** V1 focus is ticket responses + management. Capturing admin actions as workflows comes after the basic loop works. Phase 6.5 (local workflow runner) — **deferred to V2**. The `capture-workflow` skill — **deferred to V2** (we're not asking the admin to build workflows yet).
  - *Implication:* simpler V1. Phase 1 drops the `capture-workflow` skill rewrite (the skill stays gone for V1; its concept is preserved in the V2 backlog). Phase 6's mirror-up doesn't have to handle workflows. Phase 6.5 deletion saves ~3 days.

- [x] **Q4. Connect modal long-term? — Phased out.** Becomes the "Connect to Cloud" option in settings. Phase 3 doesn't lean on the existing modal.

- [x] **Q5. Pricing? — Free local. Pay for cloud + MCPs.** Confirmed.

- [x] **Q6. Tauri resource bundling — does the pipeline use it? — NO.** Verified: `tauri.conf.json` has no `bundle.resources` entry; no `resolve_resource` / `app_resource_dir` calls in `src-tauri/src/`. **Phase 2 sets it up from scratch.** Tauri docs: add `bundle.resources` array to `tauri.conf.json`, access via `app.path().resolve("plugin/", BaseDirectory::Resource)?` from Rust commands.

- [x] **Q7. Network audit — clean in no-creds mode.** Verified via grep:
  - **Rust-side `reqwest::Client`** uses: `pinkfish.rs` (auth — fires only on user-initiated connect), `skills.rs` (plugin manifest — `syncSkillsToDisk` is gated on creds), `kb.rs` (collection ops — only inside `pullEntity` chains gated on creds).
  - **TS-side `fetch`** all goes through `makeSkillsFetch` (cred-gated) or the engine adapters (cred-gated).
  - **No telemetry, no analytics, no error-reporting calls.** No `sentry`, `mixpanel`, `posthog`, `segment` references in `src/` or `src-tauri/`.
  - *Conclusion:* in no-creds mode, **zero outbound network calls** from OpenIT itself. The privacy claim holds. Phase 3's only job is to gate `start*Sync` + `syncSkillsToDisk` on `cloudConnected`. The bundled-plugin work in Phase 2 removes the only would-be-leaky default (manifest fetch).

---

## Schema design (Q1 follow-on)

We get to define these. Three datastore collections (clean shapes, not snapshots) + one unstructured store.

### `openit-tickets`

Each row = one IT case (the lifecycle of a question).

```jsonc
{
  "schemaVersion": "2026-04-26",
  "fields": [
    { "id": "subject",         "label": "Subject",          "type": "string" },
    { "id": "description",     "label": "Description",      "type": "text"   },
    { "id": "asker",           "label": "From (email/name)","type": "string" },
    { "id": "askerChannel",    "label": "Channel",          "type": "enum",   "values": ["openit", "slack", "email", "web", "teams"] },
    { "id": "status",          "label": "Status",           "type": "enum",   "values": ["incoming", "open", "answered", "resolved", "closed"] },
    { "id": "priority",        "label": "Priority",         "type": "enum",   "values": ["low", "normal", "high", "urgent"] },
    { "id": "assignee",        "label": "Assigned to",      "type": "string", "nullable": true },
    { "id": "tags",            "label": "Tags",             "type": "string[]", "nullable": true },
    { "id": "createdAt",       "label": "Created",          "type": "datetime" },
    { "id": "updatedAt",       "label": "Last update",      "type": "datetime" },
    { "id": "conversationFile","label": "Conversation log", "type": "string", "nullable": true,
      "comment": "relative path to a markdown file under conversations/" },
    { "id": "kbArticleRefs",   "label": "KB articles cited","type": "string[]", "nullable": true,
      "comment": "filenames in knowledge-base/ used to answer this ticket" }
  ]
}
```

Plain English IDs (`subject`, `email`, `status`) instead of opaque `f_1` / `f_2`. Pinkfish datastores accept this — confirmed via user input. CLAUDE.md teaches Claude these names directly; no schema-translation layer.

### `openit-people`

Contacts directory. Anyone who files a ticket lands here so we know who's asking.

```jsonc
{
  "schemaVersion": "2026-04-26",
  "fields": [
    { "id": "displayName", "label": "Name",         "type": "string" },
    { "id": "email",       "label": "Email",        "type": "string" },
    { "id": "role",        "label": "Role / title", "type": "string", "nullable": true },
    { "id": "department",  "label": "Department",   "type": "string", "nullable": true },
    { "id": "channels",    "label": "Reachable on", "type": "string[]", "nullable": true,
      "comment": "e.g. ['slack:U01ABC', 'email:alice@x.com']" },
    { "id": "notes",       "label": "Notes",        "type": "text", "nullable": true },
    { "id": "createdAt",   "label": "Added",        "type": "datetime" },
    { "id": "updatedAt",   "label": "Last update",  "type": "datetime" }
  ]
}
```

### Conversations — `openit-conversations` (UNSTRUCTURED datastore)

User's call: one document per message turn, in an **unstructured** datastore. Confirmed via `entities.Collection.IsStructured` — the datastore type supports both modes, and `isStructured: false` means key-value JSON blobs with no schema enforcement. Perfect fit: each turn is small, schema-flexible, and cloud sync uses the existing engine machinery instead of inventing a filestore-as-conversation-log convention.

**Local storage:** `databases/openit-conversations-<slug>/<message-id>.json` — one file per turn.

```jsonc
// databases/openit-conversations-my-helpdesk/msg-1777234500000-abc4.json
{
  "id":         "msg-1777234500000-abc4",
  "ticketId":   "ticket-1777234492000-x9q1",
  "role":       "asker",          // asker | agent | admin | system
  "sender":     "alice@example.com",
  "timestamp":  "2026-04-27T09:14:02Z",
  "body":       "My VPN is broken since this morning. Already tried restarting."
}
```

**Conventional fields, no enforcement.** We document the convention (above), Claude follows it, but the datastore itself doesn't validate. Adding a field later (e.g., `attachments`, `editedFromMessageId`) needs no schema migration.

**Cloud-side:** synced to an unstructured Pinkfish datastore. The collection's `isStructured: false` flag lives on the collection definition; mirror-up sets it.

### Reading a thread

Locally:

1. List `databases/openit-conversations-<slug>/`.
2. Read each, filter by `ticketId === <target-ticket-id>`.
3. Sort by `timestamp`.

Cheap on small/medium volumes. For a thread of, say, 20 messages, this reads 20 small JSON files — milliseconds. For a busy org with thousands of total messages across many tickets, listing the dir is still fine; we read only the files matching the target `ticketId`. (Optimization V2: a `_index.json` keyed by ticketId, written on append. Skip until needed.)

Cloud-side: Pinkfish memory API supports natural-language queries on unstructured datastores (`/memory/bquery`). *"Get all messages where ticketId = X, sorted by timestamp ascending."* The triage agent on cloud uses that.

### Why one-doc-per-turn over a single conversation file

- **Append correctness:** writing a new file is atomic. Appending to a single shared file races (two processes appending could corrupt or lose lines).
- **Conflict resolution per-message:** if Alice's reply syncs from email at the same time the admin types one in OpenIT, the conflict-resolution flow we already built handles two new files cleanly. A merged-content conflict on a single growing file is much messier.
- **Cloud-side query symmetry:** Pinkfish's unstructured datastore is naturally per-document; matches our local shape.
- **Per-turn audit trail:** each message has its own `versionDate` / `versionBy` (when synced), so editing a message after the fact is tracked separately from the others.

### `openit-kb-articles` (the knowledge base)

Already markdown files in `knowledge-base/<filename>.md`. No schema needed; existing layout works. Frontmatter is optional (description, tags, lastUpdated).

### Why this redesign matters

- **Plain-language field IDs** mean CLAUDE.md instructions read naturally. No `f_2` translation step in the agent's instructions.
- **Conversations as files** keeps the round-trip simple (filestore upload, no schema worries on push).
- **No coupling to Pinkfish's case-management template** — we don't have to worry about template drift breaking us.
- **Field semantics are explicit** (e.g. `status` enum values are documented).

Tradeoff: existing Pinkfish orgs that had `case-management` collections might already have rows with `f_1` / `f_2` field IDs from the legacy template. On first connect, we either (a) push our schema as authoritative and migrate any existing rows, or (b) leave the old shape alone if a `case-management`-shaped collection already exists. **Decision deferred** to Phase 6's connect-flow design.

---

---

## Phase 1 — Skill + agent reframing

**Estimate:** 1 day. **No engine work.** Pure prompt rewriting.

**Outcome:** in any project, asking Claude *"VPN broken"* results in Claude using `Write` to create a ticket file and `Read` on `knowledge-base/` to search, instead of `gateway_invoke`.

**Deps:** Q2 (do the new instructions also run on Pinkfish runtime?).

### Tasks

- [ ] Rewrite `scripts/openit-plugin/CLAUDE.md`:
  - [ ] Lead with *"Read and edit local files first."*
  - [ ] Move the Pinkfish Gateway section under a *"When cloud is connected"* heading.
  - [ ] Add a *"Triage agent"* section: *"This project has a triage agent at `agents/openit-triage-<slug>.json`. When the user sends a support question, follow that agent's instructions."*
- [ ] Rewrite `scripts/openit-plugin/skills/answer-ticket.md`:
  - [ ] Remove `gateway_invoke datastore-structured create_item`; replace with *"Write a row JSON file."*
  - [ ] Remove `gateway_invoke knowledge-base ask`; replace with *"Glob + Read on `knowledge-base/`."*
  - [ ] Keep gateway calls only for the third-party-action steps (e.g., *"send the reply via Slack"* — Pro-tier).
- [ ] ~~Rewrite `scripts/openit-plugin/skills/capture-workflow.md`~~ — **deferred to V2.** V1 doesn't ship workflow capture.
- [ ] New skill: `scripts/openit-plugin/skills/triage.md`:
  - [ ] Body: *"Read `agents/openit-triage-<slug>.json` for instructions; run them on the user's input."*
  - [ ] Slash command: `/triage <question>`.
- [ ] Update `scripts/openit-plugin/CLAUDE.md` skills table to include `triage`.
- [ ] Sync the rewritten files to `/web/packages/app/public/openit-plugin/` and bump manifest version.
- [ ] Sync to runtime test org (`~/OpenIT/653713545258/`).
- [ ] Manual verification:
  - [ ] Reload OpenIT in the test org. Ask Claude *"VPN broken"*.
  - [ ] Confirm a row file lands in `databases/openit-tickets-<orgId>/`.
  - [ ] Confirm Claude doesn't try to call gateway tools for it.

### Gotchas to verify before merging

- Gotcha #4 (agent runtime ambiguity) — instructions describe intent, not mechanism.
- Gotcha #12 (CLAUDE.md gateway framing) — make sure the doc reads naturally for a local user.
- Gotcha #13 (dual-runtime instructions) — Q2 needs an answer.

### Notes (fill in as we go)

—

---

## Phase 2 — Bundle plugin + ship default schemas

**Estimate:** 2-3 days.

**Outcome:** OpenIT runs without any network call for plugin content. Default datastore schemas, the triage agent, and a starter KB article scaffold on first run.

**Deps:** Q1 (schema snapshot), Q6 (Tauri bundling), Q7 (network audit).

### Tasks

- [ ] **Author schemas locally** (Q1 resolved — we design, don't snapshot):
  - [ ] Write `scripts/openit-plugin/schemas/openit-tickets._schema.json` per the "Schema design" section above.
  - [ ] Write `scripts/openit-plugin/schemas/openit-people._schema.json` per same.
  - [ ] Add `schemaVersion` field on each (`"2026-04-26"`).
  - [ ] No conversations schema — they're filestore-shaped markdown, no `_schema.json`.
- [ ] **Bundled triage agent template:**
  - [ ] `scripts/openit-plugin/agents/openit-triage.template.json` — name / description / instructions / selectedModel.
  - [ ] Instructions written tool-agnostically (intent-only). CLAUDE.md handles local-runtime mapping.
  - [ ] Use `{{slug}}` placeholder for the project slug (substituted at install time).
- [ ] **Plugin manifest update:**
  - [ ] Add the two `_schema.json` files + agent template to `files`.
  - [ ] Bump version to `2026-04-26-004`.
- [ ] **Tauri bundling (Q6 — set up from scratch):**
  - [ ] `tauri.conf.json`: add `bundle.resources: ["../scripts/openit-plugin/**/*"]` (or equivalent glob).
  - [ ] Verify Tauri build copies the resources into the bundle.
  - [ ] Confirm dev mode also exposes the resources (tauri-plugin can read from `BaseDirectory::Resource`).
- [ ] **Rust: bundled-manifest command:**
  - [ ] `skills_fetch_bundled_manifest()` in `src-tauri/src/skills.rs`. Resolves resource dir via `app.path().resolve("openit-plugin/manifest.json", BaseDirectory::Resource)?`. Reads + returns JSON.
  - [ ] `skills_fetch_bundled_file(path)` companion for individual files.
- [ ] **TS: bundled fallback:**
  - [ ] `src/lib/skillsSync.ts` `fetchSkillsManifest`: try cloud first when creds exist; on failure / no creds, fall back to bundled.
  - [ ] `fetchSkillFile`: same fallback per file.
- [ ] **Routing for new file types:**
  - [ ] `syncSkillsToDisk`: route `schemas/<col>._schema.json` → `databases/<col>-<slug>/_schema.json`. Reuse the basename-validation pattern from PR #19's script-routing fix.
  - [ ] Route `agents/openit-triage.template.json` → `agents/openit-triage-<slug>.json` with `{{slug}}` substituted.
- [ ] **Bootstrap scaffold (`src-tauri/src/project.rs`):**
  - [ ] First-run: create dirs (already does this), then let `syncSkillsToDisk` (TS-side, on first project open) write the schema / agent / starter KB. No Rust-side template strings.
  - [ ] Starter `knowledge-base/welcome.md` comes from the bundle.
  - [ ] Empty `conversations/` directory (sibling to `knowledge-base/`).
- [ ] **Manual verification:**
  - [ ] Kill network; reload OpenIT; plugin loads from bundle.
  - [ ] Fresh project: `_schema.json` files appear at `databases/openit-tickets-<slug>/_schema.json` etc.; `agents/openit-triage-<slug>.json` exists; `conversations/` exists; `knowledge-base/welcome.md` exists.
  - [ ] No outbound network calls (network monitor / Wireshark).

### Gotchas to verify

- Gotcha #1 (schema parity) — Q1 must be answered + schemas snapshot must match.
- Gotcha #2 (plugin distribution) — the bundle must work without network.
- Gotcha #16 (privacy claim) — Q7 audit complete.
- Gotcha #17 (gitignore) — schemas + agent JSONs are user-editable, NOT gitignored.
- Gotcha #19 (slug substitution) — confirm where the substitution happens and that it's deterministic.

### Notes

—

---

## Phase 3 — Connection-state model + local-only flow

**Estimate:** 2-3 days.

**Outcome:** install OpenIT fresh, skip Pinkfish, create a local project, ask the agent a question — full helpdesk on disk.

**Deps:** Q4 (connect modal long-term?), Q5 (pricing framing), Q7 (privacy audit).

### Tasks

- [ ] **App.tsx:**
  - [ ] Add `cloudConnected` state, derived from `loadCreds()`.
  - [ ] Gate all `start*Sync` calls on `cloudConnected`.
  - [ ] Skip the `PinkfishOauthModal` on no-creds; show the local welcome / project picker instead.
- [ ] **Onboarding repurpose (`src/Onboarding.tsx`):**
  - [ ] Local welcome splash: *"Create a project to get started."*
  - [ ] *"Create project"* form: free-form name → slugify → `~/OpenIT/<slug>/`.
  - [ ] *"Open existing project"* picker: scan `~/OpenIT/*/`, list dirs, show their mode (Local / Cloud-connected).
- [ ] **Header connection pill (`src/shell/Shell.tsx` or App):**
  - [ ] *"Local"* badge when not connected.
  - [ ] *"Pinkfish: connected"* badge when connected.
  - [ ] Click → opens connect / disconnect controls.
- [ ] **Connect modal repositioned:**
  - [ ] No longer onboarding-blocking.
  - [ ] Invoked from settings or the header pill click.
  - [ ] After auth success → trigger Phase 6's mirror-up (when Phase 6 lands; for now, just kick the existing sync engines).
- [ ] **Sync UI in local mode (`src/shell/SourceControl.tsx`):**
  - [ ] Sync tab visible; commit button writes locally as today.
  - [ ] *"Sync to Pinkfish"* button disabled with explainer: *"Connect Pinkfish to enable cloud sync."*
- [ ] **`sync-push.mjs` graceful degrade:**
  - [ ] Marker handler in `Shell.tsx`: if `!cloudConnected`, write a result file with `error.code: "not_connected"` and a clear message. Don't run `pushAllEntities`.
- [ ] **Dev-mode env (`VITE_DEV_*`):**
  - [ ] Add `VITE_DEV_LOCAL_ONLY=true` to skip auto-bootstrap with creds.
  - [ ] Or: dev mode uses creds if env present, falls through to local otherwise.
- [ ] **Manual verification:**
  - [ ] Erase `~/OpenIT/`; clear the keychain; install OpenIT fresh.
  - [ ] Splash shows. Create *"My Test Helpdesk"*.
  - [ ] Folder lands at `~/OpenIT/my-test-helpdesk/`.
  - [ ] Triage agent JSON, schemas, welcome KB all present.
  - [ ] Ask the agent a question. End-to-end flow works.
  - [ ] Existing `~/OpenIT/653713545258/` cloud project still works untouched.
  - [ ] Network monitor: zero unexpected calls.

### Gotchas to verify

- Gotcha #3 (engine adapters hit Pinkfish) — gating must be airtight.
- Gotcha #9 (multi-org local) — picker handles multiple folders cleanly.
- Gotcha #10 (existing cloud-bound projects) — detected and routed to cloud path.
- Gotcha #16 + Q7 (privacy audit complete).
- Gotcha #18 (dev-mode env) — easy to flip between local + cloud during development.

### Notes

—

---

## Phase 4 — Incoming-ticket banner + `/triage` skill

**Estimate:** 1 day.

**Outcome:** writing a row with `status: "incoming"` triggers a banner. Clicking it pastes the triage flow into Claude.

**Deps:** Phase 3 (banner needs the connection-state-aware Shell).

### Tasks

- [ ] **`src/lib/ticketStatus.ts`:**
  - [ ] Add `incoming` to the escalated-value allowlist OR (preferable) add a separate detection path emitting via `subscribeIncomingTickets`.
  - [ ] Decide: same banner with mixed states, or two banners (incoming = "actionable", escalated = "needs human review")? Lean **two banners** — they imply different actions.
- [ ] **`src/shell/IncomingTicketBanner.tsx`:**
  - [ ] New banner. Green-leaning palette ("actionable, not alarming").
  - [ ] *"1 new ticket — handle with Claude"*. Click → `/triage` invocation with the ticket path.
  - [ ] Same `refreshTick` dismiss-clear semantic as the conflict + escalated banners.
- [ ] **CSS in `src/App.css`:**
  - [ ] `.incoming-ticket-banner-*` styles.
- [ ] **Mount in `src/shell/Shell.tsx`:**
  - [ ] After ConflictBanner + EscalatedTicketBanner.
- [ ] **`scripts/openit-plugin/skills/triage.md` (already added in Phase 1):**
  - [ ] Verify it's invoked correctly when banner pastes.
- [ ] **Manual verification:**
  - [ ] `Write` a row file with status `incoming`.
  - [ ] Banner appears within fs-tick interval (~500ms).
  - [ ] Click → `/triage` with the row path lands in Claude.
  - [ ] Triage runs the loop; row's status moves to `answered` or `open`.
  - [ ] Banner clears.

### Gotchas

- Gotcha #6 (schema drift) — make sure detection uses the schema-aware lookup we already built.

### Notes

—

---

## Phase 5 — Localhost intake form

**Estimate:** 2-3 days.

**Outcome:** a coworker hits a URL on the IT admin's machine, fills a form, files a ticket. Banner fires.

**Deps:** Phase 4.

### Tasks

- [ ] **Rust: `src-tauri/src/intake_server.rs`:**
  - [ ] Tiny `axum` HTTP server bound to `127.0.0.1:<port>` (random per launch, or settable).
  - [ ] Endpoint: `GET /` returns a single-page form (name, email, question).
  - [ ] Endpoint: `POST /ticket` writes a row JSON to `databases/openit-tickets-<slug>/incoming-<uuid>.json` with status `incoming`.
  - [ ] Server starts on project open, stops on close.
  - [ ] Lifecycle wired into the existing project open/close flow.
- [ ] **TS: settings panel surface (or temp toggle in header):**
  - [ ] Show the intake URL.
  - [ ] *"Allow LAN access"* checkbox: switches bind to `0.0.0.0`. Default off (privacy).
- [ ] **Project switch:**
  - [ ] Stop the old server, start a new one with the new project's intake destination.
- [ ] **Port collision handling:**
  - [ ] If port in use (second OpenIT instance), pick another port. Log; don't crash.
- [ ] **Manual verification:**
  - [ ] Open OpenIT in a project. Find the intake URL.
  - [ ] Open URL in a browser. Submit form.
  - [ ] Verify row JSON appears with `status: incoming`.
  - [ ] Banner fires.
  - [ ] Switch projects. Verify URL changes; new submissions go to the new project.
  - [ ] Toggle LAN access. Try hitting from another device on the LAN. Confirm reachable.

### Gotchas

- Gotcha #7 (privacy / public exposure) — default `127.0.0.1` only.
- Gotcha #20 (project switch) — server lifecycle.
- Gotcha #21 (port collision) — graceful fallback.

### Notes

—

---

## Phase 6 — Connect-to-Pinkfish upgrade flow

**Estimate:** 3-5 days. **The biggest single phase.**

**Outcome:** local project + Connect button → fully cloud-bound, all local data mirrored, engine takes over for ongoing sync.

**Deps:** Phase 3 (connection state); Phases 1-5 done so there's a real local project to mirror.

### Tasks

- [ ] **`src/lib/cloudConnect.ts` — new module:**
  - [ ] `connectToPinkfish(creds, repo)` orchestrator.
  - [ ] Step 1: store creds, set `cloudConnected: true`.
  - [ ] Step 2: invoke `mirrorUp(repo)`.
  - [ ] Step 3: kick `start*Sync` for all entities.
- [ ] **`mirrorUp(repo)` — the heavy lift:**
  - [ ] **KB:** ensure `openit-<slug>` collection exists on Pinkfish; create if not. Push every local markdown file.
  - [ ] **Filestore:** ensure `openit-docs-<slug>` collection exists; create if not. Push every local file. **Conversations** (`conversations/*.md`) also push to filestore — one blob per conversation.
  - [ ] **Datastore (people, tickets, any custom):** for each `databases/<collection>/`, ensure the collection exists on Pinkfish; if creating, **push our locally-authored `_schema.json` as the schema** (Pinkfish accepts arbitrary schemas). Push every row.
  - [ ] **Existing-collection schema reconciliation:** if a Pinkfish org already has `openit-tickets` with the legacy `case-management` shape (e.g., `f_1`/`f_2` field IDs), **don't auto-migrate**. Surface to the user: *"Pinkfish has an older-shape `openit-tickets` collection. Keep it (and use the legacy schema locally) / Replace it (push our schema, migrate rows) / Cancel."* Phase-6 V1 = surface the choice, default = Cancel + show the schemas side-by-side.
  - [ ] **Agents:** for each local agent JSON without an `id`, POST `/service/useragents`. Record the server-issued `id` back into the JSON. Note: agent's `selectedModel` field metadata-only locally; cloud runtime enforces.
  - [ ] ~~**Workflows:**~~ — V2. No `workflows/` dir contents to push in V1.
- [ ] **Mirror-up uses the engine's push paths with override:**
  - [ ] Set `pulled_at_mtime_ms = 0` for every manifest entry → engine sees everything as local-changed → push fires.
- [ ] **Schema reconciliation:**
  - [ ] If Pinkfish has the collection already (existing org), compare schemas. If they match → fine. If local is newer/older → push the local schema as authoritative for V1; surface conflict in V2.
- [ ] **`disconnectFromPinkfish()`:**
  - [ ] Stop sync engines.
  - [ ] Clear creds (keychain + state).
  - [ ] `cloudConnected: false`. Engine dormant. Local files untouched.
- [ ] **Settings UI:**
  - [ ] Connect / disconnect controls.
  - [ ] When connected: show org name, last-sync timestamp.
- [ ] **Identity drift (different org on reconnect):**
  - [ ] On connect, if `creds.orgId` differs from any IDs stored in `.openit/<entity>-state.json`, strip stale IDs, treat as fresh mirror-up.
- [ ] **Manual verification:**
  - [ ] Start fresh local project. Add 5 KB articles, file 3 tickets, edit the triage agent.
  - [ ] Click Connect. Auth succeeds.
  - [ ] Verify in Pinkfish UI: KB collection has 5 articles; tickets datastore has 3 rows; agent exists.
  - [ ] Edit a KB article in Pinkfish. Wait for poll. Verify it pulls down to local.
  - [ ] Edit the same article locally. Sync. Verify it pushes up.
  - [ ] Disconnect. Edit locally. Reconnect. Verify the engine picks up the local changes (or surfaces a conflict).

### Gotchas

- Gotcha #5 (agent IDs) — round-trip identity is critical.
- Gotcha #6 (schema drift) — V1 = local authoritative.
- Gotcha #8 (mirror-up) — `pulled_at_mtime_ms = 0` trick.
- Gotcha #14 (workflow JSON shape) — Q3 needs an answer.
- Gotcha #22 (reconnect with offline edits) — conflict resolution flow handles it.

### Notes

—

---

## Phase 7+ — Deferred (V2)

Track here so it doesn't get lost. Workflows are the big V2 item — V1 ships without them.

### Phase 7a — Local KB-ask V2 (lexical scoring)

- [ ] `scripts/openit-plugin/scripts/kb-ask.mjs` — BM25 / TF-IDF over markdown files.
- [ ] Triage agent's instructions reference the script as the V2 path.

### Phase 7b — Local KB embeddings

- [ ] `@xenova/transformers` (Node-side) for distilled sentence-transformer.
- [ ] Index built on KB write (fs-watcher trigger).
- [ ] Vector search replaces lexical.

### Phase 7c — Schema migration on connect

- [ ] Detect schema-version mismatch on connect.
- [ ] Migrate local rows to match remote schema (or vice versa).
- [ ] Surface unresolvable conflicts to the user.
- [ ] Specifically: handle the legacy `case-management`-shape collisions (existing Pinkfish orgs that have `f_1`/`f_2` field IDs).

### Phase 7d — Workflows (V2)

The whole workflow story moves here. Three sub-pieces, all V2:

- [ ] `capture-workflow` skill — turn admin-handled action-shaped tickets into workflow JSON. Match the Pinkfish `Step` shape (`prompt` + optional JS `code` + `agentId` + `skillIds`). Confirmed via `platform/entities/entities.go:1119`.
- [ ] `run-workflow.mjs` local runner — walks the steps, executes JS via `vm.runInNewContext`, stubs MCP calls (cloud unlocks them). Returns `{ ok, completed_steps, errors, outputs }`.
- [ ] Triage-agent auto-routing — when an incoming ticket matches a workflow trigger, invoke the workflow instead of escalating.
- [ ] CLAUDE.md gets a workflow section explaining the local-stub-vs-cloud-real distinction.

V1 explicitly does NOT include any of this. Admins answer tickets manually; KB articles capture answers. Workflows enter the picture once the basic loop is proven and admins start asking for "this is the same thing every week, can we automate it?"

### Notes

—

---

## Working notes — things found mid-implementation

(Use this section as we go. Capture surprises that didn't fit the plan.)

—
