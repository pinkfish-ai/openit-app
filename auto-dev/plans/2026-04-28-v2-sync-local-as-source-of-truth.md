# V2 Sync — Local-as-Source-of-Truth

**Date:** 2026-04-28
**Status:** Draft. Ticket TBD.
**Predecessor:** `2026-04-28-pin-5774-connect-to-cloud-auth.md` (V1 auth only — merged).
**Earlier reference:** `2026-04-25-bidirectional-sync-plan.md` (the engine work this builds on).

---

## What's broken today

V1 ships clean auth. The moment auth lands, `App.tsx` chains:

1. `projectBootstrap({ orgName, orgId })` → opens `~/OpenIT/<cloud-orgId>/` — a **different folder** from the local-only `~/OpenIT/local/` the user was working in.
2. `startCloudSyncs(creds, repo, orgName)` → fans out 5 engines (KB, filestore, datastore, agent, workflow). Each one calls its `tryResolveAndPull` first. **Cloud is the source-of-truth.** If the cloud org is fresh, the engines pull empty / stale state into the new folder.
3. `syncSkillsToDisk(repo, fullCreds)` → fetches the plugin manifest from the configured web host and overwrites the bundled plugin we already shipped with the app.

User-visible result of a fresh connect after working locally:

- The local-only project (`~/OpenIT/local/`) gets orphaned — none of the user's actual tickets, KB articles, agents, or workflows make it to the cloud.
- The new cloud-keyed folder is whatever the cloud says it is (often: empty or stale from earlier abandoned connect attempts).
- The plugin scripts get rewritten by whatever's on the configured `manifest.json` URL — even though the bundled scripts in the desktop app are newer.

That's three independent design defects collapsing onto the same connect button.

## V2 thesis

**Local is the source of truth. Cloud is a backup + a runtime + a fan-out point.**

Translation:

- The disk in `~/OpenIT/<projectId>/` is canonical. Its state was authored by the user (or by Claude on the user's behalf via the desktop app).
- Cloud has whatever local most recently pushed. On first connect, cloud gets bulk-loaded from local. On subsequent edits, local pushes; cloud receives.
- The bundled Claude plugin (skills, scripts, CLAUDE.md, schemas) is the only source for the plugin layer. The web `manifest.json` fetch path goes away entirely — the desktop app is the publisher.
- Other clients (a future second laptop, the cloud agent runtime) still pull from cloud — but those are downstream of the original local push, not co-equal source.

This is a deliberate inversion of the V0 / V1 design (which assumed cloud was canonical and local was a mirror). The local-first refactor already shifted disk to canonical; V2 finally makes the sync engine respect that.

## Concrete behavior changes

### A. Folder identity

**Today:** `~/OpenIT/local/` (local-only) and `~/OpenIT/<cloud-orgId>/` (cloud-connected) are two separate folders. Connecting from local strands the local-only folder.

**V2 first-time-connect promotion path:**

1. User has been working in `~/OpenIT/local/` (or `~/OpenIT/<localProjectId>/` — see naming below).
2. They connect to cloud org `886949498866`.
3. App detects: this is a first-time-connect for this local project + this cloud org.
4. App offers a confirmation: *"Promote your local project to cloud org 'Acme — sub'? Files stay where they are; we'll register this folder as the cloud-backed copy."* (default Yes; explicit cancel keeps it local-only.)
5. On confirm: the existing folder gets a `.openit/cloud.json` marker recording `{ orgId, orgName, promotedAt }`. **The folder doesn't move.** Future references resolve by `last_repo` in app state, not by orgId-keyed path.
6. The old `~/OpenIT/<cloud-orgId>/` naming convention goes away for this project. (Other projects keyed under `~/OpenIT/<x>/` still work for their original purpose.)

This sidesteps the whole "two folders for one user" mess. One folder, one project; the cloud binding is metadata.

**What about second-machine / second-team-member?** They `git clone` (or download via a future cloud-sync helper) into `~/OpenIT/<theirChoice>/` and connect. The `cloud.json` marker is what the app reads, not the folder name.

### B. Sync direction on first connect

**Today:** all 5 engines pull cloud → disk first.

**V2 first-connect order:**

1. **Push local → cloud** for every entity type. Cloud receives a full mirror of what's on disk.
2. **Reconcile manifest** — record `updatedAt` for each pushed item so subsequent polls don't no-op or re-push.
3. **Then bidirectional polling** kicks in (the existing engine, just with the right starting state).

What about cloud-side entities that don't exist locally?

- **Don't auto-delete them.** Safer: log them, surface a one-time prompt *"Cloud has 12 items not in your local project. Pull them down? Delete them? Leave them alone?"*
- For V2 MVP: just leave them alone. The cloud accumulates additive state. User can purge in the Pinkfish dashboard if it bugs them.
- That's a deliberate punt — a strict "cloud mirrors local exactly" mode is V2.5.

### C. Sync direction on subsequent connects (same machine)

**Today:** same as first-connect — pull then poll.

**V2:** the engines find the `.openit/cloud.json` marker, see this is a repeat connect, and **start in normal bidirectional poll** (not first-push, not first-pull). Conflict resolution from PR #17 handles divergence. Local edits since the last sync push first; cloud edits made elsewhere pull.

### D. Plugin sync — cut entirely

**Today:** `syncSkillsToDisk(repo, fullCreds)` fetches `${manifestUrl}/manifest.json` and writes every listed file under `repo/.claude/`. Used both at app start and on connect. Overwrites the bundled plugin.

**V2:** `syncSkillsToDisk(repo, null)` (the bundled-only path) is the only path. The cred-aware branch is deleted. The web manifest URL stays in code (commented as "future") but isn't called.

Why now: the desktop app is the publisher. We ship plugin updates by shipping new app builds. The web-fetch path was a holdover from when the plugin was edited live from `/web` on a release cadence faster than app releases. That's no longer how we work.

Revisit if/when we want to ship plugin patches between app releases without forcing an app upgrade. Until then, the web fetch is dead weight and a footgun (it overwrites bundled-fresh files with web-stale ones, exactly as the user hit).

### E. Sync engines — what changes per engine

| Engine | Today | V2 first-connect | V2 ongoing |
|---|---|---|---|
| `datastoreSync` | pull then poll | push all `databases/<col>/*.json` to cloud, reconcile manifest | bidirectional poll (existing) |
| `agentSync` | pull then poll | push all `agents/*.json` to cloud | bidirectional poll |
| `workflowSync` | pull then poll | push all `workflows/*.json` to cloud | bidirectional poll |
| `kbSync` | pull then poll | push all `knowledge-bases/<kb>/*.md` to cloud | bidirectional poll |
| `filestoreSync` | pull then poll | push all `filestores/<col>/*` to cloud | bidirectional poll |
| `skillsSync` | pull from web manifest | **skip entirely on connect**; bundled-only at app start | n/a (bundled-only) |

Each engine already has both `push*` and `pull*` exports (per the 2026-04-25 bidirectional plan). V2 is a small swap of which one runs first on connect.

## Implementation checklist

### Phase 0 — Diagnose + revert any obvious harm

- [ ] On main, audit every call site of `startCloudSyncs` and `syncSkillsToDisk` in `App.tsx`. Document the trigger paths (relaunch with creds, fresh connect, manual pull, etc.).
- [ ] Add a feature flag (`localStorage.openit.v2Sync`) so we can toggle the new direction during dev without ripping out the old code in one shot.

### Phase 1 — Cut the plugin web-fetch on connect

- [ ] In `App.tsx` `onPinkfishConnected`, delete the `syncSkillsToDisk(result.path, fullCreds)` call (or replace with `(result.path, null)` to keep the bundled-refresh behavior in place).
- [ ] In `App.tsx` startup paths (the relaunch-with-creds branch around line 388/411), do the same.
- [ ] Leave the web-fetch code in `skillsSync.ts` for now (commented as "future for OTA plugin patches"). One-line gate or a feature-flag check.
- [ ] Test: connect to cloud, confirm `.claude/scripts/*.mjs` aren't overwritten with web versions.

### Phase 2 — `cloud.json` marker + folder-promotion flow

- [ ] Add `.openit/cloud.json` write in `projectBootstrap` (or a new Tauri command `project_promote_to_cloud`) when binding a local project to a cloud org. Schema: `{ orgId, orgName, promotedAt, lastPushAt: null, lastPullAt: null }`.
- [ ] On `Connect to Cloud`, before starting syncs, check if the current `repo` already has `cloud.json`:
  - **No marker** → first-time connect. Show confirm: *"Promote this folder to cloud-backed?"* On yes, write marker + run Phase-3 first-push.
  - **Marker present, matches incoming orgId** → repeat connect. Skip first-push, go straight to bidirectional poll.
  - **Marker present, different orgId** → bail with an error: *"This folder is bound to another org. Disconnect first or open a different project."*
- [ ] Sidebar / header pill: surface the bound org name from `cloud.json` so the user can see at a glance which cloud their local is tied to.

### Phase 3 — Invert engine direction on first-connect

- [ ] Add `startCloudSyncs(creds, repo, orgName, { mode: 'first-push' | 'resume' })`. The `mode` decides whether each engine runs `pushAll*` first or `pull*` first.
- [ ] For each engine (`datastoreSync`, `agentSync`, `workflowSync`, `kbSync`, `filestoreSync`):
  - Add a `pushAllOnFirstConnect()` wrapper that calls the existing `push*` helper, then writes a per-collection "first-push complete" marker into `.openit/sync-state.json` so subsequent runs go bidirectional.
  - The polling loop is unchanged — it's already bidirectional in concept.
- [ ] Update `App.tsx` to pick the mode from `cloud.json`:
  - Marker missing or `lastPushAt: null` → `'first-push'`
  - Marker present with `lastPushAt` set → `'resume'`

### Phase 4 — UI feedback during first-push

- [ ] Replace the silent connect-then-sync chain with a visible "Pushing your project to cloud…" stage. Surface item counts per engine ("12 tickets, 3 agents, 4 workflows, 87 KB articles, 2 attachments") as they push.
- [ ] On completion: *"✓ Project mirrored to <org>. Future edits sync automatically."*
- [ ] On any per-engine failure: surface the specific entity type that failed; let the others continue. Don't fail the whole connect on one engine.

### Phase 5 — Cloud-only entities (the punt → real handling)

V2 MVP punts: leave cloud-only entities alone. Phase 5 is deferred — call it V2.1.

- [ ] After first-push, fetch each engine's cloud listing.
- [ ] Diff against what we just pushed. Any cloud-only entities → log them.
- [ ] Show a one-time modal: *"Cloud has 12 items not in your local project. Pull them down, delete them on cloud, or leave them alone?"*
- [ ] User choice writes into `cloud.json` (`cloudOnlyPolicy: 'pull' | 'delete' | 'ignore'`). Subsequent first-connects from another machine respect this default.

### Phase 6 — Tests + manual scenarios

- [ ] Per-engine unit test: `pushAllOnFirstConnect` writes the marker and counts items pushed.
- [ ] Integration: start with a non-empty local project, connect to a fresh cloud org, verify all entities land in cloud and `cloud.json` is written.
- [ ] Integration: re-connect (same `cloud.json`), verify polls run bidirectional, no first-push.
- [ ] Edge case: connect, disconnect (existing PR #59 path), reconnect to same org — should resume, not re-push.
- [ ] Edge case: connect, modify cloud-side via dashboard, verify next poll pulls the cloud edit.
- [ ] Edge case: simultaneous local + cloud edits → conflict resolver fires per the 2026-04-25 plan.

## Risks

1. **Push storms.** A user with thousands of KB articles or filestore uploads triggers a large bulk push on first connect. Need pagination + progress UI. The existing engines already have rate-limit handling — verify it kicks in here.
2. **Cloud has stale state from old V1 connects.** Anyone who already connected via V1 on a real project has empty / wrong cloud-side data. V2 first-push will overwrite from local — which is what we want — but per Phase 5, anything that *only* exists on cloud (e.g. the empty default datastores Pinkfish auto-created) needs the deferred handling.
3. **Marker drift.** If `cloud.json` gets deleted or corrupted, the engine falls back to "first-push" mode and re-pushes everything. Idempotent on cloud (same item IDs reused) but burns cycles. Add a `--dry-run` mode so a confused user can see what would push before it does.
4. **The plugin-fetch removal might surprise teams who rely on shipping prompt patches via `/web`.** Audit `/web/packages/app/public/openit-plugin/manifest.json` history — if it's been edited in the last 30 days, those edits aren't in any shipped app build. Reconcile before merging Phase 1.
5. **`projectBootstrap`'s assumption that `~/OpenIT/<orgId>/` is the path.** Phase 2's marker-based identity needs every consumer of `result.path` to keep working — and the `last_repo` mechanism already does the right thing here. But scan for any code that re-derives the path from `orgId` and fix.

## Out of scope (V2)

- Multi-machine / multi-user collaboration. (Real-time conflict surfaces, presence, etc.)
- Web ↔ cloud agent runtime (the agent that answers tickets when the laptop is closed).
- Switching cloud orgs without disconnecting first.
- Migrating the legacy `~/OpenIT/<orgId>/` folders that already exist on user disks. We accept that those become orphans.

## Sequencing

Each phase is independently shippable behind the V2-sync feature flag.

1. Phase 1 (cut plugin web-fetch) — ship first. Smallest blast radius. Fixes the immediate "my plugin scripts got overwritten" complaint.
2. Phase 2 (`cloud.json` marker + promotion flow) — ship second. No engine changes yet; just establishes the identity model.
3. Phase 3 (engine direction inversion) — ship third. Behind the feature flag. Internal dogfood.
4. Phase 4 (UI feedback) — ship fourth.
5. Phase 5 (cloud-only entity handling) — V2.1.
6. Phase 6 (testing + sign-off) — woven through each phase, not an end-of-plan add-on.

V2 done = Phases 1–4 + 6 shipped, feature flag flipped on for everyone.
