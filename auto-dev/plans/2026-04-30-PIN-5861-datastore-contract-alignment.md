# PIN-5861: Datastore creation/upsert — contract alignment with firebase-helpers

**Ticket:** [PIN-5861](https://linear.app/pinkfish/issue/PIN-5861/datastore-creationupsert-align-with-firebase-helpers-contract)
**Date:** 2026-04-30
**Repo:** `openit-app` (primary)
**References:** `/firebase-helpers` (resource API contract — `unstructured-datastore-with-key-sortfield.md`, `structured-datastore-with-schema.md`)
**Predecessor:** PIN-5847 (filestore upload contract fix — same review pass surfaced this)

---

## 1. Technical investigation

### Current row identity model

The cloud composite key for a memory item is `(collectionId, key, sortField)` — verified in `firebase-helpers/functions/src/utils/owner.ts:117` (`createOrUpdateDataWithoutVersioning`):

- `POST /memory/items` **without** `sortField` → server stamps `Date.now().toString()` and queries `(key, that-fresh-sortField, collectionId)`. Never matches → always inserts. Two POSTs with same `key` produce two rows.
- `POST /memory/items` **with** `sortField` → queries `(key, sortField, collectionId)`. Updates if matched, inserts otherwise. **This is the only true upsert path.**
- `GET ?key=X` filters on `key` only; multi-row keys are legitimate.
- `DELETE /items/:key` without `sortField` deletes every row matching the key.

This is the contract. OpenIT's current code mishandles it in three places.

### Current OpenIT push flow (`src/lib/datastoreSync.ts`)

#### Collection create (`resolveProjectDatastoresImpl`, lines 178–375)

- POSTs to `/datacollection/` without `?ifMissing=true` (line 265).
- Wraps that with: per-org `inflightResolve` promise dedupe (lines 159, 187–193), 10s `CREATION_COOLDOWN_MS` (lines 176, 246–256, 261), 409-conflict refetch path (lines 296–301, 336–367), 5s post-create `setTimeout` before re-listing (line 338).
- All four mechanisms are client-side approximations of `?ifMissing=true`.

#### Row push (`pushAllToDatastoresImpl`, lines 461–697)

- Lines 490–503: pre-fetches the entire remote collection (`fetchDatastoreItems` → `/memory/bquery`) and builds `remoteByKey`.
- Lines 604–656: per-row, branches on `remoteByKey.has(key)`:
  - **Not on remote** → `POST /memory/items?collectionId=…` with `{ key, content }`.
  - **On remote** + content differs → `PUT /memory/items/<existing.id>?collectionId=…` with `{ content }`.
- Lines 670–696: deletion-reconcile pass uses the same `remoteByKey` to find rows to `DELETE /memory/items/id/<r.id>`.

The deletion pass legitimately needs the remote list. The push pass does not — POST-as-upsert covers new + update if `sortField` is supplied.

#### Conversations special-casing (lines 488, 510–574, 615–626)

- Walks `databases/conversations/<ticketId>/msg-*.json`.
- Pushes each row as `{ key: <msgFilename>, content: <body> }` and forces `content.ticketId = <ticketId>` so cloud-side `?ticketId=` filters work (lines 619–622).
- Deduplicates by msgFilename across all per-ticket folders (lines 564–574) — the only thing keeping us from duplicate-key collisions today, given that msgFilenames *can* repeat across tickets in principle.

The current shape flattens the on-disk hierarchy at the cloud layer. With cloud composite keys, the natural mapping is `key = ticketId`, `sortField = msgFilename` — one logical thread per `key`, ordered turns within.

### Current OpenIT pull flow (`src/lib/entities/datastore.ts`)

- `listRemote` (lines 86–171): paginates `/memory/bquery` for each collection, builds `RemoteItem`s.
- For conversations (lines 117–127), it derives subfolder from `content.ticketId` and produces `manifestKey = <colName>/<msgFilename>`, `workingTreePath = databases/conversations/<ticketId>/<msgFilename>.json`.
- `listLocal` (lines 181–217 for conversations) walks the nested layout and produces the matching `manifestKey = <colName>/<msgFilename>`.
- The engine (`syncEngine.ts`) joins local↔remote on `manifestKey`. **The current scheme will collide if two tickets ever have the same `msgFilename`.** Today's filename format `msg-<unix-ms>-<rand>` makes that very unlikely, but it's a latent bug.

After the change: `manifestKey` for conversations becomes `<colName>/<ticketId>/<msgFilename>` (collision-free) and the cloud row carries the ticket relationship in `key` (top-level), not buried in `content`.

### Manifest format implications

`datastoreStateLoad` / `datastoreStateSave` (`src/lib/api.ts` etc., flat key-value over manifestKey). Existing on-disk manifests have entries keyed `openit-conversations/<msgFilename>`. After this change, listLocal/listRemote will produce `openit-conversations/<ticketId>/<msgFilename>`. The engine's first post-upgrade pull will see all old keys as "missing locally" and all new keys as "new on remote" — risking a no-op churn (re-write same content) or, worse, a deletion fan-out if the remote list is slow.

**Mitigation:** the engine's bootstrap-adoption path (`!tracked && localFile && content matches`) handles new manifestKey schemes gracefully — local file already on disk, content equals remote → it adopts the new key without rewriting. As long as we keep the deletion-reconcile guarded (`!localDirExists` skip + `paginationFailed` skip already in place), the upgrade is safe. Verify in manual scenario 4.

### `/memory/bquery` lag (out of scope, noted)

`fetchDatastoreItems` uses `/memory/bquery`, which lags fresh writes by seconds (per `firebase-helpers/docs/unstructured-datastore-with-key-sortfield.md` § "Read items back"). Switching to `/memory/items` is a separate concern; the upsert change makes us less sensitive to lag (we no longer need a fresh read to decide POST vs PUT — POST-as-upsert just works). Out of scope for this ticket.

## 2. Proposed solution

### Approach

Three independent edits in one PR, all in datastore code:

1. **Conversations payload shape** — push with `{ key: ticketId, sortField: msgFilename, content }`. Pull joins on the (key, sortField) pair. ManifestKey for conversations becomes `<colName>/<ticketId>/<msgFilename>`.
2. **Idempotent create** — append `?ifMissing=true` to `POST /datacollection/`. Delete the cooldown / inflight / refetch machinery.
3. **POST-as-upsert** — for tickets, people, and any custom `openit-*` flat datastore, POST `{ key, sortField: key, content }` for both new and existing rows. Drop the PUT-by-id branch. Keep the pre-fetched `remoteByKey` only as input to the deletion-reconcile pass.

`sortField: key` for flat (non-conversations) datastores keeps the row identity stable across pushes. Without it, every POST stamps a fresh `Date.now()` and accumulates rows — exactly the bug we just fixed for filestore in PIN-5847.

### Files to modify

| File | Change |
| --- | --- |
| `src/lib/datastoreSync.ts` | Add `?ifMissing=true`; delete `CREATION_COOLDOWN_MS`, `lastCreationAttemptTime`, `inflightResolve`, the 5s post-create `setTimeout`, the 409-refetch branch. Switch row push to POST-as-upsert with `sortField` for both new and existing rows. Conversations push: `key=ticketId, sortField=msgFilename`, drop the `content.ticketId` injection. Keep the remoteByKey pre-fetch but use it only for the deletion-reconcile pass. |
| `src/lib/entities/datastore.ts` | `listRemote` for conversations: derive subfolder from `item.key` (not `content.ticketId`), filename from `item.sortField`. ManifestKey for conversations: `<colName>/<ticketId>/<msgFilename>`. `listLocal` for conversations: matching manifestKey shape. Drop the `extractTicketId(content)` helper (replaced by `item.key`). |
| `src/lib/skillsApi.ts` | Add `sortField?: string` to `MemoryItem` type if not already present (the bquery response has it; verify). |
| `src/lib/datastoreSync.test.ts` | Update create-body tests for `?ifMissing=true`; update push tests to assert POST (not PUT) for existing rows; new test: conversations POST shape. |
| `src/lib/entities/datastore.test.ts` | Update conversations listRemote/listLocal tests to assert new manifestKey shape and key/sortField sourcing. |
| `auto-dev/plans/2026-04-30-PIN-5861-datastore-contract-alignment.md` | This plan (already created). |

No Rust changes. No plugin-script changes. No `_schema.json` changes.

### Unit tests

**`datastoreSync.test.ts`** (additions / updates):

- `resolveProjectDatastores` calls `POST /datacollection/?ifMissing=true` for missing defaults.
- No cooldown / no `inflightResolve` symbol exported (test asserts module shape if those are testable; otherwise verified by deletion in the diff).
- Tickets / people push: existing-row update issues `POST /memory/items` (not PUT) with `{ key, sortField: key, content }`.
- Tickets / people push: re-pushing the same row is a no-op against the same remote (mocked) — body shape is identical, server upserts.
- Conversations push: row body is `{ key: <ticketId>, sortField: <msgFilename>, content: <body> }`. `content` contains no `ticketId` injection.
- Conversations push: two msgs in two different tickets do NOT trigger the duplicate-key warning (the dedupe is now keyed by `<ticketId>/<msgFilename>`, not `<msgFilename>`).
- Deletion-reconcile pass still issues `DELETE /memory/items/id/<id>` for missing locals.

**`entities/datastore.test.ts`** (updates):

- Conversations `listRemote`: a row with `key="t-123", sortField="msg-1.json"` produces `manifestKey="openit-conversations/t-123/msg-1.json"` and `workingTreePath="databases/conversations/t-123/msg-1.json"`.
- Conversations `listRemote`: a row missing `sortField` is skipped with a warning (defensive — server should always have one after the migration).
- Conversations `listLocal`: file at `databases/conversations/t-123/msg-1.json` produces `manifestKey="openit-conversations/t-123/msg-1.json"`.
- Tickets / people listRemote unchanged (flat layout; manifestKey is `<colName>/<key>` as today).

### Integration tests (write FIRST, before any production-code edit)

Real-API tests under `integration_tests/`, model after `datastore-sync.test.ts` and `upload-request-contract.test.ts` (skipped without `test-config.json`). They pin the **connect-time matrix** — local state × cloud state — that PIN-5847's filestore work showed is where row-accumulation bugs hide.

New file: **`integration_tests/datastore-connect-matrix.test.ts`**.

The matrix has four cells. Each cell is one `it()`. All cells share a small helper that resets both sides between runs (`PinkfishClient.deleteCollection` + `entityClearLocal`).

| # | Local state at connect | Cloud state at connect | What we assert |
|---|---|---|---|
| 1 | **User-authored files** (3 hand-rolled tickets, 2 people, 4 conversation turns across 2 threads) | **Fresh** (collections don't exist yet — `?ifMissing=true` mints them) | After Sync: cloud counts match local; row identity stable on a 2nd Sync (no duplicates); turns within each thread come back in filename order via `?key=<ticketId>&orderedBy=sortField`. |
| 2 | **User-authored files** (same as #1) | **Non-fresh** (collections exist, contain *different* rows: 1 ticket id `t-pre-existing`, 1 conversation thread for it) | After Sync: cloud union = local + pre-existing; engine's bootstrap-adoption pulls the pre-existing rows down to disk **without** triggering shadow-conflict (content didn't change locally); 2nd Sync is silent. |
| 3 | **Sample files** (`populate-sample-data` payload — known fixed set) | **Fresh** | After Sync: cloud rows = sample set, no duplicates; re-running `populate-sample-data` followed by Sync stays at the same row count (confirms POST-as-upsert is idempotent for sample keys). |
| 4 | **Sample files** | **Non-fresh** (collections already contain the sample set from a prior session — same keys, same content) | After Sync: zero writes (silent); cloud row count unchanged; conversation turns still ordered correctly. This is the "user reconnects after closing the app" case — must not duplicate. |

Plus two cross-cutting tests in the same file:

5. **Concurrent first-connect (`?ifMissing=true`).** Two parallel `resolveProjectDatastores` calls against the same fresh org. Both must return identical collection ids; cloud must end with one collection per name (not two). Smoke-tests the deleted-cooldown machinery doesn't regress race-safety.
6. **Conversation collision-free manifest.** Two threads contain a turn with the *same filename* (e.g. both have `msg-1730000000000-aaaa.json`). After Sync, both rows exist on cloud distinguished by `key`; pull-back writes both files to their correct per-ticket folder; no warning fires. (Today's code rejects one as duplicate — the new manifestKey shape fixes this.)

These tests must be **written and verified to fail (or pass-with-bug)** against current `main` before Step 1's production edits begin. That's how we lock in that the behavior changes are real.

#### Test infrastructure additions

- `integration_tests/utils/pinkfish-api.ts`: add `postMemoryItem({ collectionId, key, sortField, content })`, `listMemoryItems({ collectionId, key?, orderedBy? })`, `deleteMemoryItemsForCollection(collectionId)` (cleanup helper).
- `integration_tests/utils/local-fixture.ts` (new): builds the four local states on disk under a temp repo dir — `seedUserFiles(dir)`, `seedSampleFiles(dir)`, `clearAll(dir)`. Mirrors what `populate-sample-data` writes, sourced from `scripts/openit-plugin/seed/`.
- `integration_tests/utils/cloud-fixture.ts` (new): cloud-side state builders — `ensureFreshCollections(client, names)` (delete + recreate empty), `seedNonFreshCollection(client, name, items)`.

### Manual scenarios

1. **Clean-slate create + sync.** Clean slate → connect to cloud → populate sample data → Sync. Expect 3 tickets, 5 people, all conversation turns in cloud collections (verify in Pinkfish UI). No duplicates. No 409s in console.
2. **Repeat sync is a no-op.** Hit Sync again with no local changes. Expect zero writes in the log. Cloud row counts unchanged.
3. **Edit one row, sync, verify upsert.** Edit a ticket field on disk, Sync. Verify cloud row updates in place (not a new row).
4. **Manifest upgrade.** On a repo that has the *old* manifest format (snapshot before this PR's first run), launch the post-PR build, hit Sync. Expect: bootstrap-adoption rewrites manifestKey shape silently, no churn writes, no remote deletes.
5. **Conversation thread ordering on cloud.** After scenario 1, hit `GET /memory/items?collectionId=<conv-id>&key=<ticketId>&orderedBy=sortField` (curl with stage token). Expect the thread's turns in filename order.

## 3. Implementation checklist

### Step 1 — Integration tests first

Lock the contract before touching production code. Each cell of the matrix is one failing (or pass-with-bug) test against current `main`.

- [ ] Add `integration_tests/utils/local-fixture.ts` (seed user-files / sample-files / clear).
- [ ] Add `integration_tests/utils/cloud-fixture.ts` (fresh / non-fresh collection state).
- [ ] Extend `integration_tests/utils/pinkfish-api.ts` with `postMemoryItem`, `listMemoryItems`, cleanup helper.
- [ ] Add `integration_tests/datastore-connect-matrix.test.ts` covering matrix cells 1–4 + cross-cutting 5 (concurrent first-connect) and 6 (conversation collision-free manifest).
- [ ] Run the suite against `main`. Document which cells fail and how (these are the bugs the rest of the work fixes).

### Step 2 — Idempotent create

Smallest, lowest-risk production edit; gets cleanup out of the way first.

- [ ] Append `?ifMissing=true` to the `POST /datacollection/` URL in `resolveProjectDatastoresImpl` (`datastoreSync.ts`).
- [ ] Delete `CREATION_COOLDOWN_MS`, `lastCreationAttemptTime`, `getLastCreationTime`, `setLastCreationTime`, `inflightResolve`, the 5s post-create `setTimeout`, and the 409-conflict-refetch branch.
- [ ] Update `datastoreSync.test.ts` create-body tests.
- [ ] Re-run integration suite; cell 5 (concurrent first-connect) should now pass.

### Step 3 — POST-as-upsert for flat datastores

- [ ] In `pushAllToDatastoresImpl`, replace the POST-vs-PUT branch with a single `POST /memory/items?collectionId=…` body `{ key, sortField: key, content }` for tickets, people, custom flat datastores.
- [ ] Keep `remoteByKey` pre-fetch (still needed for the deletion-reconcile pass).
- [ ] Update `jsonEqual` skip path: still skip the POST when remote content matches local — saves a network round-trip and a server-side write timestamp bump.
- [ ] Update `datastoreSync.test.ts`.
- [ ] Re-run integration suite; cells 1–4 should now pass for tickets/people. Conversations cells still fail until Step 4.

### Step 4 — Conversations: key + sortField

- [ ] Push side (`datastoreSync.ts`): for conversations, POST body is `{ key: <ticketId>, sortField: <msgFilename>, content: <parsed-body> }`. Drop the `obj.ticketId = ticketId` injection.
- [ ] Push side: change duplicate-detection map from msgFilename-keyed to `<ticketId>/<msgFilename>`-keyed; update the warning message.
- [ ] Pull side (`entities/datastore.ts` `listRemote`): for conversations, subfolder = `item.key`, filename = `item.sortField`. Skip rows missing either with a warning.
- [ ] Pull side: manifestKey for conversations = `<colName>/<ticketId>/<msgFilename>`.
- [ ] `listLocal` for conversations: same manifestKey shape from the on-disk path.
- [ ] Drop `extractTicketId` helper (no longer used).
- [ ] Add `sortField?: string` to `MemoryItem` type if missing.
- [ ] Update `entities/datastore.test.ts`.
- [ ] Re-run integration suite; cells 1–4 (conversations rows) and cell 6 (collision-free manifest) should now pass. **All six cells green** is the gate.

### Step 5 — Manual sign-off

- [ ] Scenario 1 — clean-slate sync produces expected counts, no duplicates.
- [ ] Scenario 2 — repeat sync is silent.
- [ ] Scenario 3 — edited row upserts in place.
- [ ] Scenario 4 — manifest upgrade is silent (no churn writes, no deletes).
- [ ] Scenario 5 — `?key=&orderedBy=sortField` returns the thread in order.

### Step 6 — Plan-required follow-ups

- [ ] Linear comment on PIN-5861 with plan link + headline.
- [ ] Open a follow-up ticket for the `/memory/bquery` → `/memory/items` switch (lag concern, not in scope here).

---

## Stop. Awaiting engineer review and approval before stage 03.
