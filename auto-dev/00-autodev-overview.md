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

- **`/openit-app`** — this app (Tauri + React). Where this code lives.

The four siblings below are **reference-only** for OpenIT work — we read them to understand contracts, patterns, and endpoint shapes; we don't usually edit them from here. All four are checked out under `/Users/benrigby/Documents/GitHub/`. When you need to look something up, `Grep`/`Read` against the path directly. Each section says when to reach for it.

- **`/web`** — the main Pinkfish FE monorepo, AND the home of the Claude plugin OpenIT ships.
  - **FE patterns reference:** when a UX question comes up here ("how do existing tables sort? how do dialogs render?") this is the canonical reference. Components live under `web/packages/app/src/`.
  - **Plugin home (production source of truth):** the Claude plugin scripts, `CLAUDE.md`, and skills OpenIT ships to users live at `web/packages/app/public/openit-plugin/`. Dev source of truth is `openit-app/scripts/openit-plugin/` (this repo) — copy to `/web` at merge time. See "Plugin scripts and prompts" above.

- **`/platform`** — Pinkfish backend monorepo. Reference for **MCPs and service endpoints**.
  - When a scripts/REST/MCP wiring question comes up ("what's the actual route for this? what does this MCP tool expect?"), grep `/platform`.
  - Pinkfish-owned MCPs (`pinkfish-sidekick`, `agent-management`, `knowledge-base`, `filestorage`, `datastore-structured`, `http-utils`) and the gateway live here.

- **`/firebase-helpers`** — generated client + handlers for the **resource APIs** (datastores, knowledge-base, filestore, memory) hosted at `https://skills*.pinkfish.ai/`.
  - This is the canonical reference for every endpoint OpenIT calls when it talks to the resource layer. If the auto-generated client at `openit-app/src/api/generated/firebase-helpers/` looks wrong or out of date, this is where to verify.

- **`/pinkfish-connections`** — connections proxy hosted at `https://proxy*.pinkfish.ai/`. Reference for **connection endpoints** (the layer between Pinkfish and connected SaaS systems — Slack, Zendesk, Salesforce, Jira, Okta, GitHub, GCP, AWS, Azure, …).
  - Look here when a question is about connector-specific behavior, OAuth flows for third-party systems, or what the proxy returns for a given gateway call.

**Quick "which repo answers this?" cheatsheet:**

| Question | Repo |
|---|---|
| How does a similar UI render in the main app? | `/web` |
| What does the plugin's production version actually contain? | `/web` (`packages/app/public/openit-plugin/`) |
| Backend MCP / service endpoint shape? | `/platform` |
| `skills*.pinkfish.ai/...` endpoint contract (datastore/KB/filestore/memory)? | `/firebase-helpers` |
| `proxy*.pinkfish.ai/...` connection endpoint or third-party connector behavior? | `/pinkfish-connections` |

### Auth: one runtime token

