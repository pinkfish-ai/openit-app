# PIN-5775: Phase 1 — Filestore local-first sync — Implementation plan

**Ticket:** [PIN-5775](https://linear.app/pinkfish/issue/PIN-5775/openit-connect-to-cloud-v2-local-as-source-of-truth-sync)
**Date:** 2026-04-29
**Repo:** `openit-app` (primary)
**References:** `/firebase-helpers` (skills*.pinkfish.ai filestore endpoints — read-only reference)
**Predecessor:** PIN-5774 — V1 auth (merged)
**Brief:** Linear ticket body. Brainstorm context: `auto-dev/plans/archive/2026-04-28-PIN-5775-v2-sync-DRAFT.md`.

---

## 1. Technical investigation

### 1a. Connect chain in `App.tsx`

Three call paths trigger sync:

- **Cloud relaunch** (`App.tsx:372–390`) — creds + `last_repo` already set. Calls `projectBootstrap({ orgName, orgId })` → `startCloudSyncs(creds, repo, orgName)`.
- **Cloud first-run** (`App.tsx:393–422`) — creds present but no `last_repo`. Same chain, plus `syncSkillsToDisk(repo, fullCreds)`.
- **Local-only relaunch / first-run** (`App.tsx:437–489`) — no creds. Calls `projectBootstrap({ orgName: "local", orgId: "local" })` → folder is `~/OpenIT/local/` → optional `syncSkillsToDisk` if plugin-version sentinel missing.
- **Modal-driven fresh connect** (`App.tsx:548–582`, in `onPinkfishConnected`) — after OAuth completes from the connect modal. Calls `projectBootstrap({ orgName, orgId })` → `startCloudSyncs` → `syncSkillsToDisk`.

`projectBootstrap` (defined `src-tauri/src/project.rs:52–175`) **derives the folder path from orgId**: `~/OpenIT/<orgId>/`. For `orgId == "local"`, it's `~/OpenIT/local/`. For a real cloud orgId, it's `~/OpenIT/<orgId>/`. This is the bug — connecting to cloud opens a different folder than the local-only one.

`startCloudSyncs` (`App.tsx:108–125`) fans out 5 engines (KB, filestore, datastore, agent, workflow) in parallel. Each engine independently calls `tryResolveAndPull` and starts a 60s poll.

`last_repo` is the persistent "current folder" reference, stored in Tauri `state.json` (`src-tauri/src/state.rs:6–39`).

### 1b. Filestore engine today

`src/lib/filestoreSync.ts` is the entry point. Key functions:

- **`resolveProjectFilestores(creds)` (`filestoreSync.ts:115–264`):** caches per-org. Lists remote via `GET /datacollection/?type=filestorage`. Hardcoded default collection name `openit-docs-<orgId>`. Auto-creates the default if missing via `POST /datacollection/`.
- **`runPull(adapter, repo, …)` (`filestoreSync.ts:305–331`):** wraps `pullEntity` from the shared engine.
- **`pushAllToFilestore(repo, creds)` (`filestoreSync.ts:465–561`):** push path. Filters by `mtime > pulled_at_mtime_ms`, uploads, updates manifest. **Manual-only today** — wired to the Sync tab's commit handler, not the polling loop.
- **`startPolling(adapter, repo, …)` (`filestoreSync.ts:393–419`):** 60s poll, pull-only.

**Local layout:** `filestores/library/` (the synced folder). `filestores/attachments/<ticketId>/` exists but is server-managed and not adapter-synced.

**Manifest:** `.openit/fs-state.json` with `{ collection_id, collection_name, files: { [path]: { pulled_at_mtime_ms, remote_version, conflict_remote_version } } }`.

**Existing API surface (skills*.pinkfish.ai/datacollection):**
- `GET /datacollection/?type=filestorage` — list remote (returns `DataCollection[]`)
- `POST /datacollection/` — create with `{ name, type: "filestorage", description, createdBy, createdByName }`
- File-level CRUD via `fsStoreUploadFile` etc., already wired.

Auth header: `Auth-Token: Bearer <accessToken>` via `makeSkillsFetch(token.accessToken)`.

### 1c. Conflict reconciler

`src/lib/syncEngine.ts:478–750` — `pullEntity` is the bidirectional reconciler. Detects conflicts (`localChanged && remoteChanged`), writes `.server.<ext>` shadow files, emits via `subscribeConflicts`. Filestore adapter uses `aggregateKey: "filestore:<collection.id>"` (added in PR #19 commit) so multi-collection conflicts don't clobber each other.

### 1d. Folder identity today

No metadata file beyond the per-entity manifests. The bound folder is identified solely by its path and `last_repo`. No `cloud.json` or equivalent exists.

### 1e. Tests

`src/lib/syncEngine.test.ts` — engine-level pulls/conflicts (188 lines, runs under vitest).
`src/lib/skillsSync.test.ts` — plugin sync routing.
No filestore-specific test file today.

---

## 2. Proposed solution

### Approach

Two coupled changes, both narrow:

1. **Folder identity.** Stop creating `~/OpenIT/<orgId>/` on cloud connect. The user's existing folder (default `~/OpenIT/local/`) stays bound. A new metadata file `.openit/cloud.json` records `{ orgId, orgName, connectedAt, lastSyncAt }`. Subsequent launches read this file to know which org the folder is bound to.

2. **Filestore engine local-first.** Filter remote `listFilestoreCollections` results to `openit-*` only. Replace hardcoded `openit-docs-<orgId>` default with `openit-library` (matching the local folder name). On first sync per binding, the existing engine's bidirectional reconcile naturally pushes local-only items up and pulls remote-only down. Existing PR #17 conflict logic untouched.

We deliberately keep this Phase narrow:
- Multi-collection filestore (custom user-named subfolders) → Phase 2.
- Plugin overlay revision-gating → its own phase.
- Other engines (datastore, KB, workflow, skillsSync) sync-direction inversion → later phases.

### Files to modify

| File | Change |
| --- | --- |
| `src-tauri/src/project.rs` | Add `project_bind_to_cloud(repo, orgId, orgName)` — writes `.openit/cloud.json`. Add `project_get_cloud_binding(repo)` → reads it. Add `project_update_last_sync_at(repo)` — updates `lastSyncAt` field. `CloudBinding` struct serializable to/from JSON. `cloud.json` is added to gitignore + the untrack-on-existing-repos list. |
| `src-tauri/src/lib.rs` | Register the three new Tauri commands. |
| `src-tauri/src/git_ops.rs` | Add `cloud.json` to GITIGNORE constant; add to PATHS / PATHSPECS in untrack list. |
| `src/lib/api.ts` | Frontend wrappers `projectBindToCloud`, `projectGetCloudBinding`, `projectUpdateLastSyncAt`. Type for `CloudBinding`. |
| `src/App.tsx` | After OAuth success (modal-driven path AND first-run-with-creds path AND relaunch path): if no `last_repo`, default to `~/OpenIT/local/`. Skip the orgId-named bootstrap. Call `projectBindToCloud(repo, orgId, orgName)` to write the marker. Then `startCloudSyncs(creds, repo, orgName)`. |
| `src/lib/filestoreSync.ts` | In `resolveProjectFilestores`: filter remote list to names starting with `openit-`. Replace hardcoded `openit-docs-<orgId>` default with `openit-library`. Update `lastSyncAt` after each successful pull. |
| `src/lib/filestoreSync.test.ts` (new) | Cover the resolver: `openit-` filter; auto-create when missing; reuse existing remote when matching by `openit-library` name. |
| `src-tauri/tests/cloud_binding.rs` (new, or in-line `#[cfg(test)]`) | Cover `project_bind_to_cloud` write/read round-trip; `project_update_last_sync_at` updates only that field. |

### Unit tests

**`src-tauri/src/project.rs` (Rust):**
- `bind_writes_cloud_json` — calling `project_bind_to_cloud` writes `.openit/cloud.json` with the right shape; `lastSyncAt` is `null` initially.
- `bind_is_idempotent` — calling twice with the same orgId leaves the file consistent.
- `bind_rejects_different_org` — calling with a different orgId on an already-bound folder returns an error (caller surfaces as "bound to another org").
- `get_binding_returns_none_when_unbound` — returns `None` for a folder without `cloud.json`.
- `get_binding_returns_some_when_bound` — round-trips the binding.
- `update_last_sync_at_preserves_other_fields` — only `lastSyncAt` changes.

**`src/lib/filestoreSync.test.ts` (new file, vitest):**
- `resolveProjectFilestores filters non-openit collections` — given a remote list mixing `openit-library` and unrelated `customer-data`, only `openit-library` survives.
- `resolveProjectFilestores reuses existing openit-library` — when remote already has it, returns its ID without creating.
- `resolveProjectFilestores creates openit-library when missing` — when remote has no `openit-*`, calls `POST /datacollection/` with name `openit-library`.
- `resolveProjectFilestores handles 409 on create` — server's eventual-consistency 409 is retried; final return is the resolved collection.

**`src/App.tsx` integration scenarios** — covered by manual scenarios; tsc-only check for the new wiring.

### Manual scenarios (to be exercised in `npm run tauri dev` after merge — see PR description)

- **MS-1.** Fresh install → opens `~/OpenIT/local/`. Confirm bootstrap creates the standard subdirs.
- **MS-2.** Click connect, complete OAuth. Confirm: same folder (`~/OpenIT/local/`) stays bound; `.openit/cloud.json` is written; sync UI shows the bound org name; filestore engine doesn't try to switch folders.
- **MS-3.** Pre-existing `openit-library` on remote with files. Connect → those files pull down to `filestores/library/`.
- **MS-4.** No `openit-*` on remote. Connect with files in `filestores/library/` → `openit-library` is created; files push up.
- **MS-5.** Mixed: remote has `openit-library` AND user has unrelated non-OpenIT collections (`customer-feedback`, etc.) → unrelated collections are NOT touched; `openit-library` reconciles.
- **MS-6.** Reconnect (same orgId, `cloud.json` present) → no folder switch, sync starts immediately.
- **MS-7.** App relaunch with `cloud.json` present → reads binding, restarts sync against the bound folder.

### Cross-repo plugin steps

None for Phase 1. No `scripts/openit-plugin/` files change.

---

## 3. Implementation checklist

### Step 1 — Tauri bind-marker primitives

Establish the new file format and Tauri command surface so frontend can call into it.

- [ ] Add `CloudBinding` struct + `cloud.json` IO in `src-tauri/src/project.rs`
- [ ] Register `project_bind_to_cloud`, `project_get_cloud_binding`, `project_update_last_sync_at` in `src-tauri/src/lib.rs`
- [ ] Add `cloud.json` (or `.openit/cloud.json`) to gitignore + untrack list in `git_ops.rs`
- [ ] Rust unit tests (round-trip, idempotency, different-org guard, no-binding case)
- [ ] `cargo build` clean

### Step 2 — Frontend bind-marker wrappers

- [ ] Add wrappers + type in `src/lib/api.ts`
- [ ] vitest type-check

### Step 3 — Filestore engine — `openit-` prefix filter + rename default

The narrow engine change. Existing bidirectional reconciler stays.

- [ ] Update `resolveProjectFilestores` in `src/lib/filestoreSync.ts`:
  - Filter remote results to names starting with `openit-`
  - Default collection name `openit-library` (replaces `openit-docs-<orgId>`)
- [ ] Add `src/lib/filestoreSync.test.ts` with the four resolver cases
- [ ] `npx vitest run` clean

### Step 4 — Wire bind-marker into connect chain

The user-visible behavior change. Touches `App.tsx` only.

- [ ] In `onPinkfishConnected` (modal-driven connect): replace the orgId-derived bootstrap with: ensure `~/OpenIT/local/` exists, call `projectBindToCloud(repo, orgId, orgName)`, then `startCloudSyncs(creds, repo, orgName)`.
- [ ] In the first-run-with-creds path (App.tsx:393–422): same shape — bind the existing or default folder, then start syncs.
- [ ] In the cloud-relaunch path (App.tsx:372–390): read `cloud.json` from `last_repo`. If present, start syncs. If absent, treat as a stale state and fall through to local-only.
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` clean

### Step 5 — Cleanup + lint

- [ ] `npx tsc --noEmit`
- [ ] `cd src-tauri && cargo build && cargo test`
- [ ] `npx vitest run`
- [ ] Diff size sanity check
- [ ] No debug `console.log` / `dbg!` left in diff

### Step 6 — PR + BugBot

- [ ] Open PR (draft) with Conventional-Commits title
- [ ] Trigger BugBot (`@cursor review`)
- [ ] Iterate to clean

---

## Risks

1. **Existing users with `openit-docs-<orgId>` collections.** V1 may have created collections under the old name. After Phase 1 ships, those become orphaned because the new resolver looks for `openit-library`. Mitigation: V1 deployment surface is small (test orgs only). Note in PR description; users with stranded data can manually rename in the dashboard or wait for Phase 2's broader migration.

2. **Connect chain has 4 entry points.** Missing one means inconsistent binding behavior. Step 4's checklist explicitly enumerates all three cloud paths (cloud-relaunch, first-run-with-creds, modal connect) — local-only path is unchanged.

3. **`cloud.json` lives under `.openit/`.** Ensures gitignore rules already cover it (since `.openit/` is gitignored). Verify in implementation; don't store at repo root where it'd be tracked.

4. **No manual-test coverage in autonomous run.** This implementation is being done while the engineer is unavailable. Unit tests + type-check + cargo build are the only hard gates that pass before PR. Manual scenarios MS-1 through MS-7 must be exercised before merge.

---

## Out of scope (explicit reminders)

- Plugin overlay version-gating (own phase)
- Other engines (datastore, KB, workflow, skillsSync) — sync-direction inversion deferred
- Plan-limit pre-flight (SC-6)
- First-bind confirm dialog
- Migrating existing `~/OpenIT/<orgId>/` folders that may already exist on disk
- Multi-collection custom-named filestore support (only `library` in Phase 1)
- `openit-docs-<orgId>` → `openit-library` data migration on cloud

---

## BugBot Review Log

### Iteration 1 (2026-04-29)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | Fall-through from cloud-relaunch never reaches rebind branch (V1 fall-through never reaches first-run-with-creds branch) | High | Fixed | `089664e` — added `cloudRelaunchFellThrough` flag set inside the cloud-relaunch branch when the marker is missing or mismatched; first-run-with-creds condition extended to include the flag so V1 fall-through users re-bind to `~/OpenIT/local/` instead of falling into a half-loaded state. BugBot raised this twice across the two SHAs (aaa52b9 and 9bfde6b) — same root-cause finding. |

### Iteration 2 (2026-04-29)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | orgId persisted as orgName in cloud.json binding | Medium | Fixed | `632acad` — App.tsx first-run-with-creds path now passes `orgName: ""` instead of `creds.orgId`. Cloud-relaunch falls back to `creds.orgId` for the display arg when `binding.orgName` is empty. Rust same-org rebind path now refuses to clobber a non-empty existing orgName with an empty one (so a future modal-connect with a real display name persists). Two new cargo tests pin the semantics. Also verified the `openit-` filter behaviour against the dev20 org's actual filestore listing — three unrelated user collections (`My File Store`, `HTML Reports`, …) are correctly filtered out. |

### Iteration 3 (2026-04-29)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | (none — clean run) | — | — | "✅ Bugbot reviewed your changes and found no new issues!" — review of commit `211c512`. CI green: frontend, rust, Cursor Bugbot all `completed:success`. Zero unresolved cursor threads. |

**BugBot loop exit:** clean run achieved at iteration 3. Phase 1 implementation is code-complete. Manual scenarios MS-1 through MS-7 remain the gating step before merge — see PR description.
