# Sync Engine

## In simple terms

OpenIT keeps a folder on your laptop in sync with your Pinkfish org. When you connect, we copy your knowledge bases, files, datastore rows, agents, and workflows down into `~/OpenIT/<org>/` as plain files. While you work, the engine watches both sides:

- **Pinkfish changed something?** We pull the new version down and commit it.
- **You changed a file locally?** Hit "Sync to Pinkfish" in the Sync tab and we push it up.
- **Both sides changed the same thing?** That's a conflict. We don't pick a winner — we drop a `<file>.server.<ext>` shadow next to your file containing the remote version, mark the file with a ⚠ in the explorer, and ask Claude to merge.

That's the whole engine. The rest of this doc is how it pulls that off.

---

## Architecture

```
                ┌─────────────────────────────────────────┐
                │  Wrapper (kb.ts, datastore.ts, …)       │
                │  - knows how to talk to its REST API    │
                │  - knows where files live on disk       │
                │  - exposes EntityAdapter                │
                └──────────────────┬──────────────────────┘
                                   │
                                   ▼
                ┌─────────────────────────────────────────┐
                │  syncEngine.pullEntity(adapter, repo)   │
                │  - per-repo lock                        │
                │  - manifest load → diff → save          │
                │  - shadow rule + auto-commit            │
                │  - conflict aggregate emit              │
                └─────────────────────────────────────────┘
```

**One pipeline, five entities.** KB, filestore, datastore, agents, and workflows all funnel through `pullEntity`. The only per-entity code is the adapter — ~50 lines describing how to list/fetch/write that entity's items. This is the result of a refactor that collapsed five drift-prone copies of the same logic.

### Files

- **`syncEngine.ts`** — the pipeline, the lock, the conflict aggregate, the shadow helpers.
- **`syncEngine.test.ts`** — vitest cases pinning the canonical scenarios (two-user conflict, fast-forward pull, bootstrap-adoption, server-delete, pagination failure, content-equality).
- **`entities/<name>.ts`** — adapters. Each implements `EntityAdapter` and is wrapped by a wrapper that handles bootstrap + polling.
- **`datastoreSync.ts` / `filestoreSync.ts`** — wrappers for the entity types that have their own bootstrap flow (collection resolve, initial item write).

---

## Core types

### `EntityAdapter`

What every entity provides. Five required methods, one optional:

| Method | Purpose |
|---|---|
| `loadManifest(repo)` | Read `.openit/<entity>-state.json` from disk. |
| `saveManifest(repo, m)` | Write it back atomically at the end of the pull. |
| `listRemote(repo)` | Fully paginate the remote. Returns `{ items, paginationFailed, unreliableKeyPrefixes }`. |
| `listLocal(repo)` | Walk the working tree dirs. Includes shadows (engine filters via `isShadow`). |
| `onServerDelete?(args)` | Optional. Called when a manifest entry has no matching remote. Default: drop the entry. KB/datastore opt in to also delete the local file. |

### `Manifest`

```ts
{
  collection_id: string | null,
  collection_name: string | null,
  files: {
    [manifestKey]: {
      remote_version: string,    // server's updatedAt
      pulled_at_mtime_ms: number  // local mtime when we last pulled
    }
  }
}
```

`manifestKey` is usually the working-tree path, except for datastore where it's `<collectionName>/<key>` so collisions across collections can't fight.

### `RemoteItem` / `LocalItem`

`RemoteItem` carries `fetchAndWrite` + `writeShadow` callbacks plus an optional `inlineContent` for cheap content access (datastore rows). `LocalItem` carries an `mtime_ms` and an `isShadow` flag.

---

## The pull pipeline

`pullEntityImpl` is a single loop over the remote list. For each remote item, four cases:

### 1. Brand new (`!tracked && !localFile`)
Fetch + write canonical. Seed the manifest. Add path to `touched`. Auto-commit at the end.

