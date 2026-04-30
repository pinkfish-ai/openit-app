# Linear ticket draft — conversations composite key

**Title:** Conversations sync — use composite (key, sortField) to mirror folder/file layout

**Team:** Pinkfish · **Labels:** Improvement · **Predecessor:** PIN-5793

---

## Problem

`openit-conversations` is unstructured (correctly — per-message rows are freeform), but we use only one of the two primary-key columns the cloud datastore exposes. Today push sends `{ key: msgId, content }` and the cloud auto-assigns `sortField` to a creation timestamp we never read back. The screenshot of `dev20`'s collection viewer shows it as `1777559287792` — noise we paid for.

Because the composite (key, sortField) is left on the floor, all per-ticket routing hangs off `content.ticketId` instead. That carries three avoidable failure modes already in the code:

- **Cross-ticket msgId collisions on push.** `databases/conversations/T1/msg-X.json` and `databases/conversations/T2/msg-X.json` collide on cloud (cloud key = bare `msgId`). Push detects and silently first-writer-wins with a `console.warn` (`datastoreSync.ts:563-573`). Theoretical for first-party content, real for admin copy-paste.
- **Folder-vs-content mismatch on push.** When `content.ticketId !== <folder>`, push mutates the parsed object in memory before POST/PUT (`datastoreSync.ts:619-622`). Cloud gets the corrected ticketId; the local file stays stale until next pull self-heals.
- **Missing-ticketId rows silently dropped on pull.** `extractTicketId` returns null → row dropped with `console.warn` (`entities/datastore.ts:121-127`). Invisible to UI.

## Desired Outcome

Conversation rows on the cloud are addressed compositely: `{ key: ticketId, sortField: msgId, content: {...message JSON...} }`. The on-disk layout `databases/conversations/<ticketId>/<msgId>.json` maps 1:1 onto the composite key — routing is an addressing fact, not a content fact.

- **Pull** writes to `databases/conversations/<row.key>/<row.sortField>.json` directly. No `extractTicketId`. No "drop if missing".
- **Push** emits `{ key: <folder>, sortField: <filename without .json> }`. No content mutation, no fallback path.
- **`content.ticketId`** becomes optional — kept for human-readability when reading a single JSON in isolation, not load-bearing on the sync.
- **Cross-ticket msgId reuse is naturally legal** — the composite is unique by construction.
- **Chronological order on cloud** comes from `msgId` directly (`msg-<unix-ms>-<rand>` already encodes time). Strictly better than the auto-stamp.

## Scope

**In:**

- `MemoryItem` type gains `sortField: string` (`src/lib/skillsApi.ts`).
- POST/PUT bodies in `pushAllToDatastoresImpl` send `{ key, sortField, content }` for `openit-conversations`.
- `entities/datastore.ts::listRemote` derives subdir/filename from `row.key`/`row.sortField` for the conversations collection. Drops `extractTicketId` + missing-ticketId warn-and-skip path.
- Engine manifestKey scheme moves to `openit-conversations/<ticketId>/<msgId>` (was `openit-conversations/<msgId>`).
- Remove now-dead push paths: duplicate-msgId detection (R7 first-writer-wins), `content.ticketId` injection-from-folder-name.
- Decide and document what `sortField` value tickets/people/custom unstructured datastores send (likely the row key, or `""`, depending on cloud semantics).
- Integration test (`integration_tests/datastore-sync.test.ts`) covers: composite-key round trip, cross-ticket dup-msgId case, delete-by-id, content-without-ticketId pull.
- Migration: nuke + reseed `openit-conversations` on dev/test orgs. Brief acknowledges V2 hasn't launched (no production data).

**Out:**

- Server-side `?key=<ticketId>` filter for per-ticket queries (future optimization; FE already walks one folder at a time).
- Schema flip for tickets/people (stays structured; no sortField semantic value, send something stable).
- Migration script for production-org rows (none exist).
- UI surface changes — none required.

## Success Criteria

- [ ] Pushing `databases/conversations/T1/msg-X.json` produces a cloud row `{ key: "T1", sortField: "msg-X" }`.
- [ ] Pulling that row writes back to `databases/conversations/T1/msg-X.json`, with `content.ticketId` no longer required for the routing to work.
- [ ] Two tickets `T1` and `T2` containing identical `msg-X.json` filenames push as two distinct cloud rows and round-trip independently — no `console.warn` collision.
- [ ] A cloud row missing `content.ticketId` still pulls successfully (key carries the routing).
- [ ] Push code path no longer contains `obj.ticketId = ticketId` injection.
- [ ] Engine manifest has one entry per `(ticketId, msgId)` pair.
- [ ] Integration test `datastore-sync.test.ts` includes the cross-ticket dup-msgId scenario.
- [ ] `vitest run`, `cargo test`, `cargo fmt --check`, and one manual conversations round-trip scenario all pass.

## Cloud contract — confirmed in firebase-helpers

(Verified against `firebase-helpers/spec/tsp-output/generated/models/` and `functions/src/{memory.controller,utils/owner}.ts`.)

- `MemoryCreateItemRequest.sortField` is an **optional** top-level field on POST. Wire format: `{ key, sortField?, content, ... }` (`MemoryCreateItemRequest.ts:60`).
- `MemoryItem.sortField` is **required** on read — every list / get response carries it (`MemoryItem.ts:67, 162`).
- POST omitting `sortField` on a collection without `schema.sortConfig` triggers `newSortField = Date.now().toString()` (`owner.ts:174-176, 308-311`). That's the `1777559287792` value in the screenshot.
- POST with `sortField` upserts on the composite `(key, sortField)` (`owner.ts:204-217`). Two rows with the same key but different sortFields coexist as distinct rows; same sortField but different keys also coexist.
- PUT-by-id (current shape) overwrites `sortField` with whatever the caller sends (`owner.ts:158, 333`) — but **excludes `key`** from update (destructured out at line 124). So flipping our PUTs to send `sortField` self-heals existing rows' sortField, but does NOT migrate a row from `key=msgId` to `key=ticketId`. Existing dev/test rows need DELETE-then-POST.
- `GET /memory/items` accepts `?key=<x>&sortField=<y>` query params (`memory.controller.ts:637-646`). Per-ticket filter for free.
- `DELETE /memory/items/:key?sortField=<x>` deletes a single composite-keyed row (`memory.controller.ts:533-562`).

**Cloud implications for tickets/people/custom unstructured datastores.** They have no semantic sortField. Three viable options, no behaviour difference cloud-side:
- **Mirror the key** — send `sortField: <key>`. Always-unique by definition.
- **Send empty string** — accepted, but creates a magic value.
- **Omit** — cloud auto-stamps `Date.now()`. Status quo. Harmless because we don't query by sortField on those.

Recommendation: mirror the key for all openit-* collections except conversations. One uniform rule, no per-collection special cases, no auto-stamps in storage we never read.
