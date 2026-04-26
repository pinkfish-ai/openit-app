# OpenIT plugin (dev source)

This directory holds the **dev source of truth** for the Claude plugin OpenIT ships:

- **`CLAUDE.md`** — project-level rules Claude Code reads when running inside an OpenIT project. Lands at `~/OpenIT/<orgId>/CLAUDE.md` (project root).
- **`*.mjs` scripts** — Node scripts Claude can call. Land at `~/OpenIT/<orgId>/.claude/scripts/<script>.mjs`.

Production users get this content via the plugin manifest published from `/web/packages/app/public/openit-plugin/`. We develop and test against these files here so they version with the engine they integrate with; the cross-repo cp happens at PR-merge time.

## Dev loop

1. Edit `scripts/openit-plugin/<file>` here.
2. Copy to your test org so you can actually run/read it:
   - Scripts: `cp scripts/openit-plugin/<script>.mjs ~/OpenIT/<orgId>/.claude/scripts/<script>.mjs`
   - CLAUDE.md: `cp scripts/openit-plugin/CLAUDE.md ~/OpenIT/<orgId>/CLAUDE.md`
3. Test from inside the project root.
4. Iterate.
5. When stable, copy to `/web/packages/app/public/openit-plugin/` (mirrors path: scripts go in `scripts/`, CLAUDE.md at the root). Bump `manifest.json` version. Push `/web`.

A reconnect from OpenIT then pulls the new versions down to every user's project.

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
