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

- **`syncEngine.ts`** — the pipeline, the lock, the conflict aggregate, the shadow helpers, `contentsEquivalent`.
- **`syncEngine.test.ts`** — vitest cases pinning the canonical scenarios (two-user conflict, fast-forward pull, bootstrap-adoption with/without content-equality, server-delete, pagination failure, content equivalence).
- **`entities/<name>.ts`** — adapters. Each implements `EntityAdapter` and is wrapped by a wrapper that handles bootstrap + polling.
- **`datastoreSync.ts` / `filestoreSync.ts`** — wrappers for the entity types that have their own bootstrap flow (collection resolve, initial item write).
- **`pushAll.ts`** — `pushAllEntities(repo, onLine)`, the single push pipeline shared by the Sync-tab Commit button and the Claude-triggered push (`.openit/push-request.json` flow).
- **`scripts/openit-plugin/sync-resolve-conflict.mjs`** — Claude-callable script that rewrites a conflicted manifest entry into a force-push state.
- **`scripts/openit-plugin/sync-push.mjs`** — Claude-callable script that asks the running OpenIT app to push (writes a marker file, polls for the result).

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
      remote_version: string,                   // server's updatedAt
      pulled_at_mtime_ms: number,               // local mtime when we last pulled
      conflict_remote_version?: string,         // present iff in conflict (see below)
    }
  }
}
```

`manifestKey` is usually the working-tree path, except for datastore:

- **Flat collections** (tickets, people, custom): `<collectionName>/<key>` so keys can't collide across collections.
- **`openit-conversations`** (nested layout): `<collectionName>/<ticketId>/<sortField>`. Mirrors the cloud's composite identity `(key=ticketId, sortField=msgBase)` and stays collision-free even if two threads share a `msgBase` (PIN-5861).

`conflict_remote_version` is the load-bearing piece of the resolve flow. The engine writes it into the entry when it creates a `.server.` shadow, capturing the *current* `r.updatedAt` (which doesn't match `remote_version` because remote moved since the last successful pull). The resolve script reads it back and replays it as the new `remote_version` — that's how OpenIT encodes "the user has reconciled against this remote version, push their local content next" without the script needing to make HTTP calls.

### `RemoteItem` / `LocalItem`

`RemoteItem` carries `fetchAndWrite` + `writeShadow` callbacks plus an optional `inlineContent` for cheap content access (datastore rows). `LocalItem` carries an `mtime_ms` and an `isShadow` flag.

---

## The pull pipeline

`pullEntityImpl` is a single loop over the remote list. For each remote item, four cases:

### 1. Brand new (`!tracked && !localFile`)
Fetch + write canonical. Seed the manifest. Add path to `touched`. Auto-commit at the end.

### 2. Bootstrap-adoption (`!tracked && localFile`)
File on disk but no manifest entry — typical right after the connect-modal seeded the working tree. Adopt the existing bytes as the new baseline (don't re-download — that would mtime-thrash and look like a local edit).

**Content-equivalence guard.** When the adapter exposes `inlineContent`, the engine compares local against remote via `contentsEquivalent` before adopting. The compare is JSON-aware (canonical sort-keys serialization) with a whitespace-trimmed string fallback — naive `===` would false-positive on harmless drift like trailing newlines, CRLF, or different key ordering.

- **Match** → seed the manifest cleanly with `remote_version: r.updatedAt` and `pulled_at_mtime_ms: localFile.mtime_ms`. No conflict.
- **Mismatch** → write the shadow, record the conflict, AND seed the manifest entry with `{ remote_version: "", pulled_at_mtime_ms: 0, conflict_remote_version: r.updatedAt }`. That entry shape both keeps subsequent polls flagging the conflict (remote_version `""` won't match anything) and arms the resolve script with the value it needs to flip the row into force-push state.

### 3. Tracked + on disk (`tracked && localFile`)
Compare `r.updatedAt` vs `tracked.remote_version` and `localFile.mtime_ms` vs `tracked.pulled_at_mtime_ms` to decide:

| remoteChanged | localChanged | Outcome |
|---|---|---|
| no | no | nothing to do — clear `conflict_remote_version` if it was lingering |
| yes | no | fast-forward pull, manifest advances, auto-commit |
| no | yes | nothing here — push will handle it |
| yes | yes | **conflict**: write shadow, set `conflict_remote_version`, keep `remote_version`/`pulled_at_mtime_ms` at their pre-conflict values |

The "keep `remote_version` at the pre-conflict value" piece makes the next push detect the conflict — push gates on `conflicts.length > 0` from a pre-pull, and an unadvanced `remote_version` keeps the conflict alive across polls until it's resolved. The `conflict_remote_version` side-channel is what the resolve script consumes.

### 4. Tracked + missing locally (`tracked && !localFile`)
User or Claude deleted it. Leave the manifest entry alone — push will reconcile.

---

## Scenario matrix

Every combination of "what local did" × "what remote did" since the last successful sync, and how the engine + resolve flow handle it. **L** = file on disk, **R** = remote payload, **base** = state at last successful sync.

### Steady-state pull (tracked entry, no resolve in flight)

| Local since base | Remote since base | Engine outcome |
|---|---|---|
| unchanged | unchanged | no-op |
| changed | unchanged | local-only pending — push on next Sync uploads it |
| unchanged | changed | fast-forward: fetch remote, overwrite local, advance manifest, auto-commit `sync: pull @ <ts>` |
| changed (file deleted) | unchanged | push will issue a delete (`onServerDelete`-aware adapters) |
| unchanged | deleted | engine removes local file (KB / datastore / agent / workflow opt in) and drops manifest entry; filestore just drops the entry |
| **changed** | **changed, byte-equal to local** | not detected as same-value at row level (we compare `updatedAt`, not bytes) — falls into the next row, conflict path. After resolve flow, push uploads "same" content; server returns a new `updatedAt`; manifest catches up. |
| **changed** | **changed, different from local** | **conflict**: write `<base>.server.<ext>`, set `conflict_remote_version = r.updatedAt`, keep `remote_version` and `pulled_at_mtime_ms` at pre-conflict values. Banner shows ⚠. |

### First-ever pull / post-connect (no manifest entry)

| Local on disk? | inlineContent available? | Local vs remote content | Engine outcome |
|---|---|---|---|
| no | — | — | brand new: fetch, write canonical, seed manifest, commit |
| yes | no (KB / filestore) | — | bootstrap-adopt blind: seed manifest with current `r.updatedAt` + on-disk mtime, no rewrite, no commit |
| yes | yes (datastore) | match (`contentsEquivalent`) | bootstrap-adopt clean: seed manifest, no rewrite, no commit |
| yes | yes | mismatch | **conflict**: write shadow, seed manifest entry as `{ remote_version: "", pulled_at_mtime_ms: 0, conflict_remote_version: r.updatedAt }` |

The mismatch case is what catches **post-resolve drift**: after Claude merges and the resolve script runs, the engine's pre-push pull would otherwise see "no manifest entry, file on disk" and adopt the merged content as the new baseline — silently hiding the divergence from remote. Content-equivalence forces the conflict to keep surfacing until the merged content actually lands on Pinkfish.

### Resolve flow (Claude merges, runs scripts, OpenIT pushes)

Starting state: a row with `conflict_remote_version: <V>` and a `.server.` shadow. Banner is up.

| User's choice in merge | Resolve script | Pre-push pull (sync-push.mjs → app) | Push | Net effect |
|---|---|---|---|---|
| Pick **remote** (local now equals remote) | Rewrites entry: `{ remote_version: V, pulled_at_mtime_ms: 1 }` | tracked+on-disk: `remoteChanged=false`, `localChanged=true` | uploads local — server already has same content; new `updatedAt` returned | clean: no banner, no actual data change on remote |
| Pick **local** (local diverges from remote) | same as above | same as above | uploads local — server now reflects user's choice | clean: no banner, remote updated |
| Pick **a true merge** (new content, different from both) | same as above | same as above | uploads local merge | clean: no banner, remote updated |
| Pick local, **and remote moved again mid-merge** | same as above | tracked+on-disk: `remoteChanged=true` (new `updatedAt`), `localChanged=true` → **fresh conflict** | refused (push gate) | banner re-appears with newer remote version; user merges again. Correct behavior — they hadn't seen the latest remote. |

Two side-effects worth knowing:

- **Auto-commit before Claude-triggered push.** When `sync-push.mjs` writes its marker, the app runs `git status` / stage / commit before calling `pushAllEntities`, so HEAD catches up to disk. Without this, picking "remote" leaves the file as a pending git change forever (HEAD has the pre-merge content; disk has the merged content; the engine sees them as in-sync vs remote so push uploads nothing, but git keeps showing "1 modified").
- **Banner clears optimistically.** The marker handler calls `clearConflictsForPrefix(...)` for all five entity prefixes the moment it picks up the request. If the pre-push pull genuinely re-detects a conflict (e.g. the "remote moved again" row above), the aggregate repopulates and the banner re-renders.

### Server-delete pass
After the loop: anything still tracked that wasn't in the remote list is a server-side delete. Adapters opt in via `onServerDelete` to also remove the local file (KB does, datastore does); default just drops the manifest entry.

**Pagination guards:**
- `paginationFailed: true` → skip the entire server-delete pass. The truncated list isn't authoritative.
- `unreliableKeyPrefixes: [...]` → skip only manifest keys with these prefixes. Datastore uses this when one collection out of N fails mid-paginate; other collections still reconcile.

---

## Push semantics (per entity)

The pull pipeline is one-size-fits-all; push has a few entity-specific contracts that matter when wiring a new adapter or debugging a "row appeared twice on Pinkfish" report. The story for each:

### KB

**Endpoint:** multipart `POST /filestorage/items/upload`. Stays on multipart because the server's vector-store indexing pipeline runs only in that path — signed-URL upload stores the bytes but doesn't trigger semantic indexing, so KB content wouldn't be searchable.

**Known wart:** the multipart endpoint rewrites filenames with a UUID prefix and creates a new doc per call, so repeated KB pushes accumulate duplicates server-side. The cleanup script at `scripts/cleanup-uuid-duplicates.mjs` is the safety net while a server-side dedupe-by-filename fix is pending.

### Filestore (PIN-5847)

**Endpoint:** `POST /filestorage/items/upload-request` (returns a signed GCS PUT URL) → `PUT <signedUrl>` with the bytes. Same filename in, same filename out (only `formatFileName` sanitization). Same Firestore row on re-upload — no UUID prefix, no duplicates.

**Why split from KB:** filestore doesn't need vector indexing; the signed-URL contract gives clean filename-stable upserts. Validated by `integration_tests/upload-request-contract.test.ts`.

**Cleanup of pre-PIN-5847 UUID duplicates:** `node scripts/cleanup-uuid-duplicates.mjs --apply`.

### Datastore (PIN-5861)

**Endpoint:** `POST /memory/items?collectionId=<id>` with body `{ key, sortField, content }`. The `(collectionId, key, sortField)` triple is the composite identity — POST with the same triple is an upsert, not an insert.

**`sortField` is required for upsert.** A bare POST without `sortField` causes the server to stamp `Date.now()` as the sortField, which never matches anything → every push inserts a new row. This was the bug PIN-5861 fixed; the integration matrix at `integration_tests/datastore-connect-matrix.test.ts` has a control case that pins the server's insert-on-missing-sortField behavior so we'd catch a regression.

How adapters set the composite:

- **Flat (`openit-tickets`, `openit-people`, custom)**: `sortField = key`. The composite degenerates to identity — same key always upserts in place.
- **`openit-conversations`** (nested): `key = ticketId`, `sortField = msgBase`. Many turns under one logical thread, each turn a distinct row by composite. The on-disk hierarchy `databases/conversations/<ticketId>/<msgBase>.json` mirrors the cloud's composite directly — `ticketId` is the folder, `msgBase` is the filename.

**Collection create:** `POST /datacollection/?ifMissing=true`. Server collapses concurrent identical-name creates to one row, returning the same id to both callers. Replaced ~155 lines of client-side cooldown / inflight-dedupe / refetch machinery.

**Push loop structure (`pushAllToDatastoresImpl`):**

1. Pre-fetch the remote collection once (`fetchDatastoreItems` → `/memory/bquery`); build `remoteByComposite` keyed by `${key}#${sortField}`.
2. For each local row: skip if `remoteByComposite` already has identical content (`jsonEqual`); otherwise POST `{ key, sortField, content }`.
3. Deletion-reconcile: any remote composite not present in `localComposites` gets `DELETE /memory/items/id/<r.id>`.
4. Post-push manifest reconcile: re-list the touched collections, write `<col>/<key>` (flat) or `<col>/<key>/<sortField>` (conversations) entries with the server's authoritative `updatedAt`.

