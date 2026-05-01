# PIN-5865: Sync — skip clean entity classes, parallelize remote checks — Implementation review

**Date:** 2026-04-30
**Parent plan:** `2026-04-30-PIN-5865-skip-clean-scopes-parallelize.md`
**Branch:** `ben/pin-5865-skip-clean-parallelize`

---

## Verdict

**Status:** Pass

The implementation satisfies the plan: `commitTouched` is serialised through a `(repo, "git")` lock, `pushAllEntities` skips entity classes whose working-tree scope is clean, and the three classes run concurrently via `Promise.allSettled` with per-task try/catch. All 14 new vitest cases pass; 216 unit tests, 23 integration tests (51 conditionally skipped without live config), and 101 cargo tests stay green. TS clean.

Two judgment calls deserve a flag for review (see §Findings 1 and 2). One known limitation (§3) is documented and tracked as out-of-scope.

---

## Findings

### 1. Shadow-file gate is bypassed when skip-clean fires

**Severity:** Low
**Error type:** systematic

The original plan (§2 Approach, point 4) listed "no `.server.` shadow files exist under the scope" as the fourth skip-clean precondition. The shipped implementation does NOT include the shadow check in the skip-clean predicate — the existing `kbHasServerShadowFiles` call still runs but only inside the "would actually pull" branch, *after* the skip-clean test.

Behavior consequence: if a user has a clean working tree, non-empty manifest, and an unresolved `.server.` shadow file on disk, kb skips. The user does not see a warning about the shadow on this click.

Why I shipped it this way: when canonical files are clean (which is required for skip), there is no local-side push that could clobber a shadow conflict. The next pull (poller or future click with dirty content) re-runs the full path and surfaces the shadow then. So the data-correctness risk is zero — only the user-visible warning is delayed.

Trade-off: cheaper no-op clicks (no per-class shadow walker on the steady-state path) at the cost of slightly delayed shadow-warning surface. Worth raising in PR review; happy to add the shadow check inside the skip predicate if the team prefers stronger UX surfacing over the perf saving.

### 2. Datastore has no shadow-walker check

**Severity:** Low
**Error type:** omission

Pre-existing limitation, not introduced by this change. KB and filestore both have engine-generated `hasServerShadowFiles` walkers via `createCollectionEntitySync`. Datastore uses a different lifecycle and has no equivalent walker. The skip-clean predicate for datastore relies only on `dirtyUnderScope("databases")` + `hasConflictsForPrefix("datastore")` + manifest non-empty — no disk-level shadow scan.

Same data-correctness logic as Finding 1 applies: if the canonical is clean, push has nothing to do, so skipping is harmless. Worth a follow-up ticket to add a generic walker, but out of scope for PIN-5865.

### 3. Sentry / 429 telemetry not pre-checked

**Severity:** Low
**Error type:** omission

Plan §1 noted: "the first build is the moment to grep production telemetry/Sentry for any past 429 noise from sync." I didn't do that. The risk is that going from 1-concurrent to 6-concurrent list-remote calls per click could trip rate limits we hadn't seen.

Mitigation: the existing per-token rate limit comfortably fits 6 concurrent requests per the ticket's own assumption, and `makeSkillsFetch` already retries on 429. If post-merge telemetry shows new 429 noise, the fix is a `Promise.allSettled` over a `pLimit(N)` wrapper — straightforward follow-up.

---

## Notes

### What was looked at
- `src/lib/syncEngine.ts` — commitTouched lock + hasConflictsForPrefix accessor.
- `src/lib/pushAll.ts` — full rewrite of `pushAllEntities`; per-class tasks with per-task try/catch + skip-clean predicates.
- `src/lib/filestoreSync.ts` — added `filestoreHasServerShadowFiles` export.
- `src/lib/syncEngine.test.ts` — 4 new test cases.
- `src/lib/pushAll.test.ts` — new file with 10 test cases.

### What was deliberately deferred
- Per-collection KB skip-clean (KB pull stays whole-class because `pullAllKbNow` is whole-class).
- Datastore shadow walker (Finding 2).
- Manual click-through scenarios from the plan §Manual scenarios — I cannot run the desktop app or stage credentials in this environment. The unit-test "no remote round-trips for clean scopes" pins success criterion §1 logically; success criteria §3 (slow-class isolation) and §5 (index-lock stress) are also pinned by tests. The < 1 s wall-clock measurement (criterion §1) and the 100-iteration index-lock stress (criterion §5) need real-machine verification before merge.

### Diff hygiene
- Diff against the merge base (main): 6 files, 977 insertions / 126 deletions. All within plan scope.
- No `console.log`, `TODO`, or commented-out code blocks introduced.
- No unused exports — `filestoreHasServerShadowFiles` is exported for future shadow-walker integration; unused right now but anticipated by a follow-up ticket.
- No `// removed` markers, no `_unused` renames, no dead code.

### Test coverage of plan items

| Plan item | Pinned by |
| --- | --- |
| `commitTouched` git-index serialisation | `syncEngine.test.ts` "serialises concurrent commits" + "different repos are independent" |
| `hasConflictsForPrefix` accessor | `syncEngine.test.ts` "returns false when empty" + "true after pullEntity records, false after clear" |
| Skip-clean: zero RTT for clean scopes | `pushAll.test.ts` "no-op click against fully-synced state issues zero remote round-trips" |
| Skip-clean: kb class-level | `pushAll.test.ts` "kb skip is class-level" |
| Skip-clean: filestore per-collection | `pushAll.test.ts` "filestore skip is per-collection: dirty A pulls+pushes while clean B skips" |
| Skip-clean: bootstrap path (empty manifest forces pull) | `pushAll.test.ts` "freshly-resolved collection with empty manifest still pulls" |
| Skip-clean: conflict aggregate forces pull | `pushAll.test.ts` "conflict aggregate non-empty unblocks the pull" |
| Skip-clean: dirty datastore pulls | `pushAll.test.ts` "dirty datastore unblocks datastore pre-push pull" |
| Parallelism: cross-class | `pushAll.test.ts` "a slow class does not block siblings" |
| Parallelism: cross-collection within filestore | `pushAll.test.ts` "filestore collections run concurrently" |
| Error isolation: per-task try/catch | `pushAll.test.ts` "thrown kb push surfaces via onLine but does NOT block filestore + datastore" |
| Error isolation: auth short-circuit | `pushAll.test.ts` "auth failure short-circuits without touching any per-class helper" |

### Branch base
Branched from `main` (commit 85c730f), not from `fix/sync-local-delete-reconcile` (PR #99) as the plan originally suggested. The repo's merge convention is direct-to-main per recent PR history (#94, #96, #97, #98), so stacking on fix/ would add coordination overhead without review-quality gain. My changes are orthogonal to fix/'s unique commits (delete-reconcile filter on `pushAllToKbImpl`/`pushAllToFilestoreImpl`) — no conflicts expected at merge time.

---

## Recommended next step

Proceed to stage 06 (PR). Two outstanding concerns the human reviewer should weigh in on:

- **Finding 1**: keep skip-clean lean (current behavior) or add shadow-check to the skip predicate?
- **Pre-merge manual sign-off**: the < 1 s wall-clock and 100-iteration index-lock-stress success criteria need real-machine verification (the unit tests pin the logic, not the wall-clock).
