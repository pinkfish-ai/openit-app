---
name: resolve-sync-conflict
description: Resolve sync conflicts between local files and Pinkfish. The user's local changes diverged from the server; for each conflicted file, merge canonical + .server. shadow, run the resolve script, then offer to push.
---

## When to use

Invoked when there are sync conflicts to resolve. The caller will name the specific files (canonical + shadow paths). If the caller didn't list them, look for files matching `*.server.*` next to a sibling canonical — those are unresolved conflicts.

## How to think about it

**Don't make me do more work than I have to.** Auto-merge confidently when you can; only stop and ask when a specific field is genuinely ambiguous.

For each conflicted file, the canonical (`<path>`) is the user's local version and the `.server.<ext>` shadow is what's on Pinkfish. Both diverged from the last sync. Decide field-by-field who wins:

- **Only one side changed a field** → take that side's value. Trivial.
- **Both sides changed the same field to different values** → use context: an edit the user just made in this session wins; the other side wins on fields it touched. Recency cues and obvious-correction heuristics (typo fix, more-complete data) are fair game.
- **Genuinely ambiguous** (no contextual cue, both values equally plausible) → stop and ask the user with the field name + both candidate values. Never decide silently.

For non-JSON content:
- **Text/markdown (KB)**: keep meaningful additions from both sides.
- **Binary (filestore PDFs/images)**: can't merge bytes — ask the user which version to keep.
- **Datastore `_schema.json`**: read-only, never touch.
- **Workflows**: only merge draft fields. Never modify `releaseVersion` or anything release-related.

## Format the result

Use the rules in CLAUDE.md ("How to talk to me about changes") — schema labels in plain language (e.g. "email", "name") not field IDs (`f_2`), with before/after values.

```
Resolved Bob's record in the People database:
  - name:  "Bob Edgar"  →  "Bob Edgaring"  (your local edit)
  - email: "alice@a.com"  →  "bob@example.com"  (changed on Pinkfish)
```

## Per-conflict actions

For each conflict (do all four, in order):

1. Read canonical and `.server.<ext>` shadow.
2. Apply the merge logic above; write the merged result to the canonical path.
3. Run the resolve script. The `<prefix>` is one of `kb` / `filestore` / `datastore` / `agent` / `workflow`. The `<key>` is the manifest key — for datastore it's `<colName>/<rowKey>`, otherwise the canonical filename.

   ```bash
   node .claude/scripts/sync-resolve-conflict.mjs --prefix <prefix> --key '<key>'
   ```

   The script also removes the `.server.<ext>` shadow as a defensive cleanup.

## After all conflicts are resolved

Ask the user:

> Sync these changes to Pinkfish now? (yes/no)

On **yes**, run the push:

```bash
node .claude/scripts/sync-push.mjs
```

The script blocks until OpenIT finishes the push and prints `{"ok": true, "status": "ok", ...}` on stdout. Tell the user it landed.

On **no**, leave the merged files on disk; the user can sync later via the Sync tab.
