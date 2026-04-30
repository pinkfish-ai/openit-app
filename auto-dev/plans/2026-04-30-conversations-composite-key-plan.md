# Conversations sync — composite (key, sortField) — Implementation plan

**Ticket:** TBD (brief drafted; Linear ticket pending)
**Date:** 2026-04-30
**Repo:** `openit-app` (primary)
**References:** `/firebase-helpers` (`MemoryCreateItemRequest`, `MemoryItem`, `memory.controller.ts`, `utils/owner.ts`)
**Predecessor:** PIN-5793 (datastore + seed flow rewrite)

---

## 1. Technical investigation

### Current state on `main`

- **`MemoryItem` type lacks `sortField`** (`src/lib/skillsApi.ts:33-39`). Cloud's read model has it as required (`firebase-helpers/spec/.../MemoryItem.ts:67, 162`). Asymmetric — we throw away half the row's primary key on every read.
- **Push body sends `{ key, content }` only** (`src/lib/datastoreSync.ts:633-637` for POST and `:645-650` for PUT). Cloud falls into the "no sortField + no sortConfig" branch in `firebase-helpers/functions/src/utils/owner.ts:174-176, 308-311` and stamps `sortField = Date.now().toString()`. That's the `1777559287792` in the dashboard screenshot.
- **Pull derives subdir from `content.ticketId`** (`src/lib/entities/datastore.ts:58-65, 117-131`). Rows with no `content.ticketId` are dropped with a `console.warn` — invisible to UI.
- **Push mutates `content.ticketId` to match folder name** in memory before POST/PUT (`src/lib/datastoreSync.ts:619-622`). Local file stays stale; pull self-heals on the next round.
- **Push detects cross-ticket duplicate `msgId`** with first-writer-wins + `console.warn` (`src/lib/datastoreSync.ts:563-573`). Bundled seed avoids it; admin copy-paste collides silently.
- **Adapter `manifestKey` is `${colName}/${key}`** (`src/lib/entities/datastore.ts:48-50`). Two tickets with the same `msgId` collide in the engine's manifest too — same root cause, different surface.

### Cloud contract — confirmed in firebase-helpers

(Verified during stage 01; recorded in `DRAFT-conversations-composite-key-brief.md` § "Cloud contract — confirmed".)

- POST `/memory/items` accepts `{ key, sortField?, content, ... }` (`MemoryCreateItemRequest.ts:60`).
- POST upserts on the composite `(key, sortField)` (`owner.ts:204-217`). Same `sortField` across different keys → distinct rows.
- GET `/memory/items` accepts `?key=<x>&sortField=<y>` filters (`memory.controller.ts:637-646`).
- DELETE `/memory/items/:key?sortField=<x>` deletes a single composite row (`memory.controller.ts:533-562`).
- PUT-by-id overwrites `sortField` (`owner.ts:158, 333`) but **excludes `key`** from update (destructured at `owner.ts:124`). Existing rows keyed by `msgId` need DELETE-then-POST to migrate; PUT alone won't move them.

## 2. Proposed solution

**Approach.** For `openit-conversations`: cloud row is `{ key: ticketId, sortField: msgId, content }`. The on-disk `databases/conversations/<ticketId>/<msgId>.json` maps 1:1 onto the composite. Routing becomes an addressing fact — `extractTicketId`, the missing-ticketId drop, the dup-msgId warn-and-skip, and the push-time `content.ticketId` injection all retire.

For all *other* `openit-*` collections (tickets, people, custom unstructured): send `sortField = key`. Cloud stops auto-stamping. One uniform rule across collections.

### Files to modify

| File | Change |
| --- | --- |
| `src/lib/skillsApi.ts` | Add `sortField: string` to `MemoryItem`. |
| `src/lib/datastoreSync.ts` | (a) Push body for `openit-conversations`: `{ key: <folderName>, sortField: <fileBaseName>, content }`. (b) Push body for every other `openit-*`: `{ key, sortField: key, content }`. (c) Drop the duplicate-msgId detection block (lines 563-573) and the `content.ticketId` injection block (lines 619-622) — both go dead. (d) PUT body sends `sortField` so the row's sortField is restored on update (in case anything else clobbered it). |
| `src/lib/entities/datastore.ts` | (a) `listRemote` for `openit-conversations`: derive `subdir = ${localSubdirFor(col.name)}/${row.key}`, `filename = ${row.sortField}.json`. Drop `extractTicketId` + the missing-ticketId warn-and-continue. (b) `manifestKey` for conversations becomes `${col.name}/${row.key}/${row.sortField}` so cross-ticket `msgId` reuse doesn't collide in the manifest. Other collections' manifestKey is unchanged (`${col.name}/${row.key}`). |
| `integration_tests/utils/pinkfish-api.ts` | (Already done in this worktree.) `postDatastoreRow` accepts optional `sortField`; `listDatastoreItems` takes `{ limit?, key? }`; new `deleteDatastoreRowByCompositeKey`. |
| `integration_tests/conversations-composite-key.test.ts` | (Already done.) Six scenarios proving the cloud contract — round-trip, cross-ticket coexistence, auto-stamp documentation, `?key=` filter, content-without-ticketId, composite delete. |
| `integration_tests/datastore-sync.test.ts` | Update `postDatastoreRow` call sites to pass `sortField` where the test now expects composite-keyed rows. The "merge / no-clobber" scenario gets a new sub-case: same `msgId` across two ticket folders pushes as two distinct cloud rows. |

### Unit tests