**Pull side (`entities/datastore.ts` `listRemote`):** for conversations, derives the per-thread folder from `item.key` (was `content.ticketId`) and the filename from `${item.sortField}.json`. Rows missing `sortField` are warn-and-skipped — a conversation row with no per-turn anchor can't be filed.

### Agents / workflows

Read-only on the OpenIT side today — the wrapper rebuilds the adapter every poll tick to pick up server-side adds/deletes. No push surface.

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

1. Engine detects divergence (either tracked+both-changed or bootstrap-adopt+content-mismatch). It writes the `.server.` shadow, sets `conflict_remote_version` on the manifest entry, and emits the conflict via `subscribeConflicts`.
2. `ConflictBanner` renders a "Resolve in Claude" button. Clicking it pastes the prompt produced by `buildConflictPrompt(conflicts)` into the active Claude session.
3. The prompt walks Claude through every active conflict with four per-conflict actions:
   1. Read canonical and `.server.` shadow.
   2. Auto-merge silently (no field-by-field interrogation, no echoing values — see `scripts/openit-plugin/CLAUDE.md` for the privacy rule).
   3. Delete the shadow.
   4. Run `node .claude/scripts/sync-resolve-conflict.mjs --prefix <p> --key <k>`.
4. After all per-conflict actions, Claude asks the user: *"Sync these changes to Pinkfish now? (yes/no)"*. On **yes**, Claude runs `node .claude/scripts/sync-push.mjs`.
5. The push script writes `.openit/push-request.json` and polls `.openit/push-result.json`.
6. The OpenIT app's fs-watcher picks up the marker, optimistically clears the conflict aggregate (banner disappears), auto-commits any pending working-tree changes, runs `pushAllEntities`, and writes the result file.
7. The script reads the result, prints a JSON summary, exits.