OpenIT uses **exactly one credential** — the runtime token from OAuth client-credentials (`POST /oauth/token` against the user's `tokenUrl`). That single token is accepted by all three Pinkfish-side hosts:

| Host | Path prefix | Header | Examples |
|---|---|---|---|
| `app-api.<env>.pinkfish.<tld>` | `/service/*` | `Authorization: Bearer <token>` | `/service/useragents`, `/service/automations` |
| `skills*.pinkfish.ai` | `/datacollection`, `/memory`, `/knowledge-base`, `/filestore` | `Auth-Token: Bearer <token>` | resource APIs |
| `proxy*.pinkfish.ai` | `/manage/*` | `Auth-Token: Bearer <token>` | connections |

**No `X-Selected-Org` header.** Service routes pull org from the token's claims; skills/proxy don't need it.

**Different from `/web`.** The web frontend uses Cognito session tokens against `/api/*` routes — those routes do gate on `X-Selected-Org` and a different middleware. We don't use them. If you see `/api/agents` or `/api/automations` referenced anywhere in our code, that's wrong — replace with `/service/useragents` / `/service/automations`.

**Helper:** `makeSkillsFetch(accessToken, "bearer" | "auth-token")` in `src/api/fetchAdapter.ts` is the only authenticated-fetch path. Every adapter goes through it.

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

**One-time keychain setup (macOS):** to stop the keychain prompt from re-appearing on every rebuild, follow `src-tauri/scripts/README.md` to create a self-signed `OpenIT Dev` cert. The cargo runner (`src-tauri/.cargo/config.toml`) signs the dev binary with it on every build so the keychain ACL persists. Without this, `tauri dev` still works — you just get repeated prompts.

### Build
```bash
npm run tauri build
```
Produces an unsigned `.app` / `.dmg` in `src-tauri/target/release/bundle/`. Code signing tracked separately.

### Plugin scripts and prompts (cross-repo loop)

Plugin scripts (and the `CLAUDE.md` / skills Claude reads when running inside an OpenIT project) are **owned by the `/web` repo** but get developed against in this repo. The dev source of truth lives at:

```
openit-app/scripts/openit-plugin/
```

Production users get them via the plugin manifest at `/web/packages/app/public/openit-plugin/scripts/`. The two paths mirror each other on purpose so the eventual cp is mechanical.

**While developing on a feature branch:**
1. Edit `openit-app/scripts/openit-plugin/<script>.mjs` in this repo (commits travel with the PR).
2. Copy to your test org's project dir so you can actually run it:
   ```
   cp openit-app/scripts/openit-plugin/<script>.mjs ~/OpenIT/<orgId>/.claude/scripts/<script>.mjs
   ```
   Ben's working test org is `~/OpenIT/653713545258/.claude/scripts/`.
3. Test from inside that project: `cd ~/OpenIT/<orgId> && node .claude/scripts/<script>.mjs <args>`.
4. **Don't reconnect** OpenIT mid-dev — the manifest sync would overwrite your local copy with whatever's currently in `/web` (which is older). When you do reconnect after publishing, the manifest sync is what delivers the new version to all users.

**When merging the PR:**
1. Merge the openit-app PR.
2. Copy the script into the `/web` repo at `web/packages/app/public/openit-plugin/scripts/<script>.mjs` (mirrors path).
3. Bump `web/packages/app/public/openit-plugin/manifest.json` version.
4. Commit + push `/web`.
5. Verify: any reconnect now pulls the new script down to `~/OpenIT/<orgId>/.claude/scripts/`.

The same pattern applies to the plugin's `CLAUDE.md` and any skills under `web/.../openit-plugin/skills/` — develop in this repo's `scripts/openit-plugin/` (or a sibling `scripts/openit-plugin-prompts/` once we have prompts to track), copy to test org, copy to `/web` at merge time.

---

# Dev process

6 stages. Each produces a concrete artifact.

| Stage | File | Artifact |
| --- | --- | --- |
| 01 — Brief | `01-brief.md` | Linear ticket with Problem / Desired Outcome / Scope / Success Criteria |
| 02 — Impl plan | `02-impl.plan.md` | `auto-dev/plans/YYYY-MM-DD-PIN-####-short-name.md` with Files-to-modify table, unit-test list, manual scenarios, implementation checklist |
| 03 — Implementation | `03-implementation.md` | Code + unit tests on a feature branch; plan checklist marked off; `LEARNINGS & CHANGES` section appended where the implementation diverged from the plan |
| 04 — Testing | `04-testing.md` | Full vitest + cargo test pass + manual click-through scenarios; Linear comment summarizing what was tested |
| 05 — Impl review | `05-impl-review.md` | `auto-dev/plans/<plan-filename>-impl-review.md` with verdict + findings; fix sub-plans if any |
| 06 — PR + BugBot | `06-PR.md` | Open PR with Conventional-Commits title, run `@cursor review` loop until clean, merge. Cross-repo `/web` mirror at merge time if plugin scripts changed |

Skip the ceremony for trivial fixes (one-line bug, doc typo). Use it for anything that would benefit from being reviewed against an explicit plan.

**Stages do not advance silently.** Each stage's transition checklist ends with engineer approval. Do not roll into the next stage on your own.

**BugBot stop-condition:** keep iterating until the only remaining findings are Low-severity. At that point reply with rationale (or fix), resolve, merge.

## Optional add-ons (use when warranted)

- **Plan review** — currently implicit in stage 02 ("Stop, ask engineer to approve"). Promote to its own stage if plans tend to drift.
- **Documentation** — for changes that affect user-facing docs in `/web` or the README, add a doc-update step to the PR checklist. Does not need its own stage.
- **Retrospective** — for big features (e.g. V2 sync), worth running a structured retrospective after merge. Can be ad-hoc; doesn't need a numbered stage.
