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

### 1e. Naming convention — `openit-` prefix on the cloud, stripped locally

The convention across all entities:

- **Cloud:** every OpenIT-managed collection carries the `openit-` prefix. The discovery filter uses this prefix to ignore unrelated user collections that happen to share a Pinkfish account.
- **Local:** the prefix is stripped for the on-disk folder name, so users see clean paths.

Already the case for filestore (`openit-library` ↔ `filestores/library/`) and KB (`openit-default` ↔ `knowledge-bases/default/`). Phase 3 normalises datastore onto the same convention:

| Cloud (REST) | Local (disk) |
|---|---|
| `openit-tickets` | `databases/tickets/` |
| `openit-people` | `databases/people/` |
| `openit-projects` (custom) | `databases/projects/` |

Today datastore uses `openit-tickets-<orgId>` on the cloud and `databases/openit-tickets-<orgId>/` locally — both wrong under the new convention. Phase 3 fixes both. Test orgs with the legacy names see them as orphans on the cloud side and ignored on the local side; per engineer direction, this is brand-new code so no migration.

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

`rel` here points at on-disk paths — already the correct unprefixed shape (`databases/tickets`, `databases/people`) under Phase 3's strip-prefix-locally convention. Phase 3's datastore rewrite makes the rest of the codebase match this expectation.

Phase 3 inserts a conditional `databases` station after `people`:

```ts
{ id: "databases", kind: "databases", rel: "databases", countMode: "dirs",
  /* new property */ visibleIf: (state) => hasCustomDatastores(state) },
```

`hasCustomDatastores` checks the FileExplorer's `datastores` state for any entry whose name (post-strip) doesn't match `tickets` or `people`.

**FileExplorer regex update.** `FileExplorer.tsx:85` currently matches `^databases/openit-[^/]+$` — the legacy prefixed-on-disk path. Phase 3 updates this regex to `^databases/[^/]+$` excluding system folders (`conversations`, future siblings) so the unprefixed path matches the per-collection card view.

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

Four coupled pieces:

1. **Engine helper** — extend `createCollectionEntitySync` with two new optional config hooks. Both unused by filestore + KB (they keep their existing simple-defaults behaviour); datastore supplies both:
   - `onAfterResolve(repo, collections)` — fires once per `start()` after auto-create + re-resolve, before the per-collection pull loop. Datastore uses this for the structured-only `_schema.json` write.
   - `discoverLocalCollections({ repo, existingNames }) → Promise<{name, isStructured?, schema?}[]>` — datastore returns names of local `databases/<foldername>/` subdirs not yet on cloud. The orchestrator's auto-create loop POSTs each one alongside the hardcoded defaults.
   - `buildCreateBody(name, opts) → object` — engine-specific POST body shape. Datastore returns `{ name, type: "datastore", isStructured, schema?, templateId?, ... }`; filestore + KB keep their default body shape via the existing `describeDefault` mechanism.

2. **Datastore engine** — refactor for per-collection adapter shape, plug into `createCollectionEntitySync`, drop the org-suffix from default names, add `nestedManifest.ts` support for `"datastore"` entity name, branch on `isStructured` where the API surfaces diverge (push body shape, list-items request).

3. **Local-folder-driven creation.** When a user drops a new folder into `databases/<foldername>/` (manually or via Claude in the terminal), on next connect (or 60s poll if we wire it in) the orchestrator auto-creates `openit-<foldername>` on cloud. **If the local folder contains a `_schema.json`, the cloud datastore is created STRUCTURED with that schema.** Otherwise, UNSTRUCTURED (freeform JSON rows). Conversations (`databases/conversations/`) is excluded — it's a local-only system folder and never gets mirrored to cloud.

