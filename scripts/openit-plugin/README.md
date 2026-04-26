# OpenIT plugin scripts (dev source)

These are the Node scripts that ship with the OpenIT Claude plugin. Production users get them at `~/OpenIT/<orgId>/.claude/scripts/` via the plugin manifest published from `/web/packages/app/public/openit-plugin/scripts/`.

This directory is **the dev source of truth in the openit-app repo** — the plugin scripts ultimately live cross-repo in `/web`, but we develop and test against them here so they version with the engine they integrate with.

## Dev loop

1. Edit `scripts/openit-plugin/<script>.mjs` here.
2. Copy to your project's `~/OpenIT/<orgId>/.claude/scripts/<script>.mjs`.
3. Test from inside the project root: `node .claude/scripts/<script>.mjs <args>`.
4. Iterate.
5. When stable, copy the file to `/web/packages/app/public/openit-plugin/scripts/`, bump `manifest.json` version in `/web`, push.

A reconnect from OpenIT then pulls the new version down to every user's `~/OpenIT/<orgId>/.claude/scripts/`.

## Constraints (apply to every script)

- **Node 18+ built-ins only.** No npm dependencies — keeps the plugin lightweight and avoids `node_modules/` in user project folders.
- **Stdout: one trailing JSON line.** Even on error. Allows OpenIT (or any caller) to parse without dealing with interleaved stderr.
- **Stderr: human-readable progress.** Format-matches the modal sync log when reasonable.
- **Idempotent.** Running the same script twice with the same args should produce the same end state.
- **No HTTP unless required.** Manifest mutations are local JSON; only reach for the network when there's no other way.

## Scripts

### sync-resolve-conflict.mjs

Clears a stuck conflict banner after Claude (or the user) has merged the canonical and deleted the `.server.` shadow.

```
node .claude/scripts/sync-resolve-conflict.mjs --prefix datastore --key openit-people-XXX/row-YYY
```

Prefix maps to a manifest file:

| prefix | manifest file |
|---|---|
| `kb` | `.openit/kb-state.json` |
| `filestore` | `.openit/fs-state.json` |
| `datastore` | `.openit/datastore-state.json` |
| `agent` | `.openit/agent-state.json` |
| `workflow` | `.openit/workflow-state.json` |

The script just deletes the manifest entry for `<key>`. The engine's next poll bootstrap-adopts the on-disk file with the current remote version, which clears the conflict.

### sync-push.mjs

Asks the running OpenIT app to push every bidirectional entity (KB, filestore, datastore) to Pinkfish. Used at the end of a conflict-resolve flow so the merged content actually lands on the server.

```
node .claude/scripts/sync-push.mjs [--timeout <seconds>]
```

The script can't push directly — the OAuth runtime token lives in the OS keychain and is only loaded into memory by the OpenIT app. So instead it writes `.openit/push-request.json`; OpenIT's fs watcher sees the marker, runs `pushAllEntities`, and writes `.openit/push-result.json` back. The script polls the result, prints a JSON summary, and exits.

Exit codes: `0` on success, `1` on push error or timeout (most often `app_not_running` — i.e., the user has OpenIT closed; tell them to open it or click Sync to Pinkfish manually).

The conflict prompt instructs Claude to call this **once**, after all per-conflict resolves are done and the user has confirmed the sync.
