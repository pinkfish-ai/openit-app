# PIN-5775: Phase 2 — KB local-first sync — Plan addendum

**Date:** 2026-04-29
**Supersedes:** the Phase 2 implementation plan drafted earlier (`auto-dev/plans/2026-04-29-PIN-TBD-phase2-kb-local-first-plan.md`, never merged — local only).
**Brief:** `auto-dev/plans/2026-04-29-PIN-5775-phase2-brief.md` (engineer-approved 2026-04-29).
**Status:** Drafted after Phase 1 squash-merged to main as `b8ffcee`. Engineer directive: "this should be solid architecture that has minimal duplication."

---

## Why we're amending

Three things changed since the original Phase 2 plan was drafted:

1. **Phase 1 squashed to main** (`b8ffcee`) with extra cleanup beyond the original PR review — `dedupeOpenitByName`, `conflictsByCollection` + `flattenConflicts`, an `activePrefixes` Set tracked across the run, in-flight resolve dedup keyed per org. The post-squash `filestoreSync.ts` (707 LOC) now contains substantial machinery that the original plan would have replicated in `kbSync.ts` as a copy-paste.

2. **The weekend's R1–R5 already centralized more than the original Phase-2 plan recognised.** Specifically, `syncEngine.ts:842–920` exports `startReadOnlyEntitySync` — a full-lifecycle helper that agents (67 LOC) and workflows (66 LOC) use as their entire wrapper. The comment at line 846 names what's still per-engine: *"agents and workflows use this; KB, filestore, and datastore have entity-specific bootstrap (collection resolve + initial item write) that doesn't fit this template."* That's the gap Phase 2 fills.

3. **The engineer flagged duplication directly.** The right move is to add the multi-collection sibling to the engine's existing helper family — not to invent a separate "orchestrator" with a different naming convention.

The brief's success criteria are unchanged. What changes is *how* we get there: instead of "rewrite kbSync.ts to mirror filestoreSync.ts", it's "add `startCollectionEntitySync` to `syncEngine.ts` next to `startReadOnlyEntitySync`, then collapse both `filestoreSync.ts` and `kbSync.ts` to wrappers around it."

## Architecture target — extend the existing helper family

The engine already publishes one lifecycle helper (`startReadOnlyEntitySync`). Phase 2 adds a sibling in the same file with the same naming convention. No new "orchestrator" file, no new vocabulary — just the next member of an existing family.

```
syncEngine.ts                                 (universal layer)
├── pullEntity                                — bidirectional reconciler
├── startPolling / withRepoLock               — poll loop, lock helper
├── subscribe/clearConflicts/buildConflictPrompt — conflict bus
├── startReadOnlyEntitySync         (R4)      — flat-list wrapper. Used by:
│   ├── agentSync.ts (67 LOC)
│   └── workflowSync.ts (66 LOC)
└── startCollectionEntitySync       (NEW)     — multi-collection-of-files wrapper. Used by:
    ├── filestoreSync.ts  (was 707 → ~80 LOC)
    └── kbSync.ts         (was 415 → ~80 LOC)

(datastoreSync.ts stays as-is — rows + schema is a different shape;
 a third sibling `startRowCollectionEntitySync` is plausible later but
 out of scope for Phase 2.)
```

What `startCollectionEntitySync` owns:

- Discovery (REST list + `openit-*` filter + dedupe-by-name + in-flight per-org resolve dedup).
- Auto-create defaults loop (with eventual-consistency post-create refetch).
- Per-collection folder-ensure.
- Per-collection conflict tracking (`conflictsByCollection` + `flattenConflicts`).
- Per-collection prefix tracking (`activePrefixes` for stop-time conflict-bus cleanup).
- Initial pull + 60s poll loop, sequential per collection (avoids `.git/index.lock` races).
- `lastSyncAt` stamp on every successful pull.
- `hasServerShadowFiles` walker across every active collection's folder.
- Status object + listener pattern (`subscribe*Sync` / `get*SyncStatus`).
- `pullAllNow` and `stop`.

What stays per-engine in the wrapper file:

- The engine-specific config (entity name, REST `?type=` filter, default names list, local folder root, display label).
- The push function (`pushOne` — different upload Tauri command per engine).
- Engine-specific re-exports the call sites depend on (e.g. `kbServerShadowFilename`, `displayFilestoreName`, `OPENIT_FILESTORE_PREFIX`).