4. **Push-time schema validation for structured datastores.** Before POSTing a row to the cloud, read the local `_schema.json` and validate the row's JSON against it. If the row is invalid (missing required field, wrong type, value not in `select` options), block the push for that row and surface the error inline in the sync log: `✗ databases/tickets/CS123.json — required field "status" missing`. The server would reject anyway; doing it locally catches the mistake earlier with a clearer message. Unstructured datastores skip validation. Validation is required-fields + type-match (string / number / boolean / date / select) — a small ~50-LOC validator against the existing `CollectionSchema` shape in `skillsApi.ts`. Extra fields not in the schema warn-log but don't block (server accepts in some cases; let it decide).

5. **Bidirectional schema sync.** Today schema is read-only on local — `writeDatastoreSchemas` writes `_schema.json` from cloud → local on every connect. Phase 3 makes it bidirectional: when the user edits `_schema.json` locally (directly or via Claude in the terminal), the change pushes back to cloud via `PUT /datacollection/:collectionId/schema`.

   **REST contract (verified against skills-stage):**

   ```
   PUT https://skills-stage.pinkfish.ai/datacollection/{collectionId}/schema
   auth-token: Bearer <accessToken>
   content-type: application/json

   { "schema": { "fields": [...], "nextFieldId": N, "sortConfig": {...} } }
   ```

   The body wraps the schema in a `{ schema: ... }` envelope (NOT a bare schema object). Response is `{ message: "Schema updated successfully", schema: <updated schema> }`. Routes through `makeSkillsFetch` (already uses the `Auth-Token: Bearer` header convention).

   **Mechanics:**
   - The manifest's per-collection bucket tracks the schema like any other file: `manifest[collectionId].files["_schema.json"] = { remote_version, pulled_at_mtime_ms }`.
   - On pull (existing path): write `_schema.json`, record its mtime + a content hash as `remote_version`.
   - On push: detect drift the same way row pushes do (`mtime > pulled_at_mtime_ms` or content differs). If `_schema.json` is dirty, send `PUT /datacollection/{id}/schema` with the parsed schema wrapped in `{ schema }` BEFORE pushing rows (so a row push that depends on a new field doesn't fail).
   - Server-side validation owns the policy (e.g. "can't remove a required field while rows exist without that field" — server rejects with a clear error). Local code surfaces the error in the sync log and does NOT push rows for that collection that cycle (don't compound the failure).
   - Conflict case (both sides edited schema between polls): last-writer-wins on push. Schema changes are infrequent + usually single-author, so no shadow-file flow yet. If this becomes a real problem, add proper conflict detection in a later phase.

6. **Overview UX** — conditional `databases` Workbench station + listing view that reuses the existing FileExplorer collection-card pattern.

### Files to modify

| File | Change |
| --- | --- |
| `src/lib/syncEngine.ts` | Add three optional fields to `CollectionSyncConfig<C>`: (1) `onAfterResolve?: (repo, collections) => Promise<void>` — fires once after resolve, before pull loop; errors warn-log. (2) `discoverLocalCollections?: ({ repo, existingNames }) => Promise<DiscoveredCollection[]>` — wrapper-supplied filesystem scan; the orchestrator auto-creates each returned entry. (3) `buildCreateBody?: (name, discovery?) => Record<string, unknown>` — engine-specific POST body for auto-create; if absent, fall back to the current default-body shape. Wire all three into the existing `autoCreateDefaultsIfMissing` loop. Filestore + KB don't supply these — behaviour unchanged for them. |
| `src/lib/nestedManifest.ts` | Extend `EntityName` from `"fs" | "kb"` to `"fs" | "kb" | "datastore"`. Add `datastoreStateLoad` / `datastoreStateSave` to the loaders/savers maps. Existing legacy-flat-format detection migrates the old datastore manifest forward (bucket discarded — fresh state on first sync, same as Phase 2 KB). |
| `src/lib/entities/datastore.ts` | Refactor to **per-collection** adapter: `datastoreAdapter({ creds, collection })` (singular). Compute `displayName = collection.name.replace(/^openit-/, "")` once. `prefix: \`databases/<displayName>\`` per filestore/KB pattern. `manifestKey` simplifies to `<key>` (was `<colName>/<key>`). `workingTreePath: \`databases/<displayName>/<key>.json\`` — local strips the prefix. `listRemote` paginates ONE collection (drops the across-collections flatten). `listLocal` reads `databases/<displayName>/`. `onServerDelete` doesn't need to parse the slash anymore. Persistence via `loadCollectionManifest(repo, "datastore", collection.id)` / `saveCollectionManifest`. The `unreliableKeyPrefixes` mechanic moves to per-adapter (each adapter reports its own unreliability via `paginationFailed: true`). |
| `src/lib/datastoreSync.ts` | Collapse to ~200 LOC. Define the `CollectionSyncConfig<DataCollection>`, supply `pushOne` (per-collection upload — existing full-reconcile logic scoped to one collection, with `localDirExists` safety check preserved), supply `onAfterResolve` (`writeDatastoreSchemas(repo, collections)`), supply `discoverLocalCollections` (scan `databases/`, skip `conversations` + system folders, for each subdir read optional `_schema.json` to determine structured-vs-unstructured), supply `buildCreateBody` (builds `{ name, type: "datastore", isStructured, schema?, templateId?, description, createdBy, createdByName }` — `isStructured: true` + `templateId` for hardcoded defaults, `isStructured` from local-folder discovery for the rest). Default names: plain `openit-tickets` and `openit-people`. Drop in-house `inflightResolve` / `lastCreationAttemptTime` / `createdCollections` caches (orchestrator owns them). `displayDatastoreName(name)` strips `openit-`. Keep export surface (`resolveProjectDatastores`, `pullDatastoresOnce`, `pushAllToDatastores`, `startDatastoreSync`, `stopDatastoreSync`) so Shell.tsx / pushAll.ts compile unchanged. Status type `DatastoreSyncStatus = CollectionSyncStatus<DataCollection>`. |
| `src/lib/api.ts` | Confirm `datastoreStateLoad` / `datastoreStateSave` exist (they should — they were added during R2). No new wrappers. |
| `src/lib/pushAll.ts` | Update if datastore's status surface changes (`getDatastoreSyncStatus` becomes available, replacing the side-channel through `pullDatastoresOnce`). Likely a small simplification. |
| `src/shell/Workbench.tsx` | Add new `databases` station entry after `people`. Wire conditional visibility based on whether any non-default `openit-*` datastore is present. Reuse existing station-rendering machinery. |
| `src/shell/entityIcons.tsx` | Add `databases` to `EntityKind`; pick icon + tone + label. |
| `src/shell/FileExplorer.tsx` | (a) Update the legacy `databases/openit-[^/]+$` regex to match the new unprefixed local path (`databases/[^/]+$` with system-folder exclusions for `conversations`). (b) Add a "datastores listing" route — when the user clicks the new Workbench tile, FileExplorer renders a card grid of every `openit-*` datastore. Each card shows the unprefixed display name + row count + last-sync timestamp + click-through to `databases/<displayName>/`. Reuse existing collection-card visual. |
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

- **MS-1.** Fresh connect with no datastores on cloud → orchestrator auto-creates `openit-tickets` + `openit-people` (both structured). Local `databases/tickets/_schema.json` and `databases/people/_schema.json` written.
- **MS-2.** Edit a row file `databases/tickets/<key>.json` locally → next poll pushes. Verify on dashboard.
- **MS-3.** Create a row on dashboard → next poll pulls down to `databases/tickets/<key>.json`.
- **MS-4.** Both sides edit the same row → `.server.json` shadow lands; conflict bubble names the right path; resolve script clears.
- **MS-5.** Delete a row on dashboard → next poll removes the local file.
- **MS-6.** Create an UNSTRUCTURED datastore `openit-notes` on the dashboard → next poll pulls it down to `databases/notes/`. NO `_schema.json` written. Row round-trip works.
- **MS-6a.** **Local-folder-driven UNSTRUCTURED creation.** `mkdir databases/projects && echo '{"name":"alpha"}' > databases/projects/alpha.json`. Reconnect (or wait for next discovery). Verify: `openit-projects` now exists on the dashboard as an unstructured datastore. The local file pushed up.
- **MS-6b.** **Local-folder-driven STRUCTURED creation.** `mkdir databases/contracts`, write a valid `_schema.json` inside, then add a row JSON. Reconnect. Verify: `openit-contracts` now exists on the dashboard as a STRUCTURED datastore with the schema from the local file. The local row pushed up. Future dashboard edits to schema flow back via the existing `_schema.json` write path.
- **MS-6c.** **`databases/conversations/` is NOT mirrored** — the system folder is excluded from `discoverLocalCollections`. No `openit-conversations` is created on the cloud.
- **MS-7.** Delete a row file locally, commit → push DELETE-by-id removes the row from the cloud.
- **MS-7a.** **Local schema edit pushes back.** Edit `databases/tickets/_schema.json` (e.g. add a new `priority` field with type `string`). Commit. Verify: dashboard shows the new field on the `openit-tickets` collection. Subsequent rows can use the new field.
- **MS-7b.** **Cloud schema edit pulls down.** Add a field via the dashboard. Next poll rewrites local `_schema.json` to match. Subsequent local row writes can use the new field; push-time validation enforces it.
- **MS-7c.** **Schema validation blocks bad rows on push.** Write a row file `databases/tickets/<key>.json` missing a required field. Commit. Sync log shows `✗ databases/tickets/<key>.json — required field "<name>" missing`; the row is NOT pushed; sibling valid rows still push fine.
- **MS-7d.** **Server rejects schema change with existing-row violation.** Edit `_schema.json` to add a required field that existing rows don't have. Commit. Sync log surfaces server's rejection: `✗ datastore: schema push (tickets) failed — <server message>`. Existing rows in that collection are NOT pushed for this cycle (don't compound). User reverts the schema or fills the missing fields, then retries.
- **MS-8.** Cloud has an unrelated non-`openit-` datastore (e.g. `customer-feedback`) → not pulled, not modified, not visible in OpenIT UI.
- **MS-9.** Workbench overview with only `openit-tickets` + `openit-people` shows the 2 default tiles, NO "Databases" tile.
- **MS-10.** Workbench overview after creating `openit-projects` on the dashboard → shows the 2 default tiles AND the new "Databases" tile. Click → listing view renders 3 cards. Click a card → opens FileExplorer at `databases/projects/`.
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

Three additive config hooks. Filestore + KB don't supply them — behaviour unchanged for those engines.

- [ ] Add `onAfterResolve?` (post-resolve hook), `discoverLocalCollections?` (filesystem-driven discovery), `buildCreateBody?` (engine-specific POST body) to `CollectionSyncConfig<C>`.
- [ ] Extend `autoCreateDefaultsIfMissing` to merge `defaultNames` + `discoverLocalCollections()` results, dedupe against existing cloud names, POST each via `buildCreateBody` (or fall back to the current default body shape).
- [ ] Tests in `syncEngine.test.ts`: each hook fires; filestore + KB configs without the hooks behave identically to today.
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
- [ ] `pushOne` impl scoped to one collection — extract from the existing `pushAllToDatastoresImpl` per-collection inner loop. Critical safety check (`localDirExists`) preserved. Branch on `isStructured` if the push body shape diverges (verify against `firebase-helpers/functions/src/memory.controller.ts` during implementation). **Schema-push first**: if `_schema.json` for this collection is dirty, `PUT /datacollection/{id}/schema` BEFORE row pushes; on server rejection, log + skip row pushes for this collection this cycle. **Schema validation**: for each row, validate against `_schema.json` (required fields + type-match); skip + log invalid rows.
- [ ] `onAfterResolve` config hook calls `writeDatastoreSchemas(repo, collections)` — content-equality logic, structured-only. Updates the manifest's `_schema.json` entry with the new content hash + mtime so the next push can detect drift.
- [ ] New `src/lib/datastoreSchema.ts` module: `validateRow(row, schema): { ok: true } | { ok: false, errors: string[] }`. ~50 LOC. Tests in `datastoreSchema.test.ts`.
- [ ] `discoverLocalCollections` config hook scans `${repo}/databases/`, skips `conversations` and any future system folders, for each subdir: read optional `_schema.json` to set `isStructured` + `schema`. Returns `{ name: "openit-<foldername>", isStructured, schema? }[]`.
- [ ] `buildCreateBody` config hook returns datastore-specific POST body. For hardcoded defaults: `{ name, type: "datastore", isStructured: true, templateId: "case-management" | "contacts", description, createdBy, createdByName }`. For local-discovered: `{ name, type: "datastore", isStructured, schema?, description, createdBy, createdByName }`.
- [ ] Update `pushAll.ts` if datastore's status surface changes.
- [ ] `datastoreSync.test.ts` for helpers + the discoverLocalCollections logic (mock filesystem, verify structured/unstructured branching on `_schema.json` presence).

### Step 5 — Overview UX

- [ ] Add `databases` to `EntityKind` in `entityIcons.tsx`. Pick icon + tone + label.
- [ ] Add the new conditional station to `Workbench.tsx`'s `STATIONS` array. Wire `hasCustomDatastores` check.
- [ ] FileExplorer route for the listing view (datastore card grid). Reuse existing collection-card visual.
- [ ] Verify the existing `databases/tickets` / `databases/people` station `rel` paths actually match disk state (path mismatch flagged in investigation 1f). Fix or confirm working.
- [ ] Update `FileExplorer.tsx` regex `/^databases/openit-[^/]+$/` → `/^databases/[^/]+$/` (with `conversations` system-folder exclusion) so the unprefixed local path matches.
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

1. **Schema-write hook is the first cross-engine concern that doesn't fit the per-collection adapter shape.** Risk of bloating the orchestrator's config interface. Mitigation: scope the hook to "fires once per `start()` after resolve" — cheap, datastore-shaped, doesn't grow if other engines never need it. If a future engine wants per-collection schema-write, switch to `onCollectionAdded(collection)` instead.

2. **`<colName>/<key>` → bare `<key>` manifestKey change.** The plugin script + any consumer that joined-key parsed needs updating. Audit during stage 03 — grep for `<colName>/<key>` patterns before merging.

3. **Push impl's `localDirExists` safety check** is critical (line 481 of current datastoreSync.ts). With per-collection adapters, each adapter's `pushOne` needs to preserve this — an empty per-collection dir is "newly synced" not "user deleted everything". Tests must cover the empty-dir case.

4. **Pagination + `unreliableKeyPrefixes`.** Each per-collection adapter handles its own pagination scope. The current single-adapter version reports per-collection unreliability via the cross-cutting list. With per-collection, the orchestrator already aggregates per-adapter `paginationFailed` flags via `clearConflictsForPrefix` per prefix — same effect, simpler shape.

5. **FileExplorer regex update reach.** Changing `databases/openit-[^/]+$` → `databases/[^/]+$` means a system-folder exclusion list is needed (today only `conversations` lives at `databases/conversations/`, but any future sibling system folder would also need to be excluded). Stage-03 audit: grep for every regex / path-prefix check involving `databases/openit-` and update consistently.

6. **Local-folder-driven creation latency.** The discovery currently runs only on `start()` — i.e. on connect / app reload. A user creating `databases/foo/` while sync is already running won't see `openit-foo` on cloud until next reconnect. If wiring discovery into the 60s poll proves easy, do it; if it complicates the polling code, ship the connect-time-only behaviour and document the limitation. The OpenIT terminal user is unlikely to hit this — Claude tends to create folders within a single session that ends with a reconnect.

7. **Race between local-folder creation and existing cloud collection.** A user creates `databases/foo/` locally; meanwhile someone created `openit-foo` on the dashboard. On next discovery, the local scan returns `foo` as a candidate but the existing-names check (which the orchestrator does inside the auto-create loop) skips it — no duplicate creation. Local rows in the folder push up via the regular sync once the cloud entry is found. Verify in stage 03 that the existing-names dedup happens BEFORE the POST.

---

## Out of scope (explicit reminders)

Per the brief: agents/workflows bidirectional (Phase 4); plugin overlay revision-gating; first-bind confirm dialog; V1 → V2 folder migration; plan-limit pre-flight; auto-push on file change; push-in-poll-loop; rewriting unrelated plugin skills; custom-tile treatment for filestore + KB.

Plus from this plan's investigation:

- Refactoring `pushAll.ts` to surface a unified "all engines pushed" status.
- Renaming `databases/` → `datastores/` on disk (would touch every existing user folder; out of scope).
- Migrating legacy `openit-<x>-<orgId>` datastores from existing test orgs — engineer confirmed brand-new code, no migration needed.
- **CSV import path** (`POST /datacollection/{id}/import-csv`). Useful for bulk-loading a fresh datastore from a CSV, but bypasses the per-row sync semantics (conflict detection, `pulled_at_mtime_ms`, `.server.json` shadows). Phase 3's per-row JSON path round-trips correctly for the typical OpenIT shape (tens-to-hundreds of rows per datastore, mostly single-author edits). If bulk-load perf becomes a real problem on large datastores, file a separate ticket — likely a UX entry point ("Import this CSV into a new datastore") distinct from the sync hot path.

---

## BugBot Review Log

### Iteration 1 (2026-04-29)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | Post-push manifest save clobbers nested per-collection state | **High** | Fixed | `426d31d` — push impl was using raw `datastoreStateLoad/Save` (deserialised nested file as flat KbState with empty `files`); post-push save then overwrote the entire nested manifest with a flat one, destroying every other collection's bucket. Switched to `loadCollectionManifest("datastore", collection.id)` / `saveCollectionManifest(...)` — same pattern filestore + KB use. Per-(repo, entity) lock + bucket merge preserves siblings. |
| 2 | Discovery scans recursively, creating spurious cloud collections | Medium | Fixed | `39e6bca` — `discoverLocalDatastores` called `fsList(databasesPath)` which walks depth-6 recursively. A nested dir like `databases/tickets/archived/` would pass the system-folder + existing-names checks and get auto-created on the cloud as `openit-archived`. Filtered to direct children only via the same shape Workbench.tsx uses. |
| 3 | Pull count always returns zero, suppressing log messages | Low | Fixed | `4bea849` — `pullAllNow` now returns aggregate `{ pulled, total }` across every collection (`runPullWithAdapter` already returned per-collection counts; just sum them). `pullDatastoresOnce` captures and surfaces the real value; the `pulled > 0` log branch in pushAll.ts is no longer dead code. Filestore + KB wrappers benefit too if they wire it up. |
| 4 | Empty collection name produces confusing conflict messages | Low | Fixed | `8965f85` — extended `CollectionConflictFile` with `collectionId` (the orchestrator's `recordConflictsFor` already had it as an arg). `pullDatastoresOnce` builds an id→displayName lookup from `status.collections` and hydrates each conflict's `collectionName`. pushAll.ts now renders `tickets/CS123.json: reason` instead of `/CS123.json: reason`. |

### Iteration 2 (2026-04-29)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | (none — clean run) | — | — | "✅ Bugbot reviewed your changes and found no new issues!" — review of commit `b26e0d0`. CI green: frontend, rust, Cursor Bugbot all passing. All four iter-1 threads resolved. |

**BugBot loop exit:** clean run achieved at iteration 2. Phase 3 implementation is code-complete. Manual MS-1 through MS-12 (per the brief) remain the gating step before merge — see PR description.
