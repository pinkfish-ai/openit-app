---
name: deploy
description: Push local changes (knowledge base, filestore, database rows) to Pinkfish. Runs the engine's pre-push pull guard and reports per-entity counts.
---

## What this does

Triggers a push of every bidirectional entity (KB, filestore, datastore) from local disk to Pinkfish. Behind the scenes it writes a marker file that the running OpenIT app picks up; OpenIT runs the same pipeline as the **Sync** button — pre-pull each entity to surface conflicts before clobbering, then push.

## How to run it

```bash
node .claude/scripts/sync-push.mjs
```

The script blocks until the push finishes (or 60s timeout, configurable with `--timeout <seconds>`). Stdout is one JSON line:

- Success: `{"ok": true, "status": "ok", "lines": [...]}` — `lines` is the per-step push log.
- Error: `{"ok": false, "status": "error", "error": "...", "lines": [...]}` — exit code 1.
- App not running: `{"ok": false, "error": {"code": "app_not_running", ...}}` — OpenIT didn't pick up the marker. Tell the user to open OpenIT or click Sync to Pinkfish manually.

## When to refuse / redirect

- If the pre-push pull surfaces conflicts (`lines` contains "pull surfaced conflicts"), DON'T retry the push. Direct the user to resolve the conflicts first via the **resolve-sync-conflict** skill, then deploy again.
- If the user asks you to push but OpenIT isn't running and they can't open it, explain the limitation — direct push from Claude requires the app for credential reasons.

## What to say to the user

After a successful run, tell them what landed at the row/file level using plain language (see CLAUDE.md "How to talk to me about changes"). Don't dump the raw `lines` array — pull out the meaningful counts:

```
Pushed to Pinkfish:
  - 1 row updated in the People database
  - filestore: nothing new
  - knowledge base: nothing new
```
