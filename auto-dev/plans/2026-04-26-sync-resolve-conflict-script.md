# sync-resolve-conflict.mjs — first plugin script Claude can call

**Date:** 2026-04-26
**Status:** Drafting. Stacked on PR #17 (`feat/conflict-resolve-in-claude`).

## Brief

Today the conflict banner is sticky: even after Claude merges and deletes the shadow file, the next 60 s engine poll re-detects both sides as changed (canonical mtime past manifest, remote `updatedAt` still differs from manifest's `remote_version`) → it writes the shadow back and re-records the conflict. The user has no way to acknowledge "I've consolidated the remote changes into my canonical".

This is the first concrete entry point for the Phase 0 substrate vision: **a Node script Claude calls to write to the manifest.** The script is what tells the engine "this conflict is resolved." Banner clears on the next poll.

## Why a script (not a Tauri command)

- Same code path Claude in a vanilla terminal would use — no OpenIT-only logic.
- The plugin manifest already has the delivery mechanism (`~/OpenIT/<orgId>/.claude/scripts/`).
- Scripts can be edited in place during dev, copied back to `/web` when ready.
- Sets the precedent for the rest of Phase 0 (`sync-pull.mjs`, `sync-push.mjs`, `sync-status.mjs`).

## Scope (this PR)

- One script: `sync-resolve-conflict.mjs`.
- One CLI shape: `--prefix <kb|filestore|datastore|agent|workflow> --key <manifestKey>`.
- One thing it does: advance `remote_version` for that manifest entry to the current remote `updatedAt`.
- Update `buildConflictPrompt` so the prompt tells Claude to run the script as the final merge step.
- Doc: how to copy the script into `~/OpenIT/<orgId>/.claude/scripts/` for testing; how to land it in `/web` later.

Out of scope: full Phase 0 (no `sync-pull.mjs` / `sync-push.mjs` yet, no Tauri spawn-and-stream invoker, no migration). Strict additive change.

## Where the script lives

Long-term home: `/web/packages/app/public/openit-plugin/scripts/sync-resolve-conflict.mjs`. During dev this PR keeps a tracked source-of-truth copy at:

```
openit-app/scripts/openit-plugin/sync-resolve-conflict.mjs
```

Reasoning: the `/web` copy is what users get; the openit-app copy is what we develop against and ship to `/web` once stable. The path mirrors the production layout so the eventual cp is mechanical.

A short README at `openit-app/scripts/openit-plugin/README.md` documents the dev loop:
1. Edit `openit-app/scripts/openit-plugin/sync-resolve-conflict.mjs`.
2. Copy to `~/OpenIT/<orgId>/.claude/scripts/sync-resolve-conflict.mjs`.
3. Test with `node ~/OpenIT/<orgId>/.claude/scripts/sync-resolve-conflict.mjs --prefix datastore --key openit-people-XXX/row-YYY`.
4. When stable, copy to `/web/packages/app/public/openit-plugin/scripts/`, bump manifest version, push.

## Algorithm

The script runs from inside the project root (cwd = `~/OpenIT/<orgId>/`). It does only one thing: delete the manifest entry for the resolved key.

1. Parses `--prefix` and `--key` from argv.
2. Reads `.openit/<name>-state.json` — mapping:
   - `kb` → `kb-state.json`
   - `filestore` → `fs-state.json`
   - `datastore` → `datastore-state.json`
   - `agent` → `agent-state.json`
   - `workflow` → `workflow-state.json`
3. `delete manifest.files[<key>]`.
4. Writes the manifest back.
5. Stdout: `{ ok: true, prefix, key, removed: true | false }` (false when no entry existed).
6. Exits 0 on success, 1 on bad input / IO error (with `{ ok: false, error: { code, message } }`).

No HTTP, no token, no env vars, no dependencies. ~20 lines of Node.

## Why deleting the entry works

The engine's pull pipeline already handles `!tracked && localFile` — that's the **bootstrap-adoption** branch from R1 (covered by `syncEngine.test.ts` test #3). It seeds the manifest with the current remote `updatedAt` and the local file's current mtime. Net effect after the script + next poll:

- manifest entry has fresh `remote_version` (matches current remote)
- pulled_at_mtime_ms equals the local file's mtime (so subsequent local edits still register as "to push")
- conflict aggregate's contribution for that key is empty (no `remoteChanged` because remote_version matches)
- shadow stays gone (it was deleted by Claude pre-script)
- banner clears

If the user happens to edit the file between Claude's merge and the next poll, that's fine — bootstrap-adoption sets `pulled_at_mtime_ms` to the file's mtime AT poll time, so an edit after that bumps mtime past it and shows up as a normal push-pending change. (Edits between Claude's save and the script run are also fine — same outcome.)

## Engine side: what does NOT change

The engine doesn't need to know the script exists. The script's only side effect is writing `.openit/<name>-state.json`. Existing engine logic handles the rest.

## Conflict prompt update

`buildConflictPrompt` in `src/lib/syncEngine.ts` currently ends with:

> 5. Write the merged result to the canonical path, then delete the `.server.` shadow file.
> 6. Don't push yet — let me review the diff first.

Add step 7:

> 7. After deleting the shadow, run `node .claude/scripts/sync-resolve-conflict.mjs --prefix <P> --key <K>` for each conflict. This advances the manifest so the banner clears.

The prompt builder needs to include the right `--prefix` and `--key` per conflict, formatted into the step.

## Test plan

- [ ] Manually create a conflict on a datastore row (edit local + remote, wait for poll). Verify banner appears.
- [ ] Run Claude on the prompt → it merges + deletes shadow + runs the script.
- [ ] After script run, banner clears within 60 s on next poll.
- [ ] Run script on a key with no conflict → exits cleanly, no manifest churn.
- [ ] Run script with bad prefix → exits 1 with a clear error.
- [ ] Run script with missing env vars → exits 1 with a clear error.
- [ ] Add a vitest unit test that constructs a manifest with a conflict, runs the same logic in-process (extracted as a helper from the script), asserts manifest advances correctly.

## Checklist

- [ ] `openit-app/scripts/openit-plugin/sync-resolve-conflict.mjs` written
- [ ] `openit-app/scripts/openit-plugin/README.md` with the dev loop
- [ ] Unit test for the manifest-advance helper
- [ ] `buildConflictPrompt` includes the `node .claude/scripts/sync-resolve-conflict.mjs` step
- [ ] Tested end-to-end on a real conflict
- [ ] PR opened, BugBot loop run

## Out of scope (future)

- Tauri spawning the script automatically when banner shows (replaces the prompt → Claude → script chain with a button → script chain). Worth doing once Phase 0's spawn-and-stream invoker exists.
- Full sync-pull.mjs / sync-push.mjs scripts. This PR is the foothold; those follow.
- `/web` plugin manifest update. Manual step until the cross-repo dev loop is more automated.
