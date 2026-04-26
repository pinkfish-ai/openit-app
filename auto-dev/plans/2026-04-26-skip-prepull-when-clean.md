# 2026-04-26 — Skip pre-push pull when no local changes

**Status:** Draft.

## Why

User reported the Sync-tab Commit (and Claude-triggered `sync-push.mjs`) takes ~15-25s for a single 1-row change. Most of that is the unconditional pre-push pull walking every entity to check for remote-side conflicts:

| Entity | Cost | Notes |
|---|---|---|
| KB | ~3s | one paginated REST list |
| Filestore | ~3s × N collections | sequential per collection |
| Datastore | ~5-10s | 15 collections × paginate (worst offender for the tested org) |

When the working tree has no local-pending changes for an entity, the pre-pull is wasted work — there's nothing to clobber on remote and nothing to push, so the conflict-detection pass adds zero value.

After the dup-listener fix landed in the previous PR, a single push pipeline runs ~15s. With this optimization a clean push (e.g. user clicks Sync to confirm a "pick remote" merge that left local == remote) drops to ~1-2s end-to-end.

## What

Before each entity's pre-pull, check whether any local file under that entity has diverged from the manifest's last-pulled mtime. If nothing's pending, skip both the pre-pull AND the push for that entity. If something IS pending, current behavior unchanged.

Per-entity "pending-changes" check, all local-only (no API):
- **KB**: walk `kbListLocal(repo)`; manifest from `kbStateLoad(repo)`. Pending iff any file has `mtime > entry.pulled_at_mtime_ms`, OR any file has no manifest entry, OR any manifest entry has no matching file (server-delete reconciliation TODO; deletions are rare).
- **Filestore**: same pattern, per collection — but the manifest is repo-wide (`fsStoreStateLoad(repo)`), so the check naturally aggregates across collections.
- **Datastore**: per collection (15 of them in the tested org), since we can usefully skip pre-pull on the 14 quiet ones. Manifest is repo-wide via `datastoreStateLoad(repo)`, but keys are namespaced as `<colName>/<key>`.

## Scope guards

- **Pre-existing conflict shadows still trigger pre-pull.** If a `.server.` file exists, the row IS in conflict state regardless of what mtime says — fall back to pre-pull so the existing conflict-detection logic runs.
- **No deletions tracked yet.** This optimization assumes local files only get added/modified, not deleted. Deletions would require comparing manifest keys to file presence; we'll handle that as a follow-up if it bites.
- **`conflict_remote_version` entries always trigger pre-pull.** A row with that field set is in active resolve flow — we shouldn't short-circuit it.

## Implementation plan

1. Add `src/lib/pendingChanges.ts` exporting:
   - `kbHasPendingChanges(repo): Promise<boolean>`
   - `filestoreHasPendingChanges(repo): Promise<boolean>`
   - `datastoreCollectionHasPendingChanges(repo, colName): Promise<boolean>`
   - Each loads its manifest + lists local, returns true on first divergence found (so common case is fast).
2. Wire into `pushAllEntities` (`src/lib/pushAll.ts`):
   - For each entity block, call the relevant helper before pre-pull.
   - If false: log `▸ sync: <entity> skipped (no local changes)` and continue.
   - If true: existing pre-pull + push behavior.
3. **Datastore subtlety.** `pushAllToDatastores` and `pullDatastoresOnce` both walk all 15 collections via the engine's adapter. Per-collection skip needs the adapter to accept a "filter" of which collection names to process, OR a wrapper at the pushAllEntities level that builds a filtered datastoreAdapter for each collection in turn. Decide between:
   - **Option A: filter param on `datastoreAdapter`** — small change, scoped.
   - **Option B: wrapper loops collections, builds adapter per collection** — more aligned with filestore's per-collection pattern, more invasive.
   - Lean A; revisit if the per-collection iteration model becomes useful elsewhere.

## Tests

- Unit tests for each `*HasPendingChanges` helper:
  - All in sync (file mtime ≤ pulled_at) → false
  - File exists, no manifest entry → true
  - File mtime > pulled_at → true
  - Conflict shadow on disk → true (fall-back to pre-pull)
  - `conflict_remote_version` set on manifest entry → true
  - Empty repo → false
- Integration on `pushAllEntities`: mock pushAllToKb / pullNow / etc. and assert they're NOT called when helper returns false. (Probably extract a thin shim to mock around.)
- No regression: existing flow tests still green when helper returns true.

## Out of scope

- Server-delete reconciliation when nothing local changed (the engine's poll handles this; not push-time).
- Per-collection refactor of the datastore push pipeline beyond what's strictly needed for the skip check.
- Optimizing the engine's polling loop (different concern).

## Forward path after merge

If the time savings turn out to be load-bearing (e.g., user pushes 10x/hour), revisit:
- Cache the manifest in TS memory between Sync-tab clicks (avoid disk read on every push).
- Stream pre-pull/push lines to disk so the user sees progress on the slow first push of a session.
