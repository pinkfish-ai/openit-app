# PIN-5779: Phase 3 — Datastore consolidation + custom-datastore overview tile — Implementation plan

**Ticket:** [PIN-5779](https://linear.app/pinkfish/issue/PIN-5779/openit-v2-sync-phase-3-datastore-consolidation-custom-datastore)
**Date:** 2026-04-29
**Repo:** `openit-app` (primary)
**References:** `/firebase-helpers` (REST shape for `/datacollection/`, `/memory/items`, `/memory/bquery`), `/web` (plugin scripts mirror — though the dest path doesn't exist on web/main yet), `/platform` (only if datastore push exposes a new endpoint we need to verify)
**Predecessor:** PIN-5775 (Phase 1 PR #63 + Phase 2 PR #66, both merged)
**Brief:** `auto-dev/plans/2026-04-29-PIN-5779-phase3-brief.md`

---

## 1. Technical investigation

### 1a. Current datastoreSync.ts shape (685 LOC)

Module-level state:

- `createdCollections: Map<orgId, Map<name, DataCollection>>` — org-scoped cache (`datastoreSync.ts:69`).
- `lastCreationAttemptTime: Map<orgId, number>` — 10s cooldown to avoid POST loops on slow `/datacollection/` GET propagation (`datastoreSync.ts:91`).
- `inflightResolve: Map<orgId, Promise<…>>` — concurrent-resolve dedup (`datastoreSync.ts:74`).
- `stopPoll: (() => void) | null` — singular timer handle (`datastoreSync.ts:608`).

Lifecycle:

- `resolveProjectDatastores(creds, onLog)` (`datastoreSync.ts:93–109`) — wraps the inflight cache.
- `resolveProjectDatastoresImpl` (`datastoreSync.ts:111–271`) — REST `GET /datacollection/?type=datastore`, filters to `DEFAULT_DATASTORES.map(d => \`${d.name}-${creds.orgId}\`)` (line 137 — **org-suffixed name convention**, different from filestore + KB which dropped the org-suffix in Phase 1), auto-creates missing defaults with `isStructured: true` hardcoded (line 184), 5-second sleep + post-create refetch.
- `writeDatastoreSchemas(repo, collections)` (`datastoreSync.ts:297–320`) — content-equality `_schema.json` write under `databases/<colName>/`, scoped by `withRepoLock(repo, "datastore")`. Only structured collections get a schema written (`if (!col.schema) continue` line 305).
- `pushAllToDatastores(args)` (`datastoreSync.ts:345–549`) — full reconcile: POST `/memory/items` for new, PUT `/memory/items/<id>` for changed, DELETE `/memory/items/id/<id>` for missing. Per-collection deletion phase guarded by `localDirExists` (line 481 — critical safety check; without this, an empty local dir would nuke remote on the first commit). Post-push reconcile re-fetches each touched collection and updates the manifest's `remote_version` (`datastoreSync.ts:511–545`).
- `pullDatastoresOnce(args)` (`datastoreSync.ts:566–606`) — manual single-shot pull. Always resolves (returns `{ ok: false }` rather than throw).
- `startDatastoreSync(args)` (`datastoreSync.ts:610–677`) — resolve once (cached adapter), schema-write side-effect, then `setInterval(tryResolveAndPull, DEFAULT_POLL_INTERVAL_MS)`. Iter-2 / iter-12 BugBot fixes for the resolve-and-share strategy + "install poller before first attempt" pattern are baked in.
- `stopDatastoreSync()` (`datastoreSync.ts:679–685`) — clears poll, calls `clearConflictsForPrefix("datastore")`.

### 1b. Current entities/datastore.ts shape

`datastoreAdapter({ creds, collections })` — **single adapter holding the whole collection list** (`entities/datastore.ts:59–209`). Key implementation details:

- `prefix: "datastore"` (single — every collection's conflicts aggregate under one prefix).
- `listRemote` paginates each collection (`PAGE = 1000`, `PAGINATION_SAFETY_CAP = 100_000`), flattens across all collections, tracks per-collection failures via `unreliableKeyPrefixes: ["<colName>/", …]` so a partial failure only excludes that collection from the engine's server-delete pass.
- `manifestKey: \`${col.name}/${key}\`` — the `<colName>/<key>` convention. With per-collection adapters (Phase 3), this would simplify to `<key>` since the collection is implicit in each adapter's scope.
- `listLocal` walks every collection's subdir, classifies shadows per-collection.
- `onServerDelete` parses `<colName>/<key>` from the manifestKey to figure out which file to delete.
- `inlineContent` callback on `RemoteItem` — engine uses this for content-equality at bootstrap-adoption (rows are already in the list response, no extra HTTP).

### 1c. The shared helper from Phase 2 (createCollectionEntitySync)

`syncEngine.ts:962–1532` — `createCollectionEntitySync<C extends CollectionLike>(config)`. Owns:

- Status object, listener pattern, per-collection conflict tracking, `flattenConflicts` union.
- `activePrefixes: Set<string>` for stop-time `clearConflictsForPrefix` cleanup.
- In-flight resolve dedup keyed by orgId.
- REST discovery via `GET /datacollection/?type=<config.collectionType>`, `openit-*` filter, dedupe-by-name.
- Auto-create defaults loop with eventual-consistency post-create refetch.
- Per-collection folder ensure (`.placeholder` write/delete).
- Initial pull then 60s poll, sequential per collection.
- `lastSyncAt` stamp on every successful pull (`projectUpdateLastSyncAt`).
- `hasServerShadowFiles` walker.
- `pullAllNow` / `pullOne` / `pushOne` lifecycle methods. `pushOne` wraps the engine-specific impl in a per-collection lock + status transitions.

What it doesn't currently have:

- A schema-write side-effect hook. Phase 3 adds `onAfterResolve?: (repo, collections) => Promise<void>` to the config; the helper calls it once per `start()` after the resolve+auto-create completes, before the per-collection pull loop. Datastore's wrapper supplies this; filestore + KB pass `undefined`.

### 1d. Manifest shape

Today: flat — `.openit/datastore-state.json` with `KbStatePersisted` shape, manifestKey-keyed `files` map, every collection's keys mixed in one bucket via the `<colName>/<key>` prefix scheme. Single-source-of-truth for schemas + items.

Phase 2 introduced the nested per-collection manifest in `nestedManifest.ts`, used by filestore + KB. Datastore Phase 3 migrates onto it: `EntityName` extends to `"fs" | "kb" | "datastore"`, and the manifest at `.openit/datastore-state.json` becomes `{ [collectionId]: KbStatePersisted }`. With per-collection adapters, each adapter loads/saves its own bucket.

The `<colName>/<key>` manifestKey convention disappears — manifestKey becomes plain `<key>` (the collection is implicit in the bucket). The plugin script `sync-resolve-conflict.mjs` and any other consumer that parsed the slash-separated key need updating.

### 1e. Naming convention drift

Filestore Phase 1 dropped the `-<orgId>` suffix (`openit-docs-<orgId>` → `openit-library`). KB Phase 2 followed the same pattern (`openit-default`, `openit-runbooks`). Datastore is still on the legacy `openit-tickets-<orgId>` convention (`datastoreSync.ts:137`). Phase 3 normalises: defaults rename to plain `openit-tickets`, `openit-people`. V2 hasn't launched, so test orgs with the legacy names get orphaned — same risk profile as Phase 1's `openit-docs-<orgId>` orphaning, accepted in the brief.

### 1f. Workbench overview (Workbench.tsx)

Stations array (`Workbench.tsx:22–33`):

```ts
const STATIONS: Station[] = [
  { id: "inbox",     kind: "inbox",     rel: "databases/tickets", countMode: "json-rows" },
  { id: "reports",   kind: "reports",   rel: "reports",           countMode: "files" },
  { id: "people",    kind: "people",    rel: "databases/people",  countMode: "json-rows" },
  { id: "knowledge", kind: "knowledge", rel: "knowledge-bases",   countMode: "dirs" },
  { id: "files",     kind: "files",     rel: "filestores",        countMode: "dirs" },
  { id: "agents",    kind: "agents",    rel: "agents",            countMode: "json-rows" },
  { id: "cli",       kind: "cli",       rel: "cli",               countMode: "files" },
];
```

`rel` here points at on-disk paths. Note: `databases/tickets` and `databases/people` are unprefixed (no `openit-`). After Phase 3's rename to drop the `-<orgId>` suffix, the on-disk folder is still `databases/openit-tickets/` (the cloud collection name with the openit- prefix). The current Workbench code reads from `databases/tickets` which won't match — there's an existing path mismatch we'll need to verify against running code (or it's been updated elsewhere; investigate before touching).

Actually verifying via `FileExplorer.tsx:85`: `if (rel.match(/^databases\/openit-[^/]+$/)) {…}` — confirms the on-disk dir IS prefixed. So the Workbench station's `rel: "databases/tickets"` is wrong / pre-rename. **Before adding the new conditional tile, verify what the existing tickets/people stations actually open** — there may be a pre-existing path bug.

Phase 3 inserts a conditional `databases` station after `people`:

```ts
{ id: "databases", kind: "databases", rel: "databases", countMode: "dirs",
  /* new property */ visibleIf: (state) => hasCustomDatastores(state) },
```

`hasCustomDatastores` checks the FileExplorer's `datastores` state for any entry whose name doesn't match the two defaults.

### 1g. ENTITY_META

`shell/entityIcons.tsx` defines per-`EntityKind` icon, tone, label. Phase 3 adds a `databases` kind with an appropriate icon (probably the database/columns icon Lucide ships).

### 1h. FileExplorer existing collection card

`FileExplorer.tsx:85`: `if (rel.match(/^databases\/openit-[^/]+$/))` produces a "datastore collection" view. Phase 3's listing-view reuses this pattern: render every `openit-*` datastore as a card with row count + last-sync timestamp.

The existing collection-card visual is in `FileExplorer.tsx` near the top — actual component name to be confirmed in implementation. Don't reinvent; co-locate.

### 1i. Plugin scripts — `sync-resolve-conflict.mjs`

Currently accepts `--prefix datastore` for the flat manifest at `.openit/datastore-state.json`. With Phase 3's nested-manifest migration, the script needs to:

- Recognise the nested format for `datastore` (auto-detect like KB / filestore).
- Route per-collection prefixes (`databases/<name>`) into the right bucket via `collection_name` lookup.
- Keep the legacy short `datastore` prefix working for the **flat** manifest (backward-compat for any in-flight transcripts — but per Phase 2's lesson, legacy short prefixes against nested are an error path with a hint).

### 1j. Test surface

Existing:

- `src/lib/syncEngine.test.ts` — engine primitives.
- `src/lib/nestedManifest.test.ts` — Phase 2's nested-manifest.
- `src/lib/entities/filestore.test.ts` + `src/lib/entities/kb.test.ts` — adapter routing.
- `integration_tests/adapter-routing.test.ts` — covers filestore + kb.
- `integration_tests/filestore-sync.test.ts` + `integration_tests/kb-sync.test.ts` — real-API.

No datastore unit tests today. No datastore real-API integration test today. Phase 3 adds both.

---

## 2. Proposed solution

### Approach

Three coupled pieces:

1. **Engine helper** — extend `createCollectionEntitySync` with an `onAfterResolve(repo, collections)` config hook that fires once per `start()` after auto-create + re-resolve, before the per-collection pull loop. Purely additive — filestore + KB pass `undefined` and behave identically. Datastore supplies the schema-write step.

2. **Datastore engine** — refactor for per-collection adapter shape, plug into `createCollectionEntitySync`, drop the org-suffix from default names, add `nestedManifest.ts` support for `"datastore"` entity name, branch on `isStructured` where the API surfaces diverge (push body shape, list-items request).

3. **Overview UX** — conditional `databases` Workbench station + listing view that reuses the existing FileExplorer collection-card pattern.

### Files to modify

| File | Change |
| --- | --- |
| `src/lib/syncEngine.ts` | Add `onAfterResolve?: (repo: string, collections: C[]) => Promise<void>` to `CollectionSyncConfig<C>`. Call it inside `start()` after `update({ collections })` and before the per-collection pull loop. Errors warn-log only (don't fail the whole sync). |
| `src/lib/nestedManifest.ts` | Extend `EntityName` from `"fs" | "kb"` to `"fs" | "kb" | "datastore"`. Add `datastoreStateLoad` / `datastoreStateSave` to the loaders/savers maps. Existing legacy-flat-format detection migrates the old datastore manifest forward (bucket discarded — fresh state on first sync, same as Phase 2 KB). |
| `src/lib/entities/datastore.ts` | Refactor to **per-collection** adapter: `datastoreAdapter({ creds, collection })` (singular). `prefix: \`databases/<displayName>\`` per filestore/KB pattern. `manifestKey` simplifies to `<key>` (was `<colName>/<key>`). `listRemote` paginates ONE collection (drops the across-collections flatten). `listLocal` reads `databases/<colName>/`. `onServerDelete` doesn't need to parse the slash anymore. Persistence via `loadCollectionManifest(repo, "datastore", collection.id)` / `saveCollectionManifest`. The `unreliableKeyPrefixes` mechanic moves to per-adapter (each adapter reports its own unreliability via `paginationFailed: true`). |
| `src/lib/datastoreSync.ts` | Collapse to ~150 LOC: define the `CollectionSyncConfig<DataCollection>` (or a new `DatastoreCollection` type), supply `pushOne` (per-collection upload — the existing full-reconcile logic, scoped to one collection), supply `onAfterResolve` (calls `writeDatastoreSchemas(repo, collections)`). Drop `-<orgId>` suffix from default names — `openit-tickets`, `openit-people`. Drop `inflightResolve` / `lastCreationAttemptTime` / `createdCollections` (orchestrator owns them now). Keep `resolveProjectDatastores`, `pullDatastoresOnce`, `pushAllToDatastores`, `startDatastoreSync`, `stopDatastoreSync` exported under the same names so Shell.tsx / pushAll.ts compile unchanged. Status type `DatastoreSyncStatus = CollectionSyncStatus<DataCollection>`. |
| `src/lib/api.ts` | Confirm `datastoreStateLoad` / `datastoreStateSave` exist (they should — they were added during R2). No new wrappers. |
| `src/lib/pushAll.ts` | Update if datastore's status surface changes (`getDatastoreSyncStatus` becomes available, replacing the side-channel through `pullDatastoresOnce`). Likely a small simplification. |
| `src/shell/Workbench.tsx` | Add new `databases` station entry after `people`. Wire conditional visibility based on whether any non-default `openit-*` datastore is present. Reuse existing station-rendering machinery. |
| `src/shell/entityIcons.tsx` | Add `databases` to `EntityKind`; pick icon + tone + label. |
| `src/shell/FileExplorer.tsx` | Add a "datastores listing" route — when the user clicks the new Workbench tile, FileExplorer renders a card grid of every `openit-*` datastore. Each card shows row count + last-sync timestamp + click-through to `databases/<colName>/`. Reuse existing collection-card visual. |
| `scripts/openit-plugin/scripts/sync-resolve-conflict.mjs` | Recognise nested format for `datastore` (auto-detect). Route `--prefix databases/<name>` to the right bucket via collection_name lookup. Legacy short `datastore` prefix against a nested manifest emits the same `legacy_prefix_against_nested_manifest`-style error Phase 2 added for KB / filestore. |
| `scripts/openit-plugin/skills/datastores.md` (new) | Plugin skill teaching Claude how to interact with datastores. File-ops first, schema-aware for structured, gateway/MCP for semantic queries. Per the brief's section 7. |

### Unit tests

| Test file | What it covers |
| --- | --- |
| `src/lib/entities/datastore.test.ts` (new) | Per-collection adapter routing: `prefix` is `databases/<name>`, `manifestKey` is bare `<key>`, `workingTreePath` is `databases/<colName>/<key>.json`, `inlineContent` returns the row JSON, `listLocal` skips `_schema.json`. Branch on `isStructured` for any flavor-specific listing logic. |
| `src/lib/nestedManifest.test.ts` | Add cases for the `"datastore"` entity name. Round-trip + isolation across collections + legacy-flat-format migration. |
| `src/lib/datastoreSync.test.ts` (new) | Helper-only: default-names list (no org-suffix), `displayDatastoreName` strips `openit-`, schema-write skips unstructured. |
| `scripts/openit-plugin/scripts/sync-resolve-conflict.test.ts` | Add cases for `--prefix databases/<name>` against nested datastore manifest, force-push + delete actions, legacy `datastore` short prefix against nested → clean error. |
| `src/lib/syncEngine.test.ts` | Add coverage for `onAfterResolve` hook firing after auto-create and before pull loop. |

### Manual scenarios

- **MS-1.** Fresh connect with no datastores on cloud → orchestrator auto-creates `openit-tickets` + `openit-people` (both structured). Local `databases/openit-tickets/_schema.json` and `databases/openit-people/_schema.json` written.
- **MS-2.** Pre-existing structured `openit-tickets-<orgId>` on cloud (legacy name) → not picked up by the new `openit-tickets` filter. Phase 3 doesn't migrate. (Document in PR description.)
- **MS-3.** Edit a row file `databases/openit-tickets/<key>.json` locally → next poll pushes. Verify on dashboard.
- **MS-4.** Create a row on dashboard → next poll pulls down to `databases/openit-tickets/<key>.json`.
- **MS-5.** Both sides edit the same row → `.server.json` shadow lands; conflict bubble names the right path; resolve script clears.
- **MS-6.** Delete a row on dashboard → next poll removes the local file.
- **MS-7.** Create an UNSTRUCTURED datastore `openit-notes` on the dashboard → next poll pulls it down to `databases/openit-notes/`. NO `_schema.json` written. Row round-trip works.
- **MS-8.** Delete a row file locally, commit → push DELETE-by-id removes the row from the cloud.
- **MS-9.** Workbench overview with only `openit-tickets` + `openit-people` shows the 2 default tiles, NO "Databases" tile.
- **MS-10.** Workbench overview after creating `openit-projects` on the dashboard → shows the 2 default tiles AND the new "Databases" tile. Click → listing view renders 3 cards. Click a card → opens FileExplorer at `databases/openit-projects/`.
- **MS-11.** Phase 1 (filestore) + Phase 2 (KB) manual scenarios still pass — no regression.
- **MS-12.** `cloud.json.lastSyncAt` updates after a datastore pull.

### Cross-repo plugin steps

1. Dev edit in `openit-app/scripts/openit-plugin/scripts/sync-resolve-conflict.mjs` (already covered in the test surface above).
2. Dev edit in `openit-app/scripts/openit-plugin/skills/datastores.md` (new file).
3. Test by copying both into `~/OpenIT/<orgId>/.claude/scripts/` and `~/OpenIT/<orgId>/.claude/skills/` respectively.
4. **At merge:** the playbook says copy into `web/packages/app/public/openit-plugin/`, but `/web` doesn't have that path on `origin/main` today (Phase 1 + Phase 2 both merged without a /web mirror). Document the mirror as TODO; honour the playbook if the path lands during this phase, otherwise defer alongside prior phases.

---

## 3. Implementation checklist

### Step 1 — Engine helper extension

Smallest possible additive change. Foundation for the schema-write hook.

- [ ] Add `onAfterResolve?: (repo: string, collections: C[]) => Promise<void>` to `CollectionSyncConfig<C>`.
- [ ] Wire the call inside `start()` after `update({ collections })` and before the per-collection adapter loop. Errors warn-log; don't fail the sync.
- [ ] Test in `syncEngine.test.ts` (mock config with a spy on the hook).
- [ ] `npx tsc --noEmit && npx vitest run` clean.

### Step 2 — nestedManifest.ts → datastore

- [ ] Extend `EntityName` to `"fs" | "kb" | "datastore"`. Add `datastoreStateLoad` / `datastoreStateSave` to the loaders/savers maps.
- [ ] Tests in `nestedManifest.test.ts` for the datastore backend.

### Step 3 — Per-collection datastore adapter

The structural rewrite. Largest single change.

- [ ] Refactor `entities/datastore.ts` to `datastoreAdapter({ creds, collection })` (singular). `prefix: databases/<displayName>`. `manifestKey: <key>` (bare). Persistence via `nestedManifest.ts` with `"datastore"`. Drop the across-collections flatten in `listRemote`.
- [ ] Branch on `collection.isStructured` if list-items request body / response shape diverges. (Verify exact divergence by reading `firebase-helpers/functions/src/memory.controller.ts` during implementation; brief flagged this as a stage-02 unknown.)
- [ ] `entities/datastore.test.ts` covering routing, manifestKey shape, inlineContent.

### Step 4 — Datastore wrapper collapse

- [ ] Rewrite `datastoreSync.ts` as a thin `createCollectionEntitySync` wrapper. Re-export under existing names. Drop `-<orgId>` suffix from default names. `displayDatastoreName` helper. Drop the in-house cache / cooldown / inflight-resolve (orchestrator owns them).
- [ ] `pushOne` impl scoped to one collection — extract from the existing `pushAllToDatastoresImpl` per-collection inner loop. Critical safety check (`localDirExists`) preserved.
- [ ] `onAfterResolve` config hook calls `writeDatastoreSchemas(repo, collections)` — same content-equality logic, structured-only.
- [ ] Update `pushAll.ts` if datastore's status surface changes.
- [ ] `datastoreSync.test.ts` for helpers.

### Step 5 — Overview UX

- [ ] Add `databases` to `EntityKind` in `entityIcons.tsx`. Pick icon + tone + label.
- [ ] Add the new conditional station to `Workbench.tsx`'s `STATIONS` array. Wire `hasCustomDatastores` check.
- [ ] FileExplorer route for the listing view (datastore card grid). Reuse existing collection-card visual.
- [ ] Verify the existing `databases/tickets` / `databases/people` station `rel` paths actually match disk state (path mismatch flagged in investigation 1f). Fix or confirm working.
- [ ] No new tests at this layer — UI wiring exercised by manual scenarios MS-9 through MS-11.

### Step 6 — Plugin script + skill

- [ ] Update `sync-resolve-conflict.mjs` for nested datastore manifest (auto-detect, route via `databases/<name>` per-collection prefix). Legacy `datastore` prefix against nested → clean error per Phase 2 pattern.
- [ ] Add tests to `sync-resolve-conflict.test.ts`.
- [ ] Author `scripts/openit-plugin/skills/datastores.md` per the brief: file-ops first, structured-vs-unstructured behaviour, when to reach for gateway / MCP, examples.

### Step 7 — Integration tests

- [ ] `integration_tests/datastore-sync.test.ts` against the real Pinkfish API. Both flavors (structured + unstructured). Discovery, pull, push, conflict, server-delete.
- [ ] `npm run test:integration` clean.

### Step 8 — Cleanup + manual sign-off

- [ ] `npx tsc --noEmit`, `cd src-tauri && cargo build && cargo test --lib && cargo fmt --check`, `npx vitest run`, `npm run test:integration`.
- [ ] Strip debug logs.
- [ ] Diff size sanity-check — net LOC delta on `datastoreSync.ts` should be NEGATIVE (≤ 200 LOC, down from 685).
- [ ] Run MS-1..MS-12 in `npm run tauri dev` against the test org.

### Step 9 — Stop. Engineer review.

Hard stop per `auto-dev/02-impl.plan.md`. Don't roll into stage 03 (implementation) until approved.

---

## Risks

1. **Existing test orgs have legacy `openit-tickets-<orgId>` datastores.** Phase 3's filter looks for plain `openit-tickets`, so legacy ones get orphaned. V2 hasn't launched, surface area is small. PR description calls this out; users with stranded data manually rename in dashboard.

2. **Schema-write hook is the first cross-engine concern that doesn't fit the per-collection adapter shape.** Risk of bloating the orchestrator's config interface. Mitigation: scope the hook to "fires once per `start()` after resolve" — cheap, datastore-shaped, doesn't grow if other engines never need it. If a future engine wants per-collection schema-write, switch to `onCollectionAdded(collection)` instead.

3. **`<colName>/<key>` → bare `<key>` manifestKey change.** The plugin script + any consumer that joined-key parsed needs updating. Audit during stage 03 — grep for `<colName>/<key>` patterns before merging.

4. **Push impl's `localDirExists` safety check** is critical (line 481 of current datastoreSync.ts). With per-collection adapters, each adapter's `pushOne` needs to preserve this — an empty per-collection dir is "newly synced" not "user deleted everything". Tests must cover the empty-dir case.

5. **Pagination + `unreliableKeyPrefixes`.** Each per-collection adapter handles its own pagination scope. The current single-adapter version reports per-collection unreliability via the cross-cutting list. With per-collection, the orchestrator already aggregates per-adapter `paginationFailed` flags via `clearConflictsForPrefix` per prefix — same effect, simpler shape.

6. **Workbench station path mismatch** (investigation 1f). The current `rel: "databases/tickets"` may not match disk reality. Don't introduce the new tile until the existing ones are verified.

---

## Out of scope (explicit reminders)

Per the brief: agents/workflows bidirectional (Phase 4); plugin overlay revision-gating; first-bind confirm dialog; V1 → V2 folder migration; plan-limit pre-flight; auto-push on file change; push-in-poll-loop; rewriting unrelated plugin skills; custom-tile treatment for filestore + KB.

Plus from this plan's investigation:

- Migrating legacy `openit-<x>-<orgId>` datastores from existing test orgs.
- Refactoring `pushAll.ts` to surface a unified "all engines pushed" status.
- Renaming `databases/` → `datastores/` on disk (would touch every existing user folder; out of scope).