What stays per-engine outside the wrapper:

- **`entities/kb.ts` / `entities/filestore.ts`** — adapter factory (per-collection routing into the right `${root}/<displayName>/` — `EntityAdapter` instances per collection). Both engines hand identical-shaped adapters to the orchestrator.
- **`nestedManifest.ts` (new)** — per-collection manifest persistence (`{ [collectionId]: KbStatePersisted }`), parameterised on entity name (`"fs"` | `"kb"`). Replaces `filestoreManifest.ts`. **One copy of the manifest shape**, used by both engines' adapters.

## What this means for the other entities (datastore, agents, workflows)

The user's question while reviewing this addendum: *will this also centralize for the other entities — even though each may sync differently?*

**Yes, partially — but not by forcing every engine through one orchestrator.** The honest layered model:

| Engine | Shape | How it plugs in |
|---|---|---|
| Agents | Flat list. Read-only. | Already uses `startReadOnlyEntitySync`. ✅ |
| Workflows | Flat list. Read-only. | Already uses `startReadOnlyEntitySync`. ✅ |
| Filestore | Multi-collection of files. Read+write. | Phase 2: switches to `startCollectionEntitySync`. |
| KB | Multi-collection of files. Read+write. | Phase 2: switches to `startCollectionEntitySync`. |
| Datastore | Multi-collection of rows + schema doc. Read+write. Different conflict unit (row, not file). | Stays per-engine for now. A future sibling `startRowCollectionEntitySync` is plausible if it earns its place. |

The guiding principle: **don't fit every engine into one super-orchestrator. Build small siblings for each shape, named consistently, living next to each other in `syncEngine.ts`.** When the inner sync shape is the same, the engines collapse to thin wrappers. When the inner shape differs (datastore's rows + schema), it gets its own sibling rather than a knob on someone else's orchestrator.

This is the same instinct that made `startReadOnlyEntitySync` its own helper rather than a flag on `pullEntity`. Phase 2 just extends the family by one.

## Files to modify (revised)