### 2. Bootstrap-adoption (`!tracked && localFile`)
File on disk but no manifest entry — typical right after the connect-modal seeded the working tree. Adopt the existing bytes as the new baseline (don't re-download — that would mtime-thrash and look like a local edit).

**Content-equality guard:** if the adapter exposes `inlineContent`, the engine compares local bytes to remote bytes before adopting. Mismatch → write a shadow + record a conflict + leave the manifest unseeded. This is the post-resolve drift case: if Claude merged a conflict but the user hasn't pushed yet, local has the merged content while remote still has the pre-merge version. Without this guard, the engine would adopt the merged content as "synced" and the divergence would never surface again.

### 3. Tracked + on disk (`tracked && localFile`)
Compare `r.updatedAt` vs `tracked.remote_version` and `localFile.mtime_ms` vs `tracked.pulled_at_mtime_ms` to decide:

| remoteChanged | localChanged | Outcome |
|---|---|---|
| no | no | nothing to do |
| yes | no | fast-forward pull, manifest advances, auto-commit |
| no | yes | nothing here — push will handle it |
| yes | yes | **conflict**: write shadow, do NOT advance manifest |

The "do NOT advance manifest" part is what makes the next push detect the conflict — push gates on `conflicts.length > 0` from a pre-pull, and an unadvanced manifest keeps the conflict alive across polls until it's resolved.

### 4. Tracked + missing locally (`tracked && !localFile`)
User or Claude deleted it. Leave the manifest entry alone — push will reconcile.

### Server-delete pass
After the loop: anything still tracked that wasn't in the remote list is a server-side delete. Adapters opt in via `onServerDelete` to also remove the local file (KB does, datastore does); default just drops the manifest entry.

**Pagination guards:**
- `paginationFailed: true` → skip the entire server-delete pass. The truncated list isn't authoritative.
- `unreliableKeyPrefixes: [...]` → skip only manifest keys with these prefixes. Datastore uses this when one collection out of N fails mid-paginate; other collections still reconcile.

---

## Conflict shadows

When both sides change, the engine writes `<base>.server.<ext>` next to the canonical (e.g. `runbook.md` → `runbook.server.md`). Shadow files are gitignored — the engine never adds them to the `touched` array. If it did, `git add -- <path>` would reject the gitignored path and silently drop the whole batch (so legitimate pulled-file commits in the same cycle would vanish — this was a real BugBot finding).

### Sibling-aware classification

`classifyAsShadow(filename, siblings)` is the single source of truth for "is this a shadow?". A file is a shadow IFF:
1. Its filename contains `.server.`, AND
2. Its canonical sibling (`<base>.<ext>`) is also present in the local set.

Without #2, `nginx.server.conf` would be misclassified as a shadow even when there's no `nginx.conf`. This is also why the sibling set must include shadow-shaped names — a follow-on `a.server.server.conf` correctly maps back to its canonical `a.server.conf`.

### Idempotency

If a shadow already exists from a prior pull, the engine records the conflict in the result/aggregate but does **not** re-write the shadow. Otherwise every 60s poll while a conflict was open would mtime-thrash the working tree.

---

## Conflict resolution flow

1. Engine writes `<base>.server.<ext>` and emits the conflict via `subscribeConflicts`.
2. `ConflictBanner` renders a "Resolve in Claude" button. Click → `buildConflictPrompt(conflicts)` produces a markdown prompt that walks Claude through every active conflict.
3. The prompt instructs Claude to perform 4 atomic actions per conflict: read both sides, write the merge, delete the shadow, **run `node .claude/scripts/sync-resolve-conflict.mjs --prefix <p> --key <k>`**.
4. The script deletes the manifest entry. Next poll's content-equality check then catches the (still-diverging) local-vs-remote, surfacing the user's merged content as ready-to-push.
5. User clicks "Sync to Pinkfish" → push uploads the merge → on the next poll, remote == local, the conflict clears.

The script step is required — without it, the engine has no signal that the merge happened and would re-create the shadow on the next poll. The prompt is structured to make this very hard for Claude to skip.

---

## Concurrency

`withRepoLock(repo, prefix, fn)` serializes pull + push + bootstrap-write per `(repo, prefix)`. Two different entities (KB pull vs datastore pull) don't block each other; two operations on the same entity must.

Pull callbacks (`onPhase`, `onResult`, `onError`) fire **inside** the lock. This matters because wrapper-side status updates ("phase: ready", conflict count, lastPullAt) need to commit before any push waiting on the lock can flip status to "pushing". Without that ordering, push status updates could land between lock release and the `.then()` callback.

---

## Polling

`startPolling(adapter, repo, opts)` runs `pullEntity` every 60s and forwards all callbacks. `startReadOnlyEntitySync` is a higher-level helper for entities (agents, workflows) where the adapter is rebuilt every tick from a fresh REST resolve — this picks up server-side adds/deletes that the manifest alone wouldn't surface.

---

## Auto-commit

`commitTouched(repo, touched, message)` is the only path the engine writes to git. The `touched` array contains canonical paths only — the engine never adds shadow paths because they're gitignored and would fail the batch. Adapters that opt in to deleting local files on server-delete must push the deleted path to `touched` themselves so the deletion gets committed.

---

## Conflict aggregate

`subscribeConflicts(fn)` returns the union of all entities' active conflicts. Each `pullEntity` call replaces its own prefix's contribution (`conflictsByPrefix.set(prefix, …)`); `clearConflictsForPrefix(prefix)` is called from a wrapper's stop function so a stale entry can't outlive its sync. The aggregate drives the global `ConflictBanner` and the ⚠ markers in `FileExplorer`.

---

## Pre-push pull guards

Before pushing, the Sync tab runs a fresh `pullOnce` to surface any conflicts created since the last poll. If the pull returns `{ ok: false, ... }` (silent failure) or surfaces conflicts, the push is blocked. This is what prevents user A from silently overwriting user B's edit.

---

## Adding a new entity

1. Write `src/lib/entities/<name>.ts` exporting a function that returns an `EntityAdapter`.
2. Implement the five required methods. Reuse `shadowFilename` / `classifyAsShadow` for shadow handling.
3. Wrap with `startPolling` (or `startReadOnlyEntitySync` if there's no per-item bootstrap).
4. Wire `clearConflictsForPrefix("<name>")` into the wrapper's stop function.
5. Add a vitest case that mirrors the canonical "two-user conflict" test in `syncEngine.test.ts`.

The shorter the adapter, the better. If you find yourself writing diff logic, you're probably duplicating the engine.
