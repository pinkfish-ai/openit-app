# OpenIT Local-First — Progress Tracker

**Companion to:** `2026-04-26-local-first-plan.md` (strategy) and `2026-04-26-local-first-impl-plan.md` (detailed implementation plan with all gotchas).

**This doc is the working tracker.** Update checkboxes as work lands. Add notes inline when something turns out different than the plan said.

---

## Status snapshot

| | |
|---|---|
| **Current phase** | Pre-Phase 1 — open questions outstanding |
| **Open questions resolved** | 0 / 7 |
| **PRs landed** | — |
| **PRs in flight** | #19 (general improvements, awaiting BugBot), #23 (the plans) |

---

## Open questions (must resolve before Phase 1)

These block specific phases — answer them before that phase starts. Each links to the impl-plan gotcha that triggered the question.

- [ ] **Q1. Schema snapshot.** Can we run a real connect against a Pinkfish org and capture the `case-management` + `contacts` template schemas verbatim? If not, do we need source access to `/platform`?
  - *Blocks:* Phase 2.
  - *Why it matters:* the bundled local schemas MUST match Pinkfish's field IDs / labels exactly, otherwise round-trip on cloud-connect breaks silently.
  - *Notes:*

- [ ] **Q2. Pinkfish runtime accepts arbitrary instructions?** When we push a triage agent to Pinkfish, does the runtime accept any instructions text, or are there schema requirements (must mention specific tools, specific format, etc.)?
  - *Blocks:* Phase 1, Phase 6.
  - *Why it matters:* the same agent JSON needs to run on both Claude-in-OpenIT (which has Read/Write/Edit) and Pinkfish runtime (which has gateway tools). If the runtime requires specific tool names in the instructions, the dual-runtime story breaks.
  - *Notes:*

- [ ] **Q3. Workflow JSON shape.** What's the exact JSON shape `pinkfish-sidekick` accepts for workflows authored locally and pushed?
  - *Blocks:* Phase 6, the `capture-workflow` skill's example.
  - *Why it matters:* the skill's example workflow JSON has to match the runtime's actual acceptance criteria, otherwise pushed workflows fail server-side validation.
  - *Notes:*

- [ ] **Q4. Connect modal — long-term?** Is the existing OAuth modal phased out in favor of a programmatic connect (settings panel)? If yes, Phase 3 shouldn't lean on it.
  - *Blocks:* Phase 3.
  - *Notes:*

- [ ] **Q5. Pricing model commitment.** Is "free local + paid cloud" the actual go-to-market plan? Or paid-from-day-1 with a free trial?
  - *Blocks:* Phase 3 (UX framing) — strictly speaking, not the engineering. But it shapes the messaging and the project-picker experience.
  - *Notes:*

- [ ] **Q6. Tauri resource bundling.** Does the build pipeline already do `bundle.resources` anywhere? If not, Phase 2 includes the config setup.
  - *Blocks:* Phase 2.
  - *Quick check:* `grep -r "bundle.resources\|tauri-bundle\|resourceDir" tauri.conf.json src-tauri/`
  - *Notes:*

- [ ] **Q7. Network audit — what fires by default today?** Any telemetry, error reporting, analytics, plugin manifest fetches, etc. that fire on startup with no creds?
  - *Blocks:* Phase 3 (the privacy claim depends on this audit).
  - *Quick check:* `grep -rn "fetch\|axios\|invoke.*http\|reqwest::Client" src/ src-tauri/src/ | grep -v test`
  - *Notes:*

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
- [ ] Rewrite `scripts/openit-plugin/skills/capture-workflow.md`:
  - [ ] Same rewrite for own-data ops in the skill's reasoning steps.
  - [ ] Workflow JSON example: confirm shape against Q3 before locking in.
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

- [ ] **Schema capture (Q1):**
  - [ ] Run a fresh connect against a dev Pinkfish org.
  - [ ] Capture the `case-management` template's schema (full JSON).
  - [ ] Capture the `contacts` template's schema.
  - [ ] Save to `scripts/openit-plugin/schemas/openit-tickets._schema.json` and `scripts/openit-plugin/schemas/openit-people._schema.json`.
  - [ ] Add `schemaVersion` field at the top of each (e.g., `"schemaVersion": "2026-04-26"`).
- [ ] **Bundled triage agent template:**
  - [ ] `scripts/openit-plugin/agents/openit-triage.template.json` — the agent JSON with `<slug>` placeholders.
- [ ] **Plugin manifest update:**
  - [ ] Add `schemas/openit-tickets._schema.json`, `schemas/openit-people._schema.json`, `agents/openit-triage.template.json` to manifest's `files`.
  - [ ] Bump version to `2026-04-26-004`.
- [ ] **Tauri bundling:**
  - [ ] `tauri.conf.json` → `bundle.resources` includes `scripts/openit-plugin/`.
  - [ ] Verify Tauri build copies the resources into the binary.
- [ ] **Rust: bundled-manifest command:**
  - [ ] New command `skills_fetch_bundled_manifest()` in `src-tauri/src/skills.rs` reading from Tauri resource dir.
  - [ ] Returns the manifest JSON string.
- [ ] **TS: bundled fallback:**
  - [ ] `src/lib/skillsSync.ts` `fetchSkillsManifest`: try cloud first; on failure / no creds, fall back to bundled.
  - [ ] `fetchSkillFile`: same fallback for individual files.
- [ ] **Routing for new file types:**
  - [ ] `syncSkillsToDisk`: route `schemas/<col>._schema.json` → `databases/<col>-<slug>/_schema.json`. Path-traversal validation as we did for scripts.
  - [ ] Route `agents/openit-triage.template.json` → `agents/openit-triage-<slug>.json` with `<slug>` substituted.
- [ ] **Bootstrap scaffold (`src-tauri/src/project.rs`):**
  - [ ] On first run, after dirs are created, leave the schema/agent/KB writes to `syncSkillsToDisk` (don't double-write).
  - [ ] Write a starter `knowledge-base/welcome.md` (could come from the bundle too).
- [ ] **Manual verification:**
  - [ ] Kill network; reload OpenIT; plugin loads from bundle.
  - [ ] Fresh project: `_schema.json` files appear in `databases/openit-tickets-<slug>/` etc.
  - [ ] Schema match: deep-compare the bundled schema against what Pinkfish creates from `case-management` template. Must be identical.

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
  - [ ] **Filestore:** ensure `openit-docs-<slug>` collection exists; create if not. Push every local file.
  - [ ] **Datastore (people, tickets, custom):** for each `databases/<collection>/`, ensure the collection exists on Pinkfish (push schema if creating). Push every row.
  - [ ] **Agents:** for each local agent JSON without an `id`, POST `/service/useragents`. Record the server-issued `id` back into the JSON.
  - [ ] **Workflows:** for each local workflow JSON without an `id`, POST. Record back.
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

## Phase 7+ — Optional / deferred

These are punt-until-someone-complains. Track here so they don't get lost.

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

### Phase 7d — Workflow runner script

- [ ] `node .claude/scripts/run-workflow.mjs --workflow X --ticket Y` — walks workflow JSON inline, calls Claude as needed.
- [ ] Only if Claude-as-runtime turns out to be unreliable.

### Notes

—

---

## Working notes — things found mid-implementation

(Use this section as we go. Capture surprises that didn't fit the plan.)

—