| File | Test |
| --- | --- |
| `src/lib/entities/datastore.test.ts` | (a) Conversations `listRemote`: row `{ key:"T1", sortField:"msg-X" }` → `workingTreePath: "databases/conversations/T1/msg-X.json"`, `manifestKey: "openit-conversations/T1/msg-X"`. (b) Same `sortField` across `T1` / `T2` produces two distinct items. (c) Row with no `content.ticketId` still routes via `key` — no drop. (d) Empty `sortField` warn-skips. (e) `listLocal` emits composite manifestKey for nested files. (f) Two folders sharing `msg-X.json` produce two distinct local items. |

Push body shape is exercised end-to-end by the integration test (`conversations-composite-key.test.ts` + `datastore-sync.test.ts`). Per project convention (`filestoreSync.test.ts:1-7`, `kb.test.ts:5-7`) we skip mocked unit tests for the networked orchestrator — they mostly assert on the mock. The integration test covers the wire shape against a real cloud, which is the contract that matters.

### Manual scenarios

1. **Round-trip with two folders, same msgId.** Wipe local + cloud, create two ticket folders `T1/msg-X.json` and `T2/msg-X.json` with distinct bodies, push, verify two distinct cloud rows in the dashboard with composite keys, delete one of them on cloud, pull, verify the other survives locally.
2. **One round-trip on tickets/people.** Confirm `sortField = key` on cloud rows after push. Check the dashboard.

(No migration scenario — V2 hasn't launched, no production data; pre-existing dev rows get nuked on reconnect.)

### Cross-repo plugin steps

This change does NOT touch `scripts/openit-plugin/` — purely client-side wire shape. No `/web` mirror needed. No manifest version bump.

## 3. Implementation checklist

### Step 1 — Type surface

- [x] Add `sortField: string` to `MemoryItem` (`src/lib/skillsApi.ts`).

### Step 2 — Push (conversations + uniform sortField)

- [x] Update `pushAllToDatastoresImpl` POST/PUT bodies: conversations sends composite from folder/file; other openit-* sends `sortField = key`.
- [x] Drop the dup-msgId detection block.
- [x] Drop the `content.ticketId` mutation block.
- [x] Update post-push manifest reconcile to track `${key}::${sortField}` composites.

### Step 3 — Pull (conversations adapter)

- [x] `entities/datastore.ts::listRemote` for conversations: route via `(row.key, row.sortField)`. Drop `extractTicketId` + the missing-ticketId continue.
- [x] Conversations `manifestKey` → `${col.name}/${row.key}/${row.sortField}`.
- [x] `listLocal` for conversations: emit composite manifestKey so local entries match the cloud rows.

### Step 4 — Tests

- [x] Unit: rewrite `entities/datastore.test.ts` for composite (7 tests, all green).
- [ ] Integration: `npm run test:integration -- conversations-composite-key` against `dev20`.
- [ ] Update `datastore-sync.test.ts` (PIN-5793 scenarios) for composite-keyed pushes; add the cross-ticket dup-msgId case to the merge scenario.

### Step 5 — Manual sign-off

- [ ] Click-through manual scenario 1 (two folders, same msgId, full round-trip).
- [ ] Verify dashboard shows composite-keyed rows for tickets/people too (sortField = key, no auto-timestamp).

---

## A note on minimalism

This is a wire-shape change, not an architecture refactor. Net code delta should be **negative**: `extractTicketId` + dup-msgId block + `content.ticketId` injection block all delete. The only meaningful additions are `sortField` on the type, two lines of body construction, and the manifestKey scheme. If the diff grows past ~150 LOC of changed TS, something has gone wrong.

---

## LEARNINGS & CHANGES (stage 03)

Three small divergences from the plan, none changing the wire contract or the success criteria.

1. **Diff is bigger than the "~150 LOC" budget I named.** Final app-code delta is ~220 LOC across five files (datastoreSync 137, entities/datastore 58, skillsApi 7, Viewer 2, entityRouting 15). The bulk lives in `pushAllToDatastoresImpl` not because the wire shape change was big, but because adding `sortField` to `LocalRow` rippled through three downstream sites — the `remoteByComposite` lookup, the deletion phase's composite check, and the post-push manifest reconcile — each of which had to be restructured around the composite identity. Each individual change is small; the function just has many co-evolving pieces. Considered breaking the push function into smaller helpers but decided not to — that's a refactor on top of a wire-shape change, and the stage-04 reviewer can revisit if the inflated diff becomes a navigation tax.

2. **Skipped writing a `datastoreSync.test.ts` mock-based unit test.** Project convention (per the leading comment in `filestoreSync.test.ts:1-7` and `kb.test.ts:5-7`) is to leave networked orchestrator behavior to integration tests — mocked unit tests for `makeSkillsFetch`-driven code mostly assert on the mock. The new `conversations-composite-key.test.ts` integration test covers the wire shape against a real cloud, and the `datastore-sync.test.ts` updates exercise the round trip end-to-end. Updated the plan's "Unit tests" section to reflect this rather than carry a check-box that wasn't going to be filled.

3. **Two FE call sites needed `sortField` for type compliance.** `entityRouting.ts:137, 380` and `Viewer.tsx:761` build `MemoryItem`-shaped objects from local row files for the `datastore-table` view. With `sortField` now required on the type, these had to set something — settled on `sortField: <key>` (mirror) since these are local-only constructions with no cloud roundtrip; matches the wire convention we adopted for non-conversations openit-* push.

The `pullDatastoresOnce` conflict parser (`datastoreSync.ts:794-807`) splits manifest keys on the first `/` only — for a composite conversations key `openit-conversations/T1/msg-X` it produces `key: "T1/msg-X"`. Considered teaching it the composite shape; left as-is because the only consumer (`Shell.tsx:434`) treats the joined `${col}/${key}.json` as a path-shaped log line, and that line still reads correctly.