| File | Change |
| --- | --- |
| `src/lib/nestedManifest.ts` (new) | Generic `loadCollectionManifest(repo, entityName, collectionId)` / `saveCollectionManifest(repo, entityName, collectionId, collectionName, manifest)`. Routes through `kbStateLoad/Save` or `fsStoreStateLoad/Save` based on entity name. Includes flat-format migration (returns default for that collection — same semantics as Phase 1's `filestoreManifest.ts`). |
| `src/lib/filestoreManifest.ts` | Delete. All callers move to `nestedManifest.ts`. |
| `src/lib/syncEngine.ts` | Add `startCollectionEntitySync` next to `startReadOnlyEntitySync` (around line 920, end of file). Same naming family, same return-handle shape (`MultiCollectionSyncHandle` with `stop()` + `firstAttempt`), same `onLog` + `itemLabel` logging pattern. ~250 LOC. Owns: discovery / dedupe / in-flight resolve, auto-create defaults, per-collection folder ensure, per-collection conflict tracking + flatten, per-collection prefix tracking, initial pull + 60s poll per collection, `lastSyncAt` stamp, `hasServerShadowFiles` walker, status object + listeners, `pullAllNow`, `stop`. The push path stays callback-based — wrappers supply `pushOne(collection, onLine)` and the orchestrator routes per-collection lock + status updates around it. |
| `src/lib/filestoreSync.ts` | Reduce to a thin wrapper: call `startCollectionEntitySync(filestoreConfig)`, supply `pushOne`, re-export under the existing names (`startFilestoreSync`, `stopFilestoreSync`, `pullOnce`, `pushAllToFilestore`, `subscribeFilestoreSync`, `getFilestoreSyncStatus`, `displayFilestoreName`, `OPENIT_FILESTORE_PREFIX`, `dedupeOpenitByName`, `getDefaultFilestores`). Net loss: ~620 LOC moves into the engine helper. **No behaviour change** — same statuses, same logs, same lifecycle. Phase 1 manual scenarios remain green. |
| `src/lib/kbSync.ts` | New thin wrapper using `startCollectionEntitySync`. Per-collection KB sync. Re-exports `startKbSync`, `stopKbSync`, `pullAllKbNow`, `pushAllToKb`, `subscribeSync` (back-compat name), `getSyncStatus` (back-compat name), `kbHasServerShadowFiles`, `buildKbConflictPrompt`, `kbServerShadowFilename`, `kbBaseFromShadowFilename`. ~80 LOC. Drops the singular `pullNow({ collection })` — call sites switch to `pullAllKbNow`. |
| `src/lib/kb.ts` | Drop MCP path entirely. New `resolveProjectKbs(creds)` returning `KbCollection[]` via REST `/datacollection/?type=knowledge-base`, prefix-filtered to `openit-*`, deduped by name (smallest id wins). `displayKbName(name)` helper. `OPENIT_KB_PREFIX` constant. |
| `src/lib/entities/kb.ts` | Per-collection adapter: `kbAdapter({ creds, collection })` derives `DIR = knowledge-bases/<displayName>` and uses `kb:<collection.id>` as the conflict-bus prefix. Switches local IO from `kbListLocal` / `kbDeleteFile` to the generic `entityListLocal` / `entityDeleteFile` (already subdir-aware). Persistence via `nestedManifest.ts`. |
| `src-tauri/src/kb.rs` | Add `subdir: Option<String>` to `kb_upload_file` and `kb_download_to_local`. New `kb_path_with_optional_subdir` helper mirroring the Phase-1 `fs_path_with_optional_subdir`. |
| `src/lib/api.ts` | Optional `subdir` arg on `kbDownloadToLocal` and `kbUploadFile`. |
| `src/App.tsx` | `startKbSync` no longer takes `orgSlug`/`orgName` (Phase 2 dropped MCP-driven naming-by-org). |
| `src/shell/Shell.tsx` | `kbStatus.collection` → `kbStatus.collections`. Replace `pullNow({ collection })` with `pullAllKbNow`. |
| `src/lib/pushAll.ts` | Pre-push pull walks every KB collection; per-collection push after the cross-collection conflict scan. |
| `scripts/openit-plugin/scripts/sync-resolve-conflict.mjs` | Rewrite to navigate the nested manifest format. Auto-detect nested vs flat. Route `kb:<id>` directly to the bucket; route `filestores/<name>` and legacy `knowledge-bases/<name>` to the right bucket via `collection_name` lookup. Fixes a Phase-1 oversight where conflicts under `filestores/attachments` couldn't resolve. |
| `src/lib/nestedManifest.test.ts` (new) | Round-trip, isolation across collections, legacy-format migration, both backends. |
| `src/lib/syncOrchestrator.test.ts` (new) | Lifecycle smoke (start with mock config, conflicts route per-collection, stop clears state). Covers the centralization invariant. |
| `src/lib/entities/kb.test.ts` (new) | Per-collection adapter routing, prefix isolation, subdir threading. |
| `src/lib/kb.test.ts` (new) | Pure-helper tests for the resolver module (prefix constant, displayKbName). |
| `src/lib/filestoreSync.test.ts` | Unchanged in intent — still asserts on the public helpers it covered before. The wrapper change should be invisible to existing tests. |
| `integration_tests/kb-sync.test.ts` (new) | Mirror of `filestore-sync.test.ts` against a real test org — discovery filter, multi-collection routing, push from local-only, server-delete propagation. |
| `integration_tests/kb-adapter-routing.test.ts` (new) | Mirror of `adapter-routing.test.ts`. |

## Implementation checklist (revised, centralization-first)

### Step 1 — Extract `nestedManifest.ts`

Same as the original plan. Foundation for both engines.

- [ ] Create `src/lib/nestedManifest.ts`.
- [ ] Migrate `filestoreSync.ts` and `entities/filestore.ts` callers.
- [ ] Delete `filestoreManifest.ts`.
- [ ] `src/lib/nestedManifest.test.ts`.
- [ ] `npx vitest run` clean.

### Step 2 — Add `startCollectionEntitySync` to syncEngine.ts and migrate filestoreSync.ts onto it

The centralization. Add the helper next to `startReadOnlyEntitySync`. Move every shared piece (status, listeners, conflict tracking, lifecycle, polling loop, in-flight resolve dedup, auto-create defaults, folder ensure, `lastSyncAt`, `hasServerShadowFiles`) out of `filestoreSync.ts` and into the helper. `filestoreSync.ts` becomes a thin wrapper.

- [ ] Add `startCollectionEntitySync` to `src/lib/syncEngine.ts` (at the bottom, sibling to `startReadOnlyEntitySync`).
- [ ] Reduce `filestoreSync.ts` to ~80 LOC of config + `pushOne` + re-exports.
- [ ] All Phase-1 filestore tests still pass (`vitest run`, manual MS-1..MS-7 unaffected).
- [ ] Add tests next to the helper in `src/lib/syncEngine.test.ts` covering the new lifecycle.

### Step 3 — Tauri subdir support for KB

Direct port of Phase-1's `fs_store_*` change. Independent of orchestrator extraction; can be in parallel.

- [ ] `kb_path_with_optional_subdir` helper in `src-tauri/src/kb.rs`.
- [ ] `kb_upload_file` and `kb_download_to_local` take `Option<String> subdir`.
- [ ] `kbDownloadToLocal` / `kbUploadFile` TS wrappers add optional `subdir`.
- [ ] 3 cargo tests.
- [ ] `cargo build && cargo test --lib kb::` clean.

### Step 4 — KB resolver REST + multi-collection

Drop MCP, switch to REST, return all `openit-*` KBs.

- [ ] Rewrite `src/lib/kb.ts` for REST `/datacollection/?type=knowledge-base`.
- [ ] `resolveProjectKbs(creds)` + `displayKbName` + `OPENIT_KB_PREFIX`.
- [ ] Drop dead `listFiles` / `uploadFile` MCP wrappers.

### Step 5 — KB adapter (`entities/kb.ts`) per-collection

Mirror `entities/filestore.ts` shape.

- [ ] Per-collection adapter with `DIR = knowledge-bases/<displayName>`, `prefix = kb:<id>`.
- [ ] Switch local IO to generic `entityListLocal` / `entityDeleteFile`.
- [ ] Persistence via `nestedManifest.ts`.
- [ ] `src/lib/entities/kb.test.ts`.

### Step 6 — KB wrapper around `startCollectionEntitySync`

Now the cheap part: feed KB config into the helper, supply `pushAllToKb` (engine-specific upload), re-export under the names call sites already use. Symmetric with the filestoreSync.ts wrapper after Step 2.

- [ ] Rewrite `kbSync.ts` as a thin wrapper around `startCollectionEntitySync`.
- [ ] Drop singular `pullNow({ collection })` — call sites move to `pullAllKbNow`.
- [ ] `src/lib/kb.test.ts` (helper-only).
- [ ] Update `App.tsx` (drop `orgSlug`/`orgName` from `startKbSync`).
- [ ] Update `Shell.tsx` (`pullAllKbNow`, plural status).
- [ ] Update `pushAll.ts` (pre-push pull walks all collections; per-collection push).
- [ ] `npx tsc --noEmit && npx vitest run` clean.

### Step 7 — Plugin script

- [ ] Rewrite `scripts/openit-plugin/scripts/sync-resolve-conflict.mjs` to handle the nested manifest. Auto-detect nested vs flat. Route `kb:<id>` directly; route `filestores/<name>` / `knowledge-bases/<name>` via `collection_name` lookup.
- [ ] End-to-end test against a synthetic nested manifest (kb:<id> force-push, knowledge-bases/<name> name-lookup, filestores/<name> Phase-1 fix-up, invalid prefix and missing bucket).

### Step 8 — Integration tests

- [ ] `integration_tests/kb-sync.test.ts`, `integration_tests/kb-adapter-routing.test.ts`.
- [ ] `npm run test:integration` clean against a real test org.

### Step 9 — Cleanup + manual sign-off

- [ ] `npx tsc --noEmit`, `cd src-tauri && cargo build && cargo test --lib && cargo fmt --check`, `npx vitest run`.
- [ ] Strip debug logs.
- [ ] Run MS-1..MS-8 in `npm run tauri dev`.
- [ ] Diff size sanity check — net LOC delta should be NEGATIVE on `filestoreSync.ts` (centralization removes more than KB adds).

### Step 10 — Stop. Engineer review.

Hard stop per `auto-dev/02-impl.plan.md`. Don't roll into stage 04 until approved.

### Step 11 — Stacked PR

- [ ] Push branch.
- [ ] Open stacked PR with base `main` (Phase 1 has merged, so this is an ordinary PR now, not a stacked one as originally planned).

## Risks

1. **Refactoring filestoreSync.ts in flight** is the highest-risk change. Phase 1 just merged; behaviour is known-good. Mitigation: keep public API identical (same export names, same status shape, same call signatures), rely on existing `filestoreSync.test.ts` + `integration_tests/filestore-sync.test.ts` to catch regressions, run Phase-1 manual scenarios MS-1..MS-7 before merge.

2. **`startCollectionEntitySync` generic surface.** Easy to over-fit to filestore's shape and have to bend it for datastore later. Mitigation: design the config interface explicitly around what's *known to differ* across the two engines we have today (KB + filestore), not around hypothetical datastore needs. If datastore (rows + schema) doesn't fit, that's a sign for a sibling helper (`startRowCollectionEntitySync`) — same naming family, different inner shape — rather than growing knobs on this one. Same instinct that gave us `startReadOnlyEntitySync` as its own helper instead of a flag on `pullEntity`.

3. **The thin-wrapper export shape** must match the current public API exactly so call sites compile unchanged. Audit `Shell.tsx`, `App.tsx`, `pushAll.ts`, `FileExplorer.tsx`, `SourceControl.tsx` for every `kbSync` / `filestoreSync` import before declaring Step 6 done.

4. **`buildKbConflictPrompt` / `kbHasServerShadowFiles`** are KB-specific UI helpers. The orchestrator can offer a generic `hasServerShadowFiles` (walks every collection's folder) and a generic `buildConflictPrompt(displayLabel, collections, conflicts)` — KB and filestore both consume them with their own labels.

## Net diff expectation

Pre-extraction: `filestoreSync.ts` 707 LOC + `kbSync.ts` 415 LOC = **1,122 LOC of collection-orchestrator-shaped code, mostly duplicated.**

Post-extraction: new `startCollectionEntitySync` ~250 LOC inside `syncEngine.ts` + `filestoreSync.ts` ~80 LOC + `kbSync.ts` ~80 LOC = **~410 LOC.** Net **~710 LOC removed** while gaining KB multi-collection support.

Plus ~150 LOC of new `nestedManifest.ts`, ~150 LOC of new `entities/kb.ts`, ~100 LOC of new `kb.ts`, integration tests.

If at the end of Step 9 the net delta on `filestoreSync.ts` + `kbSync.ts` is positive, the extraction failed and the helper's interface needs simplification before this lands.

---

## BugBot Review Log

### Iteration 1 (2026-04-29)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | Legacy prefixes fail against nested manifest format | Medium | Fixed | `eabdef4` — V2 hasn't launched, no in-flight transcripts to honour. Dropped the legacy `kb` / `filestore` short prefixes from `sync-resolve-conflict.mjs` entirely. The script now only accepts the per-collection forms (which carry collection identity) plus the flat-only short names for `datastore` / `agent` / `workflow`. Earlier `0b5c2de` added a hint-error for the legacy + nested combination — superseded by this clean removal. |
| 2 | `startKbSync` silently drops the documented `onLog` callback | Low | Fixed | `3e16703` — added `onLog?: (msg: string) => void` to the orchestrator's `start({creds, repo, onLog})` and forwarded to `resolveCollections(creds, onLog)` so per-collection log lines (`✓ openit-default (id: …)`) reach the modal log / terminal status pane during connect. `startKbSync` passes `args.onLog` through cleanly. Side-update: the two `sync-resolve-conflict.test.ts` cases that used the removed legacy prefixes (`kb`, `filestore`) switched to the per-collection forms. |

### Iteration 2 (2026-04-29)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | (none — clean run) | — | — | "✅ Bugbot reviewed your changes and found no new issues!" — review of commit `84ac1f9`. CI green: frontend, rust, Cursor Bugbot all passing. Both iter-1 threads resolved. |

**BugBot loop exit:** clean run achieved at iteration 2. Phase 2 implementation is code-complete. Manual MS-1 through MS-6 (per the brief) remain the gating step before the engineer signs off on merge — see PR description.
