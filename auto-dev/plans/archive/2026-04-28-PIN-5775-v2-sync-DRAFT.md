# V2 Sync — Local-as-Source-of-Truth

**Date:** 2026-04-28
**Ticket:** [PIN-5775](https://linear.app/pinkfish/issue/PIN-5775/openit-connect-to-cloud-v2-local-as-source-of-truth-sync)
**Status:** Plan written. Ready for stage 03 (testing).
**Predecessor:** `2026-04-28-pin-5774-connect-to-cloud-auth.md` (V1 auth only — merged).
**Earlier reference:** `2026-04-25-bidirectional-sync-plan.md` (the engine work this builds on).

---

## Notes from in-flight PR #19 (open, conflicting, CI red — will be redone in V2)

Branch: `feat/skip-pre-pull-when-clean` · 13 commits · +1294 / −143 · last touched 2026-04-26.
Status: `DIRTY`/conflicting against main, frontend + rust CI failing, BugBot neutral. **Do not merge as-is** — fold the still-relevant threads into V2 phases below; drop the rest.

The PR is a grab-bag stacked off the conflict-resolve work. Mapping its threads to V2:

**Performance — pre-push pull skip when clean** *(keep — fold into Phase 3 / Phase 6)*
- New `src/lib/pendingChanges.ts` with `kbHasPendingChanges`, `filestoreHasPendingChanges`, `datastoreHasPendingChanges`. Pending = conflict marker set OR local mtime > `pulled_at_mtime_ms` OR untracked local file. Datastore also flags tracked-but-missing-file (deletion) and missing-collection-dir (wholesale delete). Filestore treats null mtime as pending; KB does not.
- Wired into `pushAllEntities` so each entity short-circuits to `▸ sync: <entity> skipped (no local changes)`. Tested case: 15-collection org, clean push 15-25s → 1-2s.
- Datastore index optimization: build `colName → Map<rowKey, entry>` once at top of helper (avoids O(collections × manifest)).
- 50 vitest cases pin the semantics. **V2 should preserve this perf optimization** — bidirectional engines under V2 will still benefit from skipping the pre-pull when local is clean for that entity.

**Conflict aggregation — `aggregateKey` per adapter** *(keep — semantic fix, independent of V2 direction change)*
- Adds optional `aggregateKey` to `EntityAdapter` (defaults to `prefix`). Filestore sets `aggregateKey: "filestore:<collection.id>"` so multi-collection filestore conflicts don't clobber each other in `conflictsByPrefix`.
- `clearConflictsForPrefix(prefix)` now also drops `<prefix>:<suffix>` slots.
- This bug exists today regardless of V2 — **port the fix into V2 work or land separately first.**

**Resolve-script fixes** *(keep — small, correctness)*
- Empty-string `conflict_remote_version` now routes through force-push (was falling to legacy delete-entry path because of truthy check).
- `sync-resolve-conflict.mjs` now best-effort `unlink`s the `.server.*` shadow file even if Claude skipped the `rm` step in the prompt.

**Plugin overlay touches** *(redo per V2 Phase 1 — current PR doesn't version-gate)*
- PR adds `syncSkillsToDisk` call on the relaunch branch in `App.tsx` (so bubble bar updates without full reconnect). Symptom-fix; V2 Phase 1 supersedes by making the overlay version-gated bundled-floor + remote-if-newer at startup / on-connect / every 6h. **Throw away the relaunch-only patch; do Phase 1 properly.**
- PR routes `scripts/<name>.mjs` manifest paths to `.claude/scripts/` on disk, with a basename allowlist (`^[a-zA-Z0-9._-]+\.mjs$`, rejects `..` / path separators / leading dots) — added in response to BugBot path-traversal finding. **Carry this validator into V2's overlay rewrite.**
- PR refactors plugin to put standing logic into skills (`resolve-sync-conflict`, `deploy`) rather than re-pasted in the conflict-banner prompt. CLAUDE.md grows a Scripts + Skills table. **Independent of V2; carry forward.**

**Banner / UI** *(mixed — review individually)*
- `ConflictBanner` gains `refreshTick` prop so a manual sync gesture clears the dismissed-key. Keep.
- Original commit added a post-push aggregate clear when `status==="ok"`. **BugBot rightfully flagged this** — pre-pull conflicts that pushAll skipped (status still "ok") got wiped. Final commit reverts the unconditional clear, keeps the refreshTick bump. V2 should land in the reverted state.
- New `SyncLog` component for kind=="sync": auto-scroll-on-new-line (only when near bottom), strip `▸ sync:` prefix, color from leading glyph. UX polish — keep.
- Bubble bar: `overflow-x: auto` + `flex: 0 0 auto` + `nowrap` so all bubbles reachable on narrow panes. Keep.
- Claude terminal `filter: saturate(0.72)` so xterm.js ANSI doesn't clash with OpenIT theme. Cosmetic — keep.

**Welcome / git hygiene** *(keep — independent)*
- `_welcome.md` rewritten ("pitch the value, not the inventory") + added to gitignore + untrack-on-existing-repos in `git_ops.rs`. Independent of V2 thesis; carry forward.

**What's NOT in PR #19 that V2 needs:** the actual V2 thesis — local-as-source-of-truth direction inversion, `cloud.json` bind marker, removal of `~/OpenIT/<orgId>/` folder convention, `openit-<name>` container prefix + auto-create + `cloud.ensureContainer`, plan-limit pre-flight, version-gated plugin overlay with bundled-floor. PR #19 is purely incremental on the V1 model; V2 changes the model.

**Recommendation:** close PR #19 without merging once V2 work begins. Cherry-pick the perf helpers (`pendingChanges.ts`), the `aggregateKey` fix, the resolve-script correctness fixes, the path-traversal validator, the welcome/gitignore changes, and the UI polish into the V2 phase commits where they fit.

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
- The bundled Claude plugin (skills, scripts, CLAUDE.md, schemas) is the floor. A version-gated remote overlay can ship updates between app builds without overwriting newer bundled files.
- Other clients (a future second laptop, the cloud agent runtime) still pull from cloud — but those are downstream of the original local push, not co-equal source.

This is a deliberate inversion of the V0 / V1 design (which assumed cloud was canonical and local was a mirror). The local-first refactor already shifted disk to canonical; V2 finally makes the sync engine respect that.

## Concrete behavior changes

### A. Folder identity

**Today:** `~/OpenIT/local/` (local-only) and `~/OpenIT/<cloud-orgId>/` (cloud-connected) are two separate folders. Connecting from local strands the local-only folder.

**V2 — symmetric, no prime/non-prime:**

Every user, every machine, starts the same way: a local folder (`~/OpenIT/local/` by default, but the name doesn't matter). Connecting to a cloud org is just **binding**: the app writes `.openit/cloud.json = { orgId, orgName, connectedAt, lastSyncAt }` into that folder and starts bidirectional sync. The folder stays where it is. There is no "promotion ceremony" and no first-vs-Nth-user distinction.

Two people connecting to the same `orgId` converge through cloud. User A pushes their local items up; user B pushes theirs up; both pull whatever the other has. Same code path on first connect as on the hundredth. Conflict resolution (PR #17 / 2026-04-25 plan) handles overlapping edits.

Before binding for the first time, show one confirm: *"Bind this folder to org 'Acme — sub'? Items in this folder will sync to cloud, and items already in the cloud org will sync down."* This is the only safety gate — it prevents accidentally uploading a personal scratch folder to a company org. Default Yes, explicit cancel leaves the folder local-only.

**Folder naming.** The old `~/OpenIT/<cloud-orgId>/` convention goes away. The app reads `cloud.json` to know which org a folder is bound to; the folder name is user-chosen. (One folder can only be bound to one org at a time. Switching orgs = unbind + rebind, out of scope for V2.)

### B. Sync direction — always bidirectional

**Today:** all 5 engines pull cloud → disk first.

**V2:** every connect runs the engines in normal bidirectional mode from the start. The "initial sync" after a fresh bind is just a normal sync with a bigger diff — local-only items push up, cloud-only items pull down, conflicting items resolve via PR #17 logic. There is no separate "first-push" mode.

What about cloud-only entities on first bind?

- They pull down. That's the symmetric answer: a second user connecting to an existing org expects to receive what the first user already pushed.
- A user who specifically wants to *not* inherit cloud state should bind a fresh empty folder, not their existing local one. The first-bind confirm should make this clear.
- A strict "cloud mirrors local exactly" mode (where cloud-only items get deleted on bind) is out of scope.

### C. Cloud container naming + auto-create

A user's Pinkfish account doesn't have OpenIT's collections by default. First sync needs to **create them** on cloud, not assume they exist.

**Naming convention.** Every container OpenIT manages on cloud is prefixed `openit-<name>`:

- Datastore collections: `openit-tickets`, `openit-customers`, etc.
- KBs: `openit-faq`, `openit-runbooks`, etc.
- Filestores: `openit-attachments`, `openit-docs`, etc.

The prefix scopes OpenIT-managed state away from anything else the user has on their Pinkfish account, makes it obvious in the dashboard which containers come from this app, and gives us a clean grep target for cleanup. The frontend strips `openit-` when displaying — users see "tickets," not "openit-tickets."

On first sync per container:

- Engine builds the cloud container name from the local folder name (`databases/tickets/` → `openit-tickets`).
- Calls a `cloud.ensureContainer(name, type)` helper. Idempotent: creates if missing, no-ops if present.
- Then pushes items.

**Plan limits.** Each Pinkfish account has caps on counts of containers, items per container, and total storage (read from sub info). Before bulk-pushing on first bind:

- Pre-flight: count local items per type, compare against sub limits.
- If over: block the bind with a clear modal — *"You have 320 KB articles; your plan allows 100. Upgrade or trim before binding."* Explicit and annoying beats silent partial-push.
- If under: proceed. Surface remaining headroom in the sync UI ("87 / 1000 KB articles synced") so the user sees runway.
- Incremental edits past the limit during ongoing sync: soft-warn, surface a banner, let the API's 4xx be the final stop.

### D. Plugin sync — harden, don't cut

**Today:** `syncSkillsToDisk(repo, fullCreds)` fetches `${manifestUrl}/manifest.json` and overwrites every listed file under `repo/.claude/` — including bundled files that were *newer* than the remote ones. That's the bug.

**V2: version-gated overlay.** Keep the remote fetch. Make it safe.

- Each plugin file (or the manifest as a whole) carries a `revision: int`. Both the bundled manifest and the remote manifest carry one.
- On startup, on connect, and on a 6-hour interval, fetch the remote manifest. For each file, write the higher-revision version to disk. If bundled is newer (because we shipped an app update faster than `/web` caught up), bundled wins. If remote is newer, remote wins.
- Cache the resolved file set on disk so offline users keep working.
- On fetch failure (network, 4xx, schema mismatch): fall back silently to the bundled set. Log + telemetry, don't break the app.

This preserves OTA plugin updates (the velocity reason to keep `/web` as the publisher) without the stale-overwrite footgun. The Tauri auto-updater still ships the app + bundled-floor, on its own (slower) cadence. Two channels, both version-aware.

### E. Sync engines — what changes per engine

| Engine | Today | V2 |
|---|---|---|
| `datastoreSync` | pull then poll | bidirectional from connect; auto-creates `openit-<name>` collections |
| `agentSync` | pull then poll | **out of scope for V2** — left running as-is, revisit post-V2 |
| `workflowSync` | pull then poll | bidirectional from connect; auto-creates `openit-<name>` workflows |
| `kbSync` | pull then poll | bidirectional from connect; auto-creates `openit-<name>` KBs |
| `filestoreSync` | pull then poll | bidirectional from connect; auto-creates `openit-<name>` filestores |
| `skillsSync` | pull from web manifest (overwrites bundled) | version-gated overlay: bundled floor + remote-if-newer; checked at startup, on connect, every 6h |

Each engine already has both `push*` and `pull*` exports (per the 2026-04-25 bidirectional plan). V2 mostly ensures the bidirectional reconciler runs from the moment the bind marker is written, instead of being preceded by a one-shot pull-from-cloud.

## Implementation checklist

### Phase 0 — Diagnose + revert any obvious harm

- [ ] On main, audit every call site of `startCloudSyncs` and `syncSkillsToDisk` in `App.tsx`. Document the trigger paths (relaunch with creds, fresh connect, manual pull, etc.).
- [ ] Add a feature flag (`localStorage.openit.v2Sync`) so we can toggle the new direction during dev without ripping out the old code in one shot.

### Phase 1 — Version-gate the plugin overlay (don't cut it)

- [ ] Add a `revision` field to the bundled plugin manifest and to every web `manifest.json`. Bump the bundled `revision` when shipping app builds with plugin changes; bump the web `revision` when publishing OTA patches.
- [ ] Rewrite `syncSkillsToDisk(repo, creds)` to merge bundled + remote per-file, taking the higher `revision`. On fetch failure or schema mismatch, fall back to bundled silently (log + telemetry).
- [ ] Add a 6-hour interval check (in addition to startup + on-connect) so long-lived sessions pick up plugin patches without a relaunch.
- [ ] Audit `/web/packages/app/public/openit-plugin/manifest.json` history. Any file whose web version is *older* than the version about to ship in the app needs a revision bump on the web side before this lands, otherwise app-build users will keep their (correct) bundled file and dashboard editors will be confused why their `/web` edit didn't propagate.
- [ ] Test: connect to cloud, confirm bundled-newer files survive; web-newer files apply.
- [ ] Test: kill network, restart app, confirm bundled set loads and the app works fully offline.

### Phase 2 — `cloud.json` marker + bind flow

- [ ] Add a Tauri command `project_bind_to_cloud(repo, orgId, orgName)` that writes `.openit/cloud.json` with schema `{ orgId, orgName, connectedAt, lastSyncAt: null }`. Idempotent — safe to call repeatedly with the same orgId.
- [ ] Update `projectBootstrap` (or its caller) to stop deriving the path from orgId. The bound folder is whatever the user has open; `cloud.json` is the binding record.
- [ ] On `Connect to Cloud`, before starting syncs, check if the current `repo` already has `cloud.json`:
  - **No marker** → first-time bind. Show confirm: *"Bind this folder to org '<orgName>'? Local items will sync up; cloud items will sync down."* On yes, call `project_bind_to_cloud` and start bidirectional sync.
  - **Marker present, matches incoming orgId** → already bound. Start bidirectional sync immediately, no confirm.
  - **Marker present, different orgId** → bail with an error: *"This folder is bound to another org ('<existingOrgName>'). Disconnect first or open a different folder."*
- [ ] Sidebar / header pill: surface the bound org name from `cloud.json` so the user can see at a glance which cloud their local is tied to.

### Phase 3 — Always-bidirectional engines + auto-create + limit pre-flight

- [ ] `startCloudSyncs(creds, repo, orgName)` runs every engine in bidirectional mode from the moment it's called. No `mode` parameter, no separate first-push code path.
- [ ] **Pre-flight: plan limits.** Before kicking off engines on a fresh bind, fetch sub info, count local items per type, compare against caps. If over: block with a modal listing each over-cap type and the cap; user must trim or upgrade. If under: continue, surface remaining headroom in the sync UI.
- [ ] **Auto-create containers.** Each engine, before pushing, calls `cloud.ensureContainer(name, type)` for every local container in its scope. Container name = `openit-<localFolderName>`. Idempotent. Run in parallel where possible to keep first-bind latency down.
- [ ] **Frontend prefix-stripping.** Wherever container names are rendered (sidebar, dashboard pill, sync status), strip the `openit-` prefix at the display layer. Internal references (API calls, sync state) keep the full prefixed name.
- [ ] For each engine in scope (`datastoreSync`, `workflowSync`, `kbSync`, `filestoreSync` — **not** `agentSync`):
  - Verify the existing bidirectional reconciler correctly handles the "first sync" case where local has many items cloud doesn't (and vice versa). Any local item with no cloud counterpart pushes up; any cloud item with no local counterpart pulls down; collisions resolve per PR #17.
  - If the current implementation requires a separate "initial pull" before bidirectional polling can run, restructure it so the first poll iteration does the right thing on its own.
- [ ] `agentSync` is out of scope for V2. Leave it running as-is (or skip it in `startCloudSyncs` if its current behavior would interfere with V2 semantics — decide during Phase 0 audit).
- [ ] Update `cloud.json.lastSyncAt` after each engine's reconciler completes a pass. (Used by UI to show "last synced X ago"; not used to switch modes — there are no modes.)

### Phase 4 — UI feedback during initial sync

- [ ] Replace the silent connect-then-sync chain with a visible "Syncing with cloud…" stage. Surface item counts per engine in both directions (e.g. "↑ 12 tickets, 3 agents, 4 workflows, 87 KB articles, 2 attachments / ↓ 5 tickets pulled from cloud") as the reconciler runs.
- [ ] On completion: *"✓ Synced with <org>. Future edits sync automatically."*
- [ ] On any per-engine failure: surface the specific entity type that failed; let the others continue. Don't fail the whole connect on one engine.
- [ ] Initial-sync diff size can be large in either direction — chunk + show progress, not a single blocking modal.

### Phase 5 — Stricter cloud-only policies (deferred — V2.1)

V2 MVP: cloud-only items pull down by default. That's the symmetric answer and matches what a second user joining an existing org expects.

Defer the following to V2.1:

- [ ] Optional per-folder `cloudOnlyPolicy: 'pull' | 'ignore'` in `cloud.json` for users who want to bind a folder but selectively ignore some cloud state.
- [ ] "Strict mirror" mode where binding a folder *deletes* cloud-only items (so cloud exactly matches local). Power-user / migration scenario only.

These are out of scope for V2 because the default behavior already does the right thing for the common case.

### Phase 6 — Tests + manual scenarios

- [ ] Integration: start with a non-empty local project, connect to a fresh cloud org, verify all local entities land in cloud and `cloud.json` is written.
- [ ] Integration: start with an empty local project, connect to a cloud org that already has entities (simulating second user / second machine), verify all cloud entities land locally.
- [ ] Integration: start with a non-empty local project, connect to a cloud org that also has non-overlapping entities, verify both directions reconcile (union).
- [ ] Integration: re-connect (same `cloud.json`), verify behavior is identical to first connect (just with a smaller diff).
- [ ] Edge case: connect, disconnect (existing PR #59 path), reconnect to same org — should resume cleanly.
- [ ] Edge case: connect, modify cloud-side via dashboard, verify next poll pulls the cloud edit.
- [ ] Edge case: simultaneous local + cloud edits to the same item → conflict resolver fires per the 2026-04-25 plan.
- [ ] Edge case: bind to org A, then attempt to connect to org B from the same folder — verify the "bound to another org" guard fires.

## Risks

1. **Initial-sync size.** First sync after a fresh bind can move a lot of data in either direction (large local push from an established user, or large cloud pull for someone joining an active org). Need pagination + progress UI. The existing engines already have rate-limit handling — verify it kicks in here.
2. **Cloud has stale state from old V1 connects.** Anyone who already connected via V1 on a real project has empty / wrong cloud-side data. V2's bidirectional reconciler will *pull that stale state down* on bind — the opposite of what we want for that user. Mitigation: a one-time "purge old V1 cloud state" script run before flipping the V2 flag on, or a per-user "fresh bind" override that ignores cloud.
3. **Accidental cross-pollination.** A user binds their personal scratch folder to a company org, and now their experiments are cloud-side. Mitigation: the first-bind confirm dialog (Phase 2) explicitly states "items in this folder will sync up." That's the safety gate.
4. **Marker loss.** If `cloud.json` gets deleted, the next connect treats the folder as a fresh first-bind and re-runs the confirm. Items already on cloud will pull down; items still local will push up. Idempotent in the common case, but a confused user could end up double-binding a folder. Mitigation: keep a backup of the marker in app state (`last_repo` already tracks the current bound folder).
5. **Plugin revision drift.** With version-gated overlay, both bundled and web manifests carry `revision`. If the web revision is bumped but the file content regresses (e.g. revert without a revision bump), users get the regression. Mitigation: revision bumps must be monotonic — enforce in CI on both publish paths.
6. **Container name collisions.** A user already has a non-OpenIT collection on their Pinkfish account literally named `openit-tickets`. Auto-create either no-ops (taking it over) or 4xx's. Mitigation: `cloud.ensureContainer` should detect "exists but not owned by OpenIT" (e.g. by a marker on the container) and bail with a clear error rather than silently take over. Edge case, low odds, but worth a guard.
7. **Plan-limit modal as a hard block.** A user mid-onboarding hits the limit modal on bind and has no easy path forward (they don't want to delete content). Mitigation: deep-link the upgrade flow from the modal; offer "bind anyway and skip overflow" as an explicit (warned) escape hatch only if we hear demand.
8. **`projectBootstrap`'s assumption that `~/OpenIT/<orgId>/` is the path.** Phase 2's marker-based identity needs every consumer of `result.path` to keep working — and the `last_repo` mechanism already does the right thing here. But scan for any code that re-derives the path from `orgId` and fix.

## Out of scope (V2)

- **`agentSync`** — full bidirectional sync of agents is deferred. Existing behavior preserved as-is.
- Multi-machine / multi-user collaboration. (Real-time conflict surfaces, presence, etc.)
- Web ↔ cloud agent runtime (the agent that answers tickets when the laptop is closed).
- Switching cloud orgs without disconnecting first.
- Migrating the legacy `~/OpenIT/<orgId>/` folders that already exist on user disks. We accept that those become orphans.
- Stricter cloud-only policies (`pull` / `ignore` / strict-mirror). Default is "pull cloud-only items down."

## Sequencing

Each phase is independently shippable behind the V2-sync feature flag.

1. Phase 1 (version-gated plugin overlay) — ship first. Smallest blast radius, fixes the immediate "my plugin scripts got overwritten" bug, preserves OTA cadence.
2. Phase 2 (`cloud.json` marker + bind flow) — ship second. No engine changes yet; just establishes the identity model.
3. Phase 3 (bidirectional engines + auto-create + plan-limit pre-flight) — ship third. Behind the feature flag. Internal dogfood.
4. Phase 4 (UI feedback) — ship fourth.
5. Phase 5 (stricter cloud-only policies) — V2.1.
6. Phase 6 (testing + sign-off) — woven through each phase, not an end-of-plan add-on.

V2 done = Phases 1–4 + 6 shipped, feature flag flipped on for everyone.
