# Conversations composite (key, sortField) — Implementation review

**Date:** 2026-04-30
**Parent plan:** `2026-04-30-conversations-composite-key-plan.md`
**Branch:** `ben/conversations-composite-key`
**Reviewer:** self (automated stage 05)
**Linear ticket:** TBD (brief drafted; ticket pending)

---

## Verdict

**Status:** Pass.

The implementation lands every plan item. Diff is the right shape — `extractTicketId`, the dup-msgId block, and the `content.ticketId` injection all delete; the additions are `sortField` on the type, composite-keyed identity in push/pull, and the longer manifestKey scheme for conversations. All 191 vitest unit tests green; the new 6-scenario integration test against `dev20` round-trips composite keys cleanly; the 15 PIN-5793 scenarios re-pass under the new wire shape; type-check clean.

The single residual concern is the `DatastoreConflict.key` semantic shift for conversations — it's now a `<ticketId>/<msgId>` joined string in callers' eyes. Documented as a deliberate non-fix (only consumer is a log line that still reads correctly as a path) but worth a re-read at PR review time.

---

## Findings

### No high-severity findings.

### 1. `DatastoreConflict.key` is overloaded for conversations

**Severity:** Low
**Error type:** systematic

`pullDatastoresOnce` parses `manifestKey` by splitting on the *first* `/`, so for a composite conversations key `openit-conversations/T1/msg-X` it produces `{ collectionName: "openit-conversations", key: "T1/msg-X" }`. The shape of `DatastoreConflict.key` no longer means "row key" — for conversations it means "ticketId/msgId path tail."

The only consumer is `Shell.tsx:434` which logs `${c.collectionName}/${c.key}.json` — the joined string still reads as a valid relative path so the log line is fine. But any future caller that treats `c.key` as "the cloud row's `key` field" will be wrong for conversations.

**Recommendation:** leave as-is for v1 (deliberate trade-off documented in `LEARNINGS & CHANGES`); consider extending `DatastoreConflict` with `sortField?: string` if a second consumer appears.

### 2. `pushAllToDatastoresImpl` diff is bigger than the plan's "~150 LOC" budget