### What each script actually does to the manifest

**`sync-resolve-conflict.mjs`** — looks up the manifest entry for the conflict key:

- If `conflict_remote_version` is present (the standard case after the engine wrote the shadow):
  - Replaces the entry with `{ remote_version: <conflict_remote_version>, pulled_at_mtime_ms: 1 }`.
  - Result: next pull sees `remoteChanged=false` (because we now claim to know the current remote version) and `localChanged=true` (mtime > 1) → push case, no conflict.
- If absent (legacy entry from before the field existed): falls back to deleting the entry. The next pull's bootstrap-adopt then runs content-equivalence to decide. This works for "picked remote" (content matches → adopt clean) but not "picked local" (content differs → conflict re-detected).

**`sync-push.mjs`** — can't push directly because the OAuth runtime token lives in the OS keychain and only the running OpenIT process has it loaded. So it uses a marker file:

- Writes `.openit/push-request.json` with a timestamp + pid.
- Polls `.openit/push-result.json` (250ms cadence, 60s default deadline).
- On result: parses, prints, exits 0/1 based on `status`.
- On timeout: tidies the marker (so a stale request doesn't fire when the app starts later) and exits 1 with `app_not_running`.

The marker handler in `Shell.tsx` runs `pushAllEntities` and writes the result. It's reentrancy-guarded so a rapid-fire second marker doesn't queue a second push.

The script step (sync-resolve-conflict) is required — without it, the engine has no signal that the merge happened and would re-create the shadow on the next poll. The prompt is structured (atomic-4-step blocks per conflict, bold "REQUIRED" markers) to make this very hard for Claude to skip.

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

Before pushing, `pushAllEntities` runs a fresh per-entity pull to surface any conflicts created since the last poll. If the pull returns `{ ok: false, ... }` (silent failure) or surfaces conflicts, the push is blocked for that entity. This is what prevents user A from silently overwriting user B's edit. Both entry points share this:

- **Sync-tab Commit button** → `handleCommit` → `pushAllEntities`.
- **Claude push (`sync-push.mjs`)** → `.openit/push-request.json` marker → `runPushFromMarker` → `pushAllEntities`.

---

## Adding a new entity

1. Write `src/lib/entities/<name>.ts` exporting a function that returns an `EntityAdapter`.
2. Implement the five required methods. Reuse `shadowFilename` / `classifyAsShadow` for shadow handling.
3. Wrap with `startPolling` (or `startReadOnlyEntitySync` if there's no per-item bootstrap).
4. Wire `clearConflictsForPrefix("<name>")` into the wrapper's stop function.
5. Add a vitest case that mirrors the canonical "two-user conflict" test in `syncEngine.test.ts`.

The shorter the adapter, the better. If you find yourself writing diff logic, you're probably duplicating the engine.