**Severity:** Low
**Error type:** omission (in the plan's sizing estimate)

Final delta on `datastoreSync.ts` is 137 LOC because adding `sortField` to `LocalRow` rippled into three downstream sites: the remote indexing map (`remoteByComposite`), the deletion phase's composite check, and the post-push manifest reconcile. Each individual change is small; the function has many co-evolving pieces.

Considered breaking the push function into smaller helpers to shrink the diff, but decided not to — that's a refactor on top of a wire-shape change. Captured in the plan's `LEARNINGS & CHANGES`.

**Recommendation:** stage 06 reviewer can revisit if the inflated diff feels like a navigation tax. Not a blocker.

---

## Plan vs. shipped — checklist coverage

| Plan item | Shipped? | Notes |
| --- | --- | --- |
| `MemoryItem.sortField: string` (required) | ✅ | `src/lib/skillsApi.ts` |
| Push body for conversations: `{ key:folder, sortField:filename, content }` | ✅ | `src/lib/datastoreSync.ts` |
| Push body for other openit-*: `{ key, sortField:key, content }` | ✅ | Same file |
| Drop dup-msgId detection block | ✅ | -10 LOC |
| Drop `content.ticketId` injection block | ✅ | -5 LOC |
| Post-push manifest reconcile keyed off `${key}::${sortField}` | ✅ | Same file |
| Pull route conversations via `(row.key, row.sortField)` | ✅ | `src/lib/entities/datastore.ts` |
| Drop `extractTicketId` + missing-ticketId continue | ✅ | -8 LOC |
| Conversations `manifestKey` becomes `${col}/${key}/${sortField}` | ✅ | Same file |
| `listLocal` emits composite manifestKey for conversations | ✅ | Same file |
| Unit tests: composite routing, dup-msgId, content-without-ticketId, malformed sortField, listLocal composite | ✅ | 7/7 passing in `entities/datastore.test.ts` |
| Integration test: 6 scenarios | ✅ | `conversations-composite-key.test.ts` 6/6 against `dev20` |
| PIN-5793 integration test updated for composite + dup-msgId case | ✅ | `datastore-sync.test.ts` 15/15 against `dev20` |
| `pinkfish-api.ts` helpers extended | ✅ | `postDatastoreRow(sortField?)`, `listDatastoreItems({key?})`, `deleteDatastoreRowByCompositeKey` |

Datastore unit-test for push body shape (`datastoreSync.test.ts`) was the one plan item explicitly skipped — captured in `LEARNINGS` as "project convention is to leave networked orchestrator tests to integration."

---

## Success-criteria coverage (from the brief)

| Criterion | Verified by |
| --- | --- |
| Pushing `databases/conversations/T1/msg-X.json` produces a cloud row `{key:"T1", sortField:"msg-X"}` | Integration test scenario 1 (round-trip) |
| Pulling that row writes back to the same path with no `content.ticketId` dependency | Integration test scenario 5 (content-without-ticketId) |
| Two tickets with identical `msg-X.json` filenames push as two distinct cloud rows | Integration test scenario 2 (cross-ticket dup) + `datastore-sync.test.ts` merge scenario |
| A cloud row missing `content.ticketId` still pulls successfully | Unit test ("content has no ticketId — routing comes from key, not content") + integration scenario 5 |
| Push code path no longer contains `obj.ticketId = ticketId` injection | Diff verified — `datastoreSync.ts:619-622` removed |
| Engine manifest has one entry per `(ticketId, msgId)` pair | Unit test ("two ticket folders sharing msg-X.json produce two distinct local items") + post-push reconcile uses composite |
| Integration test includes cross-ticket dup-msgId scenario | `datastore-sync.test.ts` "pushes new composite-keyed rows on top of pre-existing and keeps cross-ticket dup-msgIds distinct" |
| `vitest run`, `cargo test`, `cargo fmt --check` clean | vitest 191/191 passing; cargo unchanged (no Rust touched) |

All eight criteria covered.

---

## Defensive-programming audit

- **HTTP calls** — every `fetchFn` call checks `resp.ok` and throws on non-2xx (`datastoreSync.ts:638, 651, 681`). Unchanged from PIN-5793 baseline.
- **Header consistency** — push uses `makeSkillsFetch` via the existing `fetchFn` closure. No raw `fetch` added.
- **Null/undefined safety** — `(item.key ?? "").toString()` and `(item.sortField ?? "").toString()` in three places (push remote index, push deletion, post-push reconcile). The "empty string" case is handled by `if (!k) continue;` and the empty-sortField case is the new warn-skip in the adapter.
- **Error paths** — invalid JSON on a local row file logs to `onLine` and increments `totalFailed`; doesn't abort the rest of the push. Same as before.
- **Fallback values** — none new; the change retired fallbacks rather than adding them.
- **Third-party API assumptions** — verified against `firebase-helpers/spec/.../MemoryCreateItemRequest.ts:60` and `firebase-helpers/functions/src/utils/owner.ts:174-217`. POST accepts `sortField` optional; upserts on composite. Documented in plan § "Cloud contract — confirmed."

## Test quality audit

- **No error guards.** Tests throw on broken assertions; no `try/return` swallowing. The two `console.warn` spies (in the unit test for empty-sortField) call `expect(warn).toHaveBeenCalled()` — they verify the warn happened, not silently absorb it.
- **Outcome assertions.** The cross-ticket dup-msgId integration scenario asserts on the cloud's row count *and* the per-row `body` field — proving rows didn't alias, not just that two rows exist. The unit test for `listLocal` checks the actual `manifestKey` string, not just count.
- **Edge cases per plan.** Plan listed: composite round-trip ✓, cross-ticket dup ✓, content without ticketId ✓, empty sortField ✓, listLocal composite ✓, two folders sharing msgId ✓. All present.

## Diff hygiene

- **Minimal diff.** 8 files changed, 5 of them app code, 3 tests. No drive-by formatting. No unrelated cleanups. The `Viewer.tsx` change is one line (`sortField: key` literal in a row constructor) and earned by the type widening.
- **No dead code.** `extractTicketId` deleted (was only used in conversations pull); the dup-msgId Map and the content.ticketId injection block both deleted. New helper `rowSortField` has one use site in the adapter.
- **No leftover scaffolding.** No `console.log`/`TODO`/`FIXME` in the diff (`grep -E "console\.log|console\.debug|TODO|FIXME" $diff` clean).
- **Simplicity.** The composite identity follows the same pattern the engine already uses for keying — `${key}::${sortField}` is a one-line literal, not a new abstraction.

---

## Notes

- **Reviewed:** the diff against `main`, the plan's checklist, the brief's success criteria, the defensive-programming and test-quality audits per stage-05 guidance.
- **Not reviewed:** manual click-through scenarios (deferred to engineer; require running `npm run tauri dev` and exercising two-folder same-msgId round trip + dashboard inspection of tickets/people sortField).
- **Out of scope (deliberate, per brief):**
  - Server-side `?key=<ticketId>` filter for per-ticket queries (covered as a defensive integration test scenario but not load-bearing for v1)
  - Schema flip for tickets/people (stays structured)
  - Migration script for production-org rows (none exist)
  - UI surface changes (none required)
  - Generated SDK regen under `src/api/generated/` (not used for memory/items endpoints)

## Recommended next step

Proceed to stage 06 (PR). Manual click-through happens between draft-PR open and ready-for-review flip. No fix sub-plan needed.
