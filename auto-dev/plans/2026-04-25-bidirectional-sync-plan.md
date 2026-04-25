# Bidirectional sync for all OpenIT entities

**Date:** 2026-04-25
**Status:** Plan, not yet implemented

---

## Table of contents

1. [Goal](#goal)
2. [Vision alignment](#vision-alignment)
3. [Channel selection: when to use which](#channel-selection-when-to-use-which)
4. [Where the sync logic lives](#where-the-sync-logic-lives)
5. [Runtime choice: Node vs platform-specific scripts](#runtime-choice-node-vs-platform-specific-scripts)
5. [Why git-native baseline beats per-entity manifests](#why-git-native-baseline-beats-per-entity-manifests)
6. [Plugin layout](#plugin-layout)
7. [Plugin contract](#plugin-contract)
8. [Authentication and token refresh](#authentication-and-token-refresh)
9. [Pull algorithm](#pull-algorithm)
10. [Push algorithm](#push-algorithm)
11. [Conflict UX: banner + Resolve in Claude](#conflict-ux-banner--resolve-in-claude)
12. [60-second background poll](#60-second-background-poll)
13. [API mapping per entity](#api-mapping-per-entity)
14. [File-system layout](#file-system-layout)
15. [Edge cases investigated](#edge-cases-investigated)
16. [Performance and scale](#performance-and-scale)
17. [Testing strategy](#testing-strategy)
18. [Telemetry and error visibility](#telemetry-and-error-visibility)
19. [Migration from current state](#migration-from-current-state)
20. [Backward compatibility](#backward-compatibility)
21. [Windows specifics](#windows-specifics)
22. [Development workflow](#development-workflow)
23. [Implementation phases](#implementation-phases)
24. [Open questions and risks](#open-questions-and-risks)
25. [Recommended landing order](#recommended-landing-order)

---

## Goal

Every OpenIT-managed entity (databases, agents, workflows, filestore, knowledge base) is bidirectionally synced between the local project folder and Pinkfish. Three loops:

1. **On connect / on app load**: pull anything that has changed remotely since our last sync.
2. **Every 60s**: poll for remote changes; pull non-conflicting ones, surface conflicts to the user via a banner at top — with a button **"Resolve in Claude"** which sends the conflict data to Claude. Claude pulls down the remote version, merges/resolves, commits, and pushes back up.
3. **On user action ("commit & push")**: upload locally edited entities back to Pinkfish.

The user (or Claude in the embedded terminal) edits files freely. **Local git is the sync baseline** — the snapshot at last pull lives in a git ref, not a hand-rolled manifest. The Claude Code plugin (`.claude/` skills + `CLAUDE.md` + `.claude/scripts/`) ships the actual sync logic. The OpenIT Tauri app is a thin shell that invokes those scripts.

The plugin itself is read-only on disk — source-controlled in `web/packages/app/public/openit-plugin/` and synced down on every connect.

---

## Vision alignment

OpenIT's stated thesis (see `CLAUDE.md`): *"scaffolding around Claude Code, not a forked IDE."* The user can graduate to a vanilla terminal at any time without changing the project.

The project vision is that **Claude is the orchestration layer**, capable of:

- **(a) Calling MCPs** — already happening: `knowledge-base`, `filestorage`, `agent-management`, etc.
- **(b) Calling local scripts** — *new* — bash/Node/etc. shipped with the plugin.
- **(c) Triggering Pinkfish workflows** — already a remote concept; Claude composes them.

This plan operationalizes (b) by making sync itself a set of scripts in the plugin. The OpenIT Tauri app and Claude-in-the-terminal both invoke those scripts. There's no separate "OpenIT-only" sync code path. A user without OpenIT, just running Claude in `~/OpenIT/<org>/`, gets the same behavior.

---

## Channel selection: when to use which

Pinkfish exposes the same entities through multiple channels with different trade-offs. The sync engine and Claude both need a clear policy.

### The channels

| # | Channel | Auth | Best for |
|---|---|---|---|
| 1 | **Direct platform REST** (`/automations`, `/user-agents`, `/resources`, `/memory/items`, …) | `Auth-Token: Bearer <runtime-token>` | Canonical CRUD on Pinkfish-owned entities; anything mutating; full shapes; pagination; releases / sharing / billing |
| 2 | **Direct built-in Pinkfish MCPs** (`pinkfish-sidekick`, `agent-management`, `knowledge-base`, `filestorage`, `datastore-structured`, `http-utils`) | Same runtime token via `pinkfishMcpCall` | Specialized read capabilities REST doesn't have (`knowledge-base_ask`, `datastore-structured_natural_query`, `datastore-structured_analytics_query`); cheap list polls; tools that map naturally onto user prompts |
| 3 | **Gateway discover/invoke for third-party MCPs** (Slack, Zendesk, Salesforce, Jira, Okta, GitHub, GCP, AWS, Azure, …) | Same runtime token, routed via `mcp_discover` → `capabilities_discover` → `capability_details` → invoke | All third-party connectors. The gateway resolves *which* connection (per-org, per-account), handles connector OAuth refresh, and routes to the right endpoint. Direct invocation would break for orgs with multiple connections or freshly installed connectors. |
| 4 | **System CLIs** (`gcloud`, `bq`, `az`, `aws`, `kubectl`, `okta`, `gh`) | The user's local credentials | Investigations the native tool already does well. Don't reinvent. |
| 5 | **Local plugin scripts** (`.claude/scripts/*.mjs`) | Whatever they call (REST, MCP, or both internally) | The sync engine itself; conflict resolution; bulk operations the OpenIT app and Claude both invoke. |

### Decision tree

For any operation, walk this in order:

1. **Is it a system-level investigation that a CLI handles well?** (`gcloud iam`, `bq query`, `az ad user show`, `kubectl describe`, `okta users list`) → use the CLI.
2. **Is it a Pinkfish-owned entity?** (agent, workflow, datastore item, KB file, filestore file, resource collection)
   - Mutating, or sync-critical, or needs full shape → **REST** (channel 1).
   - Read-only and benefits from a specialized capability (semantic search, natural-language query, "ask") → **built-in MCP** (channel 2).
3. **Is it a third-party connector?** (Slack, Zendesk, Salesforce, Jira, Okta, GitHub, GitLab, AWS, GCP, Azure, etc.) → **gateway discover/invoke** (channel 3). Never call third-party MCPs directly — they require connection routing.
4. **Is it the OpenIT sync engine itself, or something OpenIT and Claude both run?** → it lives in **plugin scripts** (channel 5), which internally use channels 1–4.
5. **Is the operation a multi-step business automation the user has built?** → invoke the corresponding **Pinkfish workflow**.

### Concrete rules for the sync engine

The sync engine in this plan is opinionated about its channels — it makes the same choice for every entity, every time, so behavior is predictable and bugs are easy to localize:

- **Sync (pull, push, conflict detection): always channel 1 (REST).** REST is the canonical source. Every entity has full CRUD with `updatedAt` and consistent pagination. Mixing in MCP would mean dealing with the shape difference between MCP-flat and REST-deep representations on every diff.
- **Read-only list polls, where REST also works: still channel 1.** No need to mix — uniform code path is worth more than the small latency win MCP would give.
- **Specialized read capabilities Claude exposes to the user via slash commands** (`knowledge-base_ask`, `datastore-structured_natural_query`): channel 2. These have no REST equivalent. They're invoked from skills, not from sync code.
- **Anything touching a third-party SaaS:** channel 3 only. The sync engine never speaks directly to Slack/Zendesk/etc. APIs — it goes through the gateway.

### Concrete rules for Claude (in skills and CLAUDE.md)

When Claude is helping the user (not running sync), the ranking shifts:

- **Investigating?** Try CLI first. `gcloud projects list` beats wiring a GCP MCP for "what projects do I have."
- **Pinkfish entity work?** Built-in MCP for reads (it's the natural surface inside a Claude prompt); REST for writes via the local scripts.
- **Third-party SaaS?** Always discover/invoke. Never assume an integration is connected — `mcp_discover` first.

### Why this matters

Without an explicit policy, code drifts. We've already seen examples in the audit:
- The current TS sync uses a mix: REST for datacollection list, MCP for `agent_list` and `workflow_list`. That's why agents/workflows don't have `updatedAt` — MCP doesn't expose it consistently. Fixing this means moving to REST for sync.
- The current `DeployButton.tsx` shells out to a `pinkit` CLI which is yet another channel. That's fine for now (it does environment-publish, not entity sync), but it shouldn't expand without a clear reason.

The strategy lets us answer "where does this call belong?" without rediscovering the trade-offs every time.

---

## Where the sync logic lives

**The sync engine ships in the plugin.** Specifically as cross-platform scripts in `.claude/scripts/` (synced from `web/packages/app/public/openit-plugin/scripts/`).

Three top-level entry points:

```
node .claude/scripts/sync-pull.mjs      [--entity X] [--quiet]
node .claude/scripts/sync-push.mjs      [--entity X] [--quiet]
node .claude/scripts/sync-status.mjs    # read-only conflict probe
```

Both the OpenIT Tauri app *and* Claude (running `/resolve-sync-conflicts`) invoke these. Single source of truth for sync semantics.

### What stays in the OpenIT Tauri app

- Modal connect (unchanged).
- Embedded Claude Code terminal (unchanged).
- File explorer + viewers (unchanged).
- Sync triggers:
  - On connect → spawn `sync-pull.mjs`, stream output to modal log, parse JSON result.
  - 60s timer → same.
  - "Commit & push" button → spawn `sync-push.mjs`.
- Conflict banner: subscribes to a small `useConflictStore` fed by the parsed JSON results. Renders count + "Resolve in Claude" button that types `/resolve-sync-conflicts` into the embedded terminal.
- File explorer / Sync tab status (existing — `git status` rendered as UI).

The Tauri app shrinks substantially. `kbSync.ts` (~600 lines) and `filestoreSync.ts` (~570 lines) become ~50-line shells that exec the script and stream output.

### What moves to the plugin

- All sync logic (pull, push, conflict detection, three-way merge).
- The conflict-resolution skill (`skills/resolve-sync-conflicts.md`).
- A new `CLAUDE.md` section: *"How sync works in this project."*

---

## Runtime choice: Node vs platform-specific scripts

You raised the option of **separate scripts for Mac and Windows** (e.g. `.sh` for Unix, `.ps1` for Windows). That's viable. Comparing it to **one Node `.mjs` file**:

| Dimension | One Node `.mjs` | Separate `.sh` + `.ps1` |
|---|---|---|
| Runtime requirement on user's machine | `node` (already required by Claude Code; v18+) | `bash` *and* `pwsh`, OR ship two implementations the user must keep in sync mentally |
| Lines of code | One implementation per entity | Two implementations per entity (or one + thin platform shim) |
| Drift risk | None — same file runs everywhere | High — bug fix has to land in both files |
| JSON handling | `JSON.parse`, native | `jq` on Unix; `ConvertFrom-Json` on Windows |
| HTTP | Built-in `fetch` (Node 18+) | `curl` on Unix; `Invoke-RestMethod` on Windows |
| Three-way merge | shell out to `git merge-file` from Node | shell out to `git merge-file` from each variant |
| Path handling | `node:path` is platform-aware | Hand-coded per platform |
| Debugging | One language | Two; reproducing Windows bugs from Mac is painful |
| Distributable size | Smaller (`.mjs` only) | Two flavors |
| Onboarding for contributors | Familiar JS/TS for any web dev | Need to know both `bash` and PowerShell |
| Performance difference | Negligible — sync is not a hot path | Negligible |

**Conclusion: one Node `.mjs` is materially better.** The dual-script approach is technically possible but doubles maintenance cost, doubles bug surface, and creates real "works on Mac, broken on Windows" risk every time a script changes.

The only argument for dual scripts is "no Node dependency" — but Claude Code itself is a Node CLI distributed via npm. Wherever Claude Code runs, `node` runs. So the prereq is already there.

**Decision: Node `.mjs` scripts.** All sections below assume this.

If we ever discover a hard Windows blocker that Node can't address, we have a clean fallback: keep the algorithm in Node, write one tiny PowerShell wrapper that just `node`s the same script. That's still better than two full implementations.

---

## Why git-native baseline beats per-entity manifests

The original direction tracked sync state in `.openit/<entity>-state.json` files (per-file mtime + last-known remote version). That predates the `sync: pull` auto-commit (added in `d76b853`). Now that every pulled file lands in a git commit, the repo itself can answer most of what the manifest used to.

### Git-native lookup table

| Question | Old (per-entity manifest) | New (git-native) |
|---|---|---|
| "Did the user edit file X since last pull?" | `mtime > pulled_at_mtime_ms` | `git diff refs/openit/last-pull -- X` is non-empty |
| "What files do I need to push?" | iterate manifest, mtime check each | `git diff refs/openit/last-pull..HEAD --name-only -- <entity-dirs>` |
| "What was the remote content at last pull?" | not tracked (only timestamps) | `git show refs/openit/last-pull:<path>` |
| "Did the remote change since last pull?" | `remote.updated_at != manifest.remote_version` | same — **still need a small timestamp map** |
| "How do I three-way merge?" | hand-rolled `.server.<file>` shadow | `git merge-file` against `refs/openit/last-pull:<path>` as base |
| "Audit trail" | n/a | `git log` (already there) |
| "Multi-machine reconciliation" | n/a | each machine has own ref; Pinkfish API timestamps reconcile across users |

### The one thing git can't do cheaply

**Detect remote changes without downloading.** Pinkfish list endpoints return `updated_at` per item — that's free. Hashing remote content every 60s would burn bandwidth. So we keep one tiny artifact:

```jsonc
// .openit/sync-timestamps.json (gitignored)
{
  "datastore:databases/openit-tickets-…/CS001.json": "2026-04-25T18:31:00Z",
  "filestore:filestore/runbook.pdf":                 "2026-04-24T09:11:00Z",
  "kb:knowledge-base/intro.md":                      "2026-04-23T22:05:00Z",
  "agent:agents/triage.json":                        "2026-04-22T14:00:00Z",
  "workflow:workflows/escalate.json":                "2026-04-22T14:00:00Z"
}
```

One flat map across all entities. Replaces every per-entity manifest.

### The git ref

After every successful pull or push, fast-forward `refs/openit/last-pull` to current `HEAD`. That ref *is* the sync baseline.

```
HEAD ─── (user edit 1) ─── (user edit 2) ─── (user edit 3) ◄── HEAD
                                                   ▲
refs/openit/last-pull ─────────────────────────────┘
                                                   (advanced after every successful sync)
```

Push diff = `refs/openit/last-pull..HEAD`. Pull baseline for merging = `refs/openit/last-pull:<path>`. Three-way merge = `git merge-file <local> <base=refs/openit/last-pull:path> <remote-just-downloaded>`.

A user can run `git diff refs/openit/last-pull` at any time to see what they're about to push. Not cosmetic — a real, debuggable state model.

---

## Plugin layout

```
web/packages/app/public/openit-plugin/
├── manifest.json                         # gains a "scripts" array + version bump
├── CLAUDE.md                             # gains a "How sync works" section
├── skills/
│   ├── … (existing 14 skills)
│   └── resolve-sync-conflicts.md         # NEW — instructions for the conflict skill
└── scripts/                              # NEW — the sync engine
    ├── sync-pull.mjs                     # entry point
    ├── sync-push.mjs                     # entry point
    ├── sync-status.mjs                   # read-only probe
    ├── package.json                      # declares Node 18+, no deps (uses built-ins)
    ├── README.md                         # for users who graduate to vanilla terminal
    └── lib/
        ├── auth.mjs                      # client-credentials → access token, with refresh
        ├── api/
        │   ├── datacollection.mjs        # /datacollection/ list/create/get
        │   ├── memory.mjs                # /memory/bquery list, /memory upsert/delete
        │   ├── filestorage.mjs           # filestorage_list_items, upload, signed URLs
        │   ├── kb.mjs                    # knowledge-base MCP wrappers
        │   ├── agents.mjs                # agent-management MCP wrappers
        │   └── workflows.mjs             # workflow MCP wrappers
        ├── git.mjs                       # `git diff/show/merge-file/update-ref` shellouts
        ├── merge.mjs                     # three-way merge + conflict shadow drop
        ├── timestamps.mjs                # read/write `.openit/sync-timestamps.json`
        ├── lock.mjs                      # advisory lock for serialized sync
        ├── log.mjs                       # stderr formatter to match modal log style
        ├── pull.mjs                      # generic pullEntity({ list, write }) engine
        ├── push.mjs                      # generic pushEntity({ apiUpsert, apiDelete }) engine
        └── entities/
            ├── kb.mjs                    # adapter: list/write/upsert/delete
            ├── filestore.mjs             # adapter
            ├── datastore.mjs             # adapter
            ├── agent.mjs                 # adapter
            └── workflow.mjs              # adapter
```

**Key invariants:**
- Scripts are **read-only on the user's disk**. `.claude/scripts/` is gitignored from the entity push diff (so users can't accidentally push edits to scripts back to Pinkfish), and the sync engine refuses to recognize `.claude/` as an entity root.
- Plugin manifest version bumps when scripts change. OpenIT pulls the new manifest on every connect → scripts auto-update. Sync semantics evolve in the web repo without an OpenIT release.
- Zero external npm dependencies in the scripts. Built-in `fetch`, `node:fs/promises`, `node:path`, `node:child_process`, `node:crypto` only. Reasoning: avoiding a `node_modules/` install in every user's project folder. Keeps the plugin lightweight; keeps offline use possible.

---

## Plugin contract

Strict contract between OpenIT (the invoker) and the scripts.

### Inputs (env vars)

```
PINKFISH_CLIENT_ID
PINKFISH_CLIENT_SECRET
PINKFISH_ORG_ID
PINKFISH_TOKEN_URL
OPENIT_REPO              # absolute path to ~/OpenIT/<orgId>
OPENIT_LOG_FORMAT        # "modal" (default) or "plain" — controls stderr style
```

A user running scripts in a vanilla terminal sets these once (e.g. via `direnv` or an `.envrc` in the repo root, gitignored).

### Args

```
sync-pull.mjs   [--entity datastore|filestore|kb|agent|workflow]   [--quiet]   [--no-poll-mode]
sync-push.mjs   [--entity X]   [--quiet]   [--dry-run]
sync-status.mjs (no args)
```

`--quiet` suppresses stderr log lines (used by the 60s poll to avoid spamming the modal). `--dry-run` on push prints what would be uploaded without making API calls.

### Stdout: structured JSON, final line

```jsonc
{
  "ok":         true,
  "phase":      "pull" | "push" | "status",
  "ts":         "2026-04-25T18:31:00Z",
  "duration_ms": 423,
  "results": [
    {
      "entity":   "kb",
      "pulled":   [{ "path": "knowledge-base/intro.md", "from": "v1", "to": "v2", "bytes": 1245 }],
      "pushed":   [],
      "skipped":  [{ "path": "knowledge-base/runbook.md", "reason": "unchanged" }],
      "deleted":  [],
      "errors":   [],
      "conflicts":[
        {
          "path":   "knowledge-base/triage.md",
          "kind":   "text-merge-failed",
          "shadow": "knowledge-base/triage.server.md",
          "base_ref": "refs/openit/last-pull",
          "summary": "1 hunk conflicted; user added section A, remote replaced section B"
        }
      ]
    }
    // … one entry per entity
  ],
  "totals": { "pulled": 1, "pushed": 0, "skipped": 1, "conflicts": 1, "deleted": 0 }
}
```

Single trailing JSON line is parseable even when stderr is interleaved. The script always emits a JSON summary, even on fatal error (`ok: false`, `error: { code, message }`).

### Stderr: human-readable log, line-by-line

```
▸ datastores
  ✓ openit-people-…  (id: ZPe…)
  ✓ openit-tickets-…  (id: 5Ue…)
    2 collection(s), 20 item(s) — 22 file(s) written
▸ filestores
  ✓ openit-docs-…  (id: 78p…)
    1 collection(s), 1 file(s) on remote — 0 downloaded
…
```

Format matches the modal sync log already in production. OpenIT pipes stderr line-by-line into `addLog`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean — no conflicts, no errors. |
| 1 | Conflicts present. Pull/push completed for non-conflicting items. JSON enumerates conflicts. |
| 2 | Partial failure — at least one entity errored, others succeeded. JSON enumerates errors per entity. |
| 3 | Fatal — auth failure, no network, stale plugin scripts, etc. JSON has `ok: false, error`. |
| 4 | Lock contention — another sync is in progress. Retry later. |

### Concurrency

Scripts acquire `.openit/.sync.lock` (advisory, mkdir-based, removed on exit including SIGINT). Polling that finds the lock held exits with code 4 and the app skips the tick. User-triggered pushes that find the lock retry once after 2s, then surface a "sync already in progress" toast.

---

## Authentication and token refresh

OAuth client-credentials flow:

1. Script reads `PINKFISH_CLIENT_ID` / `PINKFISH_CLIENT_SECRET` / `PINKFISH_TOKEN_URL` from env.
2. POSTs to `PINKFISH_TOKEN_URL` with `grant_type=client_credentials`, gets back an access token + `expires_in`.
3. Caches token in memory for the duration of one script invocation only. (Long-running poll scripts re-acquire on each invocation; not a problem since polls are 60s apart and tokens last 1h+.)
4. If a request returns 401 mid-script, re-auths once and retries; on second 401 fails the entity and continues to next entity.

**No persistent token file.** Each script invocation is short-lived and gets its own token. Avoids a security surface (token-on-disk) and avoids stale-token bugs.

OpenIT Tauri app also uses client credentials — already loaded via `loadCreds`. Tauri sets the env vars when spawning the script. Vanilla-terminal users set them themselves.

**Token refresh during long pull/push:** for a sync that takes > 1 hour (unlikely but possible with a huge filestore), the script would hit a 401 mid-stream. We catch and re-auth transparently. Verified by integration tests (synthetic clock).

---

## Pull algorithm

```js
// scripts/lib/pull.mjs
async function pullEntity({ prefix, list, write, dirs }) {
  const items = await list();                      // [{ path, updatedAt, fetchContent, remoteId? }]
  const ts    = await readTimestamps();
  const result = { entity: prefix, pulled: [], skipped: [], deleted: [], conflicts: [], errors: [] };

  for (const item of items) {
    try {
      const tsKey = `${prefix}:${item.path}`;
      if (ts[tsKey] === item.updatedAt) {
        result.skipped.push({ path: item.path, reason: "unchanged" });
        continue;
      }

      const baseExists = await git.refHasPath("refs/openit/last-pull", item.path);
      const localDirty = await git.isDirtyAgainst("refs/openit/last-pull", item.path);
      const remote = await item.fetchContent();

      if (!baseExists && !localDirty) {
        await write(item.path, remote);
        result.pulled.push({ path: item.path, from: null, to: item.updatedAt });
      }
      else if (baseExists && !localDirty) {
        await write(item.path, remote);
        result.pulled.push({ path: item.path, from: ts[tsKey], to: item.updatedAt });
      }
      else if (!baseExists && localDirty) {
        // both created same path independently
        result.conflicts.push({ path: item.path, kind: "both-created" });
        await writeShadow(item.path, remote);
      }
      else {
        // standard 3-way merge
        const base   = await git.show("refs/openit/last-pull", item.path);
        const local  = await fs.readFile(item.path);
        const merged = await git.mergeFile({ local, base, remote, label: item.path });
        if (merged.clean) {
          await write(item.path, merged.text);
          result.pulled.push({ path: item.path, from: ts[tsKey], to: item.updatedAt });
        } else {
          await writeShadow(item.path, remote);
          result.conflicts.push({
            path: item.path,
            kind: "text-merge-failed",
            shadow: shadowPath(item.path),
            summary: merged.summary
          });
        }
      }
      ts[tsKey] = item.updatedAt;
    } catch (e) {
      result.errors.push({ path: item.path, message: e.message });
    }
  }

  // server-side deletions: tracked but not in list
  const remoteSet = new Set(items.map(i => i.path));
  for (const key of Object.keys(ts)) {
    if (!key.startsWith(`${prefix}:`)) continue;
    const path = key.slice(prefix.length + 1);
    if (remoteSet.has(path)) continue;

    const localDirty = await git.isDirtyAgainst("refs/openit/last-pull", path);
    if (localDirty) {
      result.conflicts.push({ path, kind: "remote-deleted-local-edited" });
    } else {
      try { await fs.rm(path); } catch {}
      delete ts[key];
      result.deleted.push({ path });
    }
  }

  await writeTimestamps(ts);
  if (result.pulled.length || result.deleted.length) {
    await git.add(dirs);                            // scoped add
    await git.commit(`sync: pull @ ${new Date().toISOString()}`);
    await git.updateRef("refs/openit/last-pull", "HEAD");
  }
  return result;
}
```

Same algorithm for every entity. Each entity provides only `list()`, `write()`, and the dir(s) it owns.

### Pull modes

- **Initial** (first connect, timestamps map empty) — every item is "new", everything gets downloaded. Big but expected.
- **Steady-state poll** (every 60s) — most items skip via timestamp match; only changed ones touch disk and git.
- **Force-refresh** (user clicks "↻" in file explorer) — clears timestamps for the targeted entity, re-pulls everything. Treated like initial.

---

## Push algorithm

```js
// scripts/lib/push.mjs
async function pushEntity({ prefix, apiUpsert, apiDelete, dirs }) {
  // pre-push pull so we don't clobber teammates
  const pullResult = await pullEntity({ prefix, /* same adapter */ });
  if (pullResult.conflicts.length) {
    return { entity: prefix, error: "conflicts blocking push", conflicts: pullResult.conflicts };
  }

  const changed = await git.diffNames("refs/openit/last-pull", "HEAD", dirs, "AM");
  const deleted = await git.diffNames("refs/openit/last-pull", "HEAD", dirs, "D");
  const ts = await readTimestamps();
  const result = { entity: prefix, pushed: [], deleted: [], errors: [] };

  for (const path of changed) {
    try {
      const content = await fs.readFile(path);
      const { remoteUpdatedAt } = await apiUpsert(path, content);
      ts[`${prefix}:${path}`] = remoteUpdatedAt;
      result.pushed.push({ path, to: remoteUpdatedAt });
    } catch (e) {
      result.errors.push({ path, message: e.message });
    }
  }
  for (const path of deleted) {
    try {
      await apiDelete(path);
      delete ts[`${prefix}:${path}`];
      result.deleted.push({ path });
    } catch (e) {
      result.errors.push({ path, message: e.message });
    }
  }

  await writeTimestamps(ts);
  if (result.pushed.length || result.deleted.length) {
    await git.commit(`sync: push @ ${new Date().toISOString()}`, { allowEmpty: true });
    await git.updateRef("refs/openit/last-pull", "HEAD");
  }
  return result;
}
```

Push is short because git supplies the diff. No mtime arithmetic. No manifest crawl.

### Pre-push pull is mandatory

Always pull before push. If conflicts emerge, push aborts with `code 1`, banner shows. Prevents the "I just clobbered my teammate's edit" failure mode.

### Partial-success semantics

If item N fails to upload but items 1..N-1 succeeded, we still record their new timestamps and still bump the git ref to HEAD. The failed item shows up in `errors[]`; the user retries. No all-or-nothing rollback (that would require server-side transactions we don't have).

### Deleted-locally semantics

A file in `refs/openit/last-pull` but missing in HEAD = locally deleted = should delete on remote. Tracked via `git diff --diff-filter=D`. Push calls `apiDelete`. If the API doesn't support delete (or the entity is workflows where delete is dangerous), the adapter throws a clear error and the file stays in the diff (next push tries again).

---

## Conflict UX: banner + Resolve in Claude

When pull (interactive or 60s poll) records any conflicts, the OpenIT app surfaces a banner pinned to the top of the shell:

> **⚠ N sync conflict(s).** Local edits diverge from Pinkfish on `databases/openit-tickets-…/CS001.json` and 2 other files.   **[Resolve in Claude]**   [Dismiss]

### "Resolve in Claude" button flow

1. Reads the latest `sync-status.mjs` JSON output (the script is idempotent and cheap; we re-run it for fresh state when the button is clicked).
2. Composes a prompt like:
   ```
   /resolve-sync-conflicts
   ```
3. Pastes that into the embedded Claude Code terminal as if the user typed it.

### The skill: `skills/resolve-sync-conflicts.md`

```markdown
---
name: resolve-sync-conflicts
description: Three-way-merge the user's local edits against incoming Pinkfish changes when sync detected conflicts. Reads sync-status, walks each conflict, proposes merges, and pushes back up.
---

When the user invokes `/resolve-sync-conflicts`:

1. Run `node .claude/scripts/sync-status.mjs` to get the conflict bundle.
2. For each conflict in `results[].conflicts[]`:
   - Read the local file at `path`.
   - Read the remote at `shadow` (the `.server.<ext>` shadow file dropped by sync-pull).
   - Read the base via `git show refs/openit/last-pull:<path>`.
   - For text formats (md, json, txt): propose a merge. Show the user a diff. Ask: "Apply this merge?"
   - For binary (PDF, image): you can't merge bytes. Ask the user "keep local, take remote, or rename one?"
3. Once the user confirms each:
   - Write the merged content to `path`.
   - Delete the shadow file.
4. After all conflicts are resolved, run `node .claude/scripts/sync-push.mjs` to push the merged versions and clear the banner.

If the user wants to defer, that's fine — just exit. The banner stays until conflicts are resolved.

Patterns to keep in mind:
- JSON conflicts often look uglier than they are; sort keys + reformat after merge.
- Datastore row schemas are in `databases/<col>/_schema.json` — cross-reference field IDs.
- Never commit + push without showing the diff first.
```

### Banner state lifecycle

- **Created**: by any pull (interactive or background) that yields conflicts. The store accumulates across entities; banner shows aggregate count.
- **Refreshed**: each `sync-status.mjs` run replaces the store contents. Conflicts that were resolved (shadow deleted, file matches base) are dropped automatically.
- **Cleared**: when `sync-status.mjs` reports zero conflicts.
- **Dismissed (manually)**: user clicks "Dismiss" — banner hides for this session but reappears on next conflict-producing sync.

### Shadow file naming

`<basename>.server.<ext>` next to the local file. Matches existing KB convention. Gitignored line in `.gitignore`: `*.server.*` (already present per `git_ops.rs:10`).

For binary entities (filestore PDFs/images), shadow contains the remote bytes verbatim — Claude can't diff bytes but can prompt the user to pick one.

---

## 60-second background poll

OpenIT's Tauri side owns the timer. Each tick:

1. Check `.openit/.sync.lock`. If locked, skip this tick.
2. Spawn `node .claude/scripts/sync-pull.mjs --quiet`.
3. Parse JSON result. Update conflict store. Update Sync tab "last synced" timestamp.
4. If `ok: false` → record error, surface a small toast, don't spam.

The poll never pushes. Pushes only happen on explicit user action (Sync button, or Claude running `sync-push.mjs`).

### Why poll instead of webhooks?

Pinkfish doesn't (currently) push events to clients. Even when it does, polling is the resilient floor — works behind firewalls, no socket lifecycle to manage. A future webhook layer just shrinks the typical poll interval; the algorithm stays the same.

### Per-entity vs aggregate poll

A single poll runs all five entities sequentially. Reasoning: simpler logging (one banner, one log section), one lock acquisition, one git commit at the end. The script could parallelize per-entity, but the bottleneck is the API not concurrency. Sequential is fine.

If one entity fails (e.g. the agents API is down), others still complete. Failed entity reports in `results[].errors[]`.

---

## API mapping per entity

The audit (2026-04-25) confirmed the surface. Per the channel-selection rules, **the sync engine uses REST exclusively**. MCP tools are reserved for specialized reads in skills, not sync. This resolves the previous unknowns about `updatedAt` on `agent_list` / `workflow_list` — those MCP tools don't expose it consistently, but their REST equivalents do.

### Datastores (memory items inside `datastore`-type collections)
- **List items** ✓ — `GET /memory/bquery?collectionId=…&limit&offset` → `MemoryItem[]` with `id, key, content, updatedAt, createdAt`.
- **Create item** ✓ — `POST /memory/items` with `MemoryCreateItemRequest` `{ key, content, … }`.
- **Update item** ✓ — `PUT /memory/items/{id}` (full replace) or `PATCH /memory/items/{id}` (partial). Sync uses **PUT** (deterministic, "file is the truth").
- **Delete item** ✓ — two distinct routes:
  - by id: `DELETE /memory/items/id/{id}` (note the `/id/` segment — different from PUT's `/memory/items/{id}`)
  - by key: `DELETE /memory/items/{key}`
  Sync uses **delete-by-id** (we always have the id from the prior list).
- **Auth header**: `Auth-Token: Bearer <token>`.

### Agents
- **List** ✓ — `GET /user-agents` returns full agents with `updatedAt`. (Replaces our current MCP `agent_list` use, which omits `updatedAt`.)
- **Get** ✓ — `GET /user-agents/{userAgentId}`.
- **Create** ✓ — `POST /user-agents` with `PinkfishModelsUserAgent`.
- **Update** ✓ — `PUT /user-agents/{userAgentId}`.
- **Delete** ✓ — `DELETE /user-agents/{userAgentId}`.
- **Auth header**: `Authorization: Bearer <token>`.

### Workflows (called "automations" in REST, "workflows" in MCP — same entities)
- **List** ✓ — `GET /automations` with `updatedAt`. (Replaces our current MCP `workflow_list` use.)
- **Get** ✓ — `GET /automations/{automationId}`.
- **Create** ✓ — `POST /automations`.
- **Update** ✓ — `PUT /automations/{automationId}`.
- **Delete** ✓ — `DELETE /automations/{automationId}`.
- **Caveat — release vs draft.** Workflows have a draft (`releaseVersion: -1`) plus immutable releases (`1, 2, …`). Sync targets the **draft**; releases are explicit user actions via `POST /automations/{id}/release`. The plan does **not** auto-release on push — drafting is reversible, releasing is not. Document in CLAUDE.md so Claude doesn't auto-release either.
- **Caveat — UI authorship.** Workflows are also edited in the Pinkfish web UI. Wholesale PUT could clobber concurrent UI edits. Mitigated by the standard pre-push pull + 3-way merge in the engine; if conflicts can't merge cleanly, the banner flow surfaces them.
- **Auth header**: `Authorization: Bearer <token>`.

### Knowledge base (KB collections + files)
- **List collections** ✓ — `GET /resources?type=knowledge-base` (or current `/datacollection/?type=knowledge-base`; both work).
- **List items in collection** ✓ — `GET /resources/{collectionId}/items` with `updatedAt` per item.
- **Get item** ✓ — `GET /resources/{collectionId}/items/{itemId}`.
- **Create item** ✓ — `POST /resources/{collectionId}/items`.
- **Update item** ✓ — `PUT /resources/{collectionId}/items/{itemId}`.
- **Delete item** ✓ — `DELETE /resources/{collectionId}/items/{itemId}`.
- **Auth header**: `Auth-Token: Bearer <token>`.
- **Note**: existing `kbSync.ts` uses an MCP-flavored path for upload; switching to REST `/resources/{id}/items` for sync is consistent with the channel rules and gives uniform pagination + `updatedAt`.

### Filestore (filestore collections + files)
- Same surface as KB above (`/resources?type=filestorage`, `/resources/{id}/items`). Files are binary; download via `signed_url` from list response, upload via `POST /resources/{id}/items` with multipart.
- **Auth header**: `Auth-Token: Bearer <token>`.

### Plugin (Claude Code) — read-only
- Manifest fetch + per-file fetch ✓. Already implemented in `skillsSync.ts`. Out of scope for bidirectional plan.

### Auth header summary

| Group | Header |
|---|---|
| Memory items / Resources / DataCollections | `Auth-Token: Bearer <token>` |
| Platform entities (`/user-agents`, `/automations`, …) | `Authorization: Bearer <token>` |

The scripts' `lib/api.mjs` configures the right header per endpoint family. Both headers carry the same runtime token; no token swap needed. Documented in the engine's HTTP wrapper.

### What the audit unblocked

| Phase | Was blocked on | Now |
|---|---|---|
| Phase 5a (datastore push) | unconfirmed `POST /memory` etc. | **Unblocked** — full CRUD confirmed at `/memory/items/*`. |
| Phase 5b (agent push) | unconfirmed MCP create/update | **Unblocked via REST** — full CRUD at `/user-agents/*`. The MCP gap is real but irrelevant given REST works. |
| Phase 5c (workflow push) | unconfirmed mutation endpoints | **Unblocked via REST** — full CRUD at `/automations/*`. UI-authored-workflow risk handled by 3-way merge + banner. Drafts only; releases stay explicit user action. |

---

## File-system layout

```
~/OpenIT/<orgId>/
├── databases/
│   └── openit-tickets-<org>/
│       ├── _schema.json                # read-only — schema lives in API for v1
│       └── <key>.json
├── agents/
│   └── <name>.json
├── workflows/
│   └── <name>.json
├── filestore/
│   └── <files>
├── knowledge-base/
│   └── <files>
├── .claude/
│   ├── skills/                         # synced from plugin, read-only
│   │   └── resolve-sync-conflicts/SKILL.md
│   └── scripts/                        # synced from plugin, read-only
│       ├── sync-pull.mjs
│       ├── sync-push.mjs
│       ├── sync-status.mjs
│       └── lib/…
├── CLAUDE.md                           # synced from plugin, read-only
├── .git/                               # local-only audit + sync baseline
│   └── refs/openit/last-pull           # the sync baseline ref
└── .openit/
    ├── sync-timestamps.json            # ONE file, replaces all per-entity manifests
    └── .sync.lock                      # advisory lock (created/removed by scripts)
```

### Gitignore additions

```gitignore
.DS_Store
.openit/
.claude/
CLAUDE.md
*.server.*
```

`.claude/` and `CLAUDE.md` are gitignored to keep them out of any push diff (they're plugin-owned, not user-owned). The sync engine also defends against this with the entity-dir filter on the push diff.

---

## Edge cases investigated

### 1. Volatile API metadata in pulled content

If a serialized item includes `createdAt` / `updatedAt` directly inside `content`, every pull rewrites the file with the new timestamps even when nothing meaningful changed. This pollutes `git diff` and triggers spurious conflicts.

**Mitigation**: each entity's `write()` adapter strips known volatile fields before persisting. The "real" `updatedAt` lives in `sync-timestamps.json`, not on disk. Per entity:

| Entity | Strip |
|---|---|
| Datastore | item-level `updatedAt`, `createdAt` (if present in `content`) |
| Agent | `updatedAt`, `createdAt`, `lastUsedAt` |
| Workflow | `updatedAt`, `createdAt`, `lastRunAt` |
| KB / Filestore | content is the file bytes; nothing to strip |

Document the canonical-form contract per entity. Any change to it is a manifest version bump.

### 2. JSON merge invalidation

`git merge-file` is line-based. If two sides edit nearby keys in a JSON file, the merge can produce syntactically invalid JSON.

**Mitigation:** the `write()` adapter for JSON entities formats output as:
- One key per line (no inlined objects/arrays for top level).
- Stable key ordering (`sort -k`).
- Trailing newline.

This makes most merges clean (different keys = different lines). When a merge fails, the conflict markers are clearly visible and Claude's resolve skill can re-format on output.

### 3. Schema evolution mid-sync

Datastore field IDs (`f_1`, `f_2`, …) change when a schema is edited. A row pulled with the old schema can have keys that no longer exist.

**Mitigation v1:** `_schema.json` is read-only (push skips it). On pull, rewrite `_schema.json` first; row writes use the new schema. If a row in `content` has stale field IDs, it's still legible (just shows extra/missing fields) and the next remote row update will reconcile.

**Mitigation v2:** include schema version inside `sync-timestamps.json` (`schema:databases/<col>/_schema.json`). On schema change, force-clear every row timestamp for that collection so the next pull re-downloads everything.

### 4. Deletion races

User A pulls → deletes locally → pushes (delete sent to API). User B pulls before B's previous push completes → API returns the now-deleted item once more, B gets it back. Eventually consistent.

**Mitigation:** on push, after delete API call, immediately re-list and verify the item is gone. If it's still there (eventual-consistency window), push retries delete once after 2s. Documented as "eventual" in the user-facing model.

### 5. Plugin script versioning

Script v1 wrote a timestamps file with format A. Script v2 expects format B.

**Mitigation:** `sync-timestamps.json` includes a top-level `"version": 1` field. Script v2 reads it; on mismatch, runs a one-time migrator (in `lib/migrate.mjs`) before proceeding. Migrators are forward-only.

### 6. First-connect with no scripts yet

Bootstrap order: project dir created → plugin synced (scripts arrive on disk) → entity sync runs (scripts can be invoked).

The current modal flow already does plugin sync **last** (after entities). That order is wrong for this plan — needs to flip. Plugin sync moves to the **first** step after project bootstrap.

If plugin sync fails (network blip), the modal aborts with a clear error before attempting entity sync. No half-state.

### 7. Old OpenIT app meets new plugin

User on OpenIT v0.5 (TS-engine sync) connects, plugin manifest says v2 (script-engine). The new plugin downloads but the OpenIT v0.5 code path still uses TS-engine internally; scripts are present but unused.

**Mitigation:** OpenIT v0.5 doesn't know about scripts so they sit harmlessly. Once user updates OpenIT, the next connect triggers manifest re-sync (no-op if already at v2) and from there forward the scripts run.

We don't need to support backward compat in the *plugin* (plugin is always-latest from web repo). We do need OpenIT v-next to handle the case where `.openit/kb-state.json` exists from an old session — see Migration.

### 8. Unicode and non-ASCII filenames

Pinkfish allows arbitrary names for KB files, agents, etc. macOS uses NFD normalization in filenames; Linux uses NFC; Windows is mixed.

**Mitigation:** store paths in `sync-timestamps.json` and the API in NFC. On disk, normalize to whatever the OS prefers (it converts automatically on `readdir`). When comparing, always NFC-normalize both sides.

### 9. Very long sync runs

Pulling 10,000 datastore rows might take minutes. Token expiry (1h+) and lock duration matter.

**Mitigation:** scripts don't hold tokens longer than they need; `auth.mjs` re-mints if `expires_at` is < 60s away. The lock is held for the duration of the script — fine; another sync in 60s waits and retries (exit code 4).

### 10. Network failure mid-pull

Item N downloaded, item N+1's fetch fails.

**Mitigation:** `pullEntity` is per-item idempotent. Items 1..N have their timestamps recorded; the git commit happens only at the end with what we got. On retry, items 1..N skip via timestamp match; resume from N+1. Worst case: empty commit if we never made it past item 0.

### 11. Concurrent same-user, same-org on two machines

Both pull, both edit, both push. First-to-push wins; second-to-push pulls conflicts.

**Mitigation:** standard 3-way merge flow handles this. Each machine has independent `refs/openit/last-pull`. The Pinkfish API timestamp is the cross-machine source of truth.

### 12. Plugin scripts accidentally pushed back

User edits `.claude/scripts/sync-pull.mjs` locally (perhaps trying to debug).

**Mitigation:** push diff filter excludes `.claude/`, `.openit/`, `CLAUDE.md`. The exclusion is in the engine, not just gitignore. Belt and suspenders.

### 13. The `pinkit` CLI conflict

`DeployButton.tsx` currently shells out to `pinkit deploy`. Once the new engine ships, do we keep `pinkit` as a separate "deploy to environment" feature, or replace it?

**Decision deferred to Phase 6.** They could coexist: scripts handle entity sync (always idempotent, safe), `pinkit deploy` handles the "publish to prod" semantic which is a different operation. Document in Phase 6 design.

### 14. Symlinks / hardlinks

Hopefully nobody puts a symlink in the project folder, but if they do, git follows it and the sync engine writes through it. That's fine for our purposes; surface as warning if we detect one.

### 15. Permission errors on Windows

Windows file locks (especially on PDFs viewed in Acrobat) prevent overwrite. Sync would fail on those files specifically.

**Mitigation:** scripts catch `EBUSY` / `EPERM`, log a clear warning, skip the file, continue with others. Result lists it under `errors[]`.

### 16. Null bytes in content

Pinkfish stores arbitrary bytes in filestore; KB stores arbitrary text. Node's `fs.writeFile(path, buffer)` handles both, but JSON parsing fails on null bytes in content. Adapters must use Buffer, not string, where appropriate.

### 17. Time skew

User's clock is wrong by 5 minutes. Pinkfish `updated_at` advances normally; ours doesn't. Comparison is server-vs-server only (we just record what the server told us last), so no drift.

### 18. Disk full

`fs.writeFile` throws `ENOSPC`. Scripts catch, surface in `errors[]`, exit code 2 (partial).

---

## Performance and scale

### Targets

| Operation | Target |
|---|---|
| Steady-state poll (no changes) | < 2s end-to-end |
| Initial pull (small org: 10 datastore rows, 1 KB file, 1 filestore PDF) | < 10s |
| Initial pull (medium org: 1k rows, 50 files) | < 60s |
| Push of one row edit | < 3s |
| `sync-status` probe | < 500ms |

### Bottlenecks

1. **API latency dominates.** Every entity does at least one list call. With five entities, that's 5 round-trips. Could parallelize but adds complexity; sequential is fine for v1.
2. **Per-item content fetch** for entities where list doesn't return content (filestore — needs signed URL + GET). KB list returns signed URLs; content fetch is a second round-trip.
3. **`git` shell-outs.** Each `git show`, `git diff`, `git merge-file` is a process spawn. ~10ms each on macOS. For 1000 items with no changes, 1000× `git diff` = 10s — not OK.

   **Mitigation:** batch. Use `git diff --name-only` once per entity (returns all changed paths), not per file. Only do per-file `git show` for the items that need a 3-way merge. This keeps process spawns proportional to *changes*, not *total items*.

### Memory

Scripts stream where possible (`fetch().body.pipeTo(fs.createWriteStream(...))` for filestore). Don't load whole binaries into memory. JSON entities load fully — fine for individual rows.

### Bandwidth

Steady-state poll downloads only changed items (timestamp filter). For an org with 1k rows where one changed: ~5kB transferred (5 list calls + 1 row fetch). Acceptable for a 60s heartbeat.

---

## Testing strategy

### Unit tests for scripts

Run with Vitest in `scripts/test/`. Mock `fetch` for API, mock `child_process.execFile` for git, mock `fs/promises` with an in-memory FS (memfs).

Key tests:
- pullEntity: unchanged, new, fast-forward, merge clean, merge conflict, both-created, remote-deleted-local-clean, remote-deleted-local-edited.
- pushEntity: pure add, pure update, pure delete, mixed, partial failure.
- timestamps: read/write round-trip, version migration.
- merge: text merge happy paths, JSON merge with one-key-per-line formatting.

### Integration tests

A test harness in `scripts/test/integration/` that runs against a mock Pinkfish server (`msw` or an Express stub). Covers:
- Initial pull with empty repo.
- Incremental pull with changes.
- Push round-trip.
- Token expiry + retry.
- Lock contention (two concurrent script runs).

### End-to-end on Tauri side

Existing `npm run tauri dev` flow with a real Pinkfish stage account. Manual smoke tests for the modal flow + banner. Add Playwright if/when the project standardizes on browser tests for the WebView.

### Cross-platform CI

GitHub Actions matrix: macOS-latest, ubuntu-latest, windows-latest. Run unit + integration tests on each. Catches PowerShell-vs-bash differences (shouldn't matter since we're on Node, but verifies).

---

## Telemetry and error visibility

The user has zero observability into sync currently. The new design exposes more:

- **Sync log in modal** — already implemented, will route stderr from scripts.
- **Sync tab "last synced" timestamp** — bumped after each successful poll.
- **Banner** — surfaces conflicts.
- **Toast** — for fatal errors (auth failure, network down).
- **Verbose mode** — clicking a "View details" link in the Sync tab opens a panel that shows the last 10 sync results (parsed JSON). Useful for debugging without dropping to devtools.

No external telemetry (Sentry, Datadog) in v1. Keep error data local. Could add anonymized error reports later, opt-in only.

---

## Migration from current state

### Files to remove

- `.openit/kb-state.json` — manifest, replaced by `sync-timestamps.json`.
- `.openit/fs-state.json` — same.

### Migrator runs once

`scripts/lib/migrate.mjs` invoked at the top of `sync-pull.mjs` if it detects pre-v1 state files:

```js
async function migrateIfNeeded() {
  const tsPath = ".openit/sync-timestamps.json";
  if (await exists(tsPath)) return;          // already migrated

  const ts = { version: 1 };
  const kb = await tryLoad(".openit/kb-state.json");
  if (kb?.files) {
    for (const [filename, entry] of Object.entries(kb.files)) {
      ts[`kb:knowledge-base/${filename}`] = entry.remote_version;
    }
  }
  const fs = await tryLoad(".openit/fs-state.json");
  if (fs?.files) {
    for (const [filename, entry] of Object.entries(fs.files)) {
      ts[`filestore:filestore/${filename}`] = entry.remote_version;
    }
  }
  await writeTimestamps(ts);
  await rm(".openit/kb-state.json", { force: true });
  await rm(".openit/fs-state.json", { force: true });
}
```

Idempotent. Survives partial migration (re-running just sees `sync-timestamps.json` exists and skips).

### Existing TS sync code

`kbSync.ts` and `filestoreSync.ts` keep their public API (`startKbSync`, `pullOnce`, etc.) but the internals now invoke `syncEngine.ts` which spawns the script. No call sites in the rest of the app need to change. After Phase 1 stabilizes, deprecate the wrappers and call `syncEngine` directly.

### `refs/openit/last-pull` initial value

On migration, set the ref to the current `HEAD` (which is the most-recent `sync: pull` commit from the old code). That's a reasonable starting baseline.

If the repo has uncommitted local edits at migration time, those are treated as "user edits since last pull" — they'll show up in the next push diff. Consistent with what they'd see in `git status`.

---

## Backward compatibility

- **Plugin manifest version bumps** — old OpenIT installs ignore the new `scripts` array (the manifest sync code only iterates `files[]`). Once the user updates OpenIT, scripts get downloaded and used.
- **Scripts gracefully handle missing OpenIT bits** — if an env var is absent (vanilla terminal user who hasn't set it up), scripts emit a clear `error: { code: "missing_creds", message: "Set PINKFISH_CLIENT_ID and PINKFISH_CLIENT_SECRET. See .claude/scripts/README.md" }` and exit 3.
- **Old `.openit/*-state.json` files** — migrated on first script run.
- **Older Node** — scripts target Node 18+ (uses global `fetch`). If Claude Code requires < 18 someday (unlikely; they're at 20+), revisit.

---

## Windows specifics

| Concern | Status |
|---|---|
| Node 18+ | Required by Claude Code; no new prereq. |
| `git` CLI | Git for Windows is the most-installed Windows dev tool. Same dependency we'd have with bash. |
| Path separators | Scripts use `node:path`'s `path.join` consistently. Never string-concat paths. Never `/` literally. |
| Line endings | `git config core.autocrlf false` set during `git_ensure_repo` so CRLF doesn't mangle text and produce phantom diffs across machines. **Set this in the Tauri-side `git_ensure_repo` and verify in scripts on Windows.** |
| Spawning `node` from Tauri | `Command::new("node")` resolves via PATH on all platforms (Windows finds `node.exe`). Verify Tauri's child-process PATH inheritance on Windows. |
| Spawning `git` from scripts | `child_process.execFile("git", …)` works identically. |
| File system events | The recently-added event-based fs notifications (`fb638fb`) use `notify-rs`, which supports Windows. |
| Lock semantics | `mkdir`-based lockfile in `.openit/.sync.lock` — atomic across all platforms. |
| Argument quoting | Use `child_process.execFile` (array args), never `exec` (shell-string). Safer on Windows where shell quoting is treacherous. |
| Filename case sensitivity | Windows filesystems are case-insensitive but case-preserving. Treat paths as case-sensitive in the engine; rely on the filesystem's matching. Document that two items differing only in case will collide on Windows (they will on macOS too, by default). |
| Temp file location | Use `node:os.tmpdir()` for any temp file (e.g. merge intermediates). Cross-platform-safe. |
| Console encoding | Explicitly write UTF-8 to stdout/stderr (`process.stdout.write(buf)` instead of `console.log` for log lines that have multibyte characters). |

**Net assessment:** Node-based scripts make Windows nearly free. The biggest unknown is whether Tauri's child-process `PATH` correctly includes the user's `node` install — easy to verify once a Windows tester is available.

If we ever discover a Windows-specific blocker that Node can't address, the fallback is *not* to write a `.ps1` parallel — it's to wrap the `.mjs` in a tiny PowerShell shim that just calls `node`. Algorithm stays single-source.

---

## Development workflow

Scripts ultimately ship from `web/packages/app/public/openit-plugin/scripts/`, but during development **we edit them in place at `~/OpenIT/<orgId>/.claude/scripts/`** — their actual runtime location.

The loop:

1. Connect once — manifest sync downloads the current canonical scripts from `/web`.
2. Edit `.claude/scripts/sync-pull.mjs` (or wherever) directly in the project folder.
3. Test by running the sync (Sync button, modal connect retry, or `node .claude/scripts/sync-pull.mjs` from a terminal in that folder).
4. Iterate.
5. When happy, copy the edited files into `web/packages/app/public/openit-plugin/scripts/`, bump `manifest.json` version, push the web repo.
6. Reconnect — fresh canonical version arrives, matches what was tested. Done.

**The gotcha:** if you trigger a manifest sync mid-dev (by reconnecting, restarting the app's dev server in a way that re-runs `syncSkillsToDisk`, etc.), your in-progress edits get overwritten by whatever the web repo currently holds. Two ways to avoid:

- **Just don't reconnect** until you're ready to publish. The 60s entity-sync poll doesn't touch plugin files — only the explicit manifest sync does.
- **Or add a dev flag** `OPENIT_SKIP_PLUGIN_SYNC=1` (read by `syncSkillsToDisk`) that short-circuits the script-overwrite path during `npm run tauri dev`. Cheap to add when this becomes annoying.

Optional helper: `openit-app/auto-dev/publish-scripts.mjs` rsyncs `~/OpenIT/<orgId>/.claude/scripts/` → `web/packages/app/public/openit-plugin/scripts/`, prompts for a version bump on `manifest.json`, prints a diff. Saves a few keystrokes per release.

**Why not develop in `openit-app/scripts/` and use a dev override?** Adds an env-var override to the Tauri side and a directory we have to keep in sync with the runtime location. Editing in place is simpler and exercises the real production code path on every iteration.

---

## Implementation phases

### Phase 0 — plugin script harness + Tauri invoker

The foundation. Two parallel sub-tracks:

**Plugin (in `web/packages/app/public/openit-plugin/`):**
- `scripts/lib/auth.mjs`, `scripts/lib/api/*.mjs`, `scripts/lib/git.mjs`, `scripts/lib/merge.mjs`, `scripts/lib/timestamps.mjs`, `scripts/lib/lock.mjs`, `scripts/lib/log.mjs`.
- `scripts/lib/pull.mjs`, `scripts/lib/push.mjs` — the engine.
- `scripts/sync-pull.mjs`, `scripts/sync-push.mjs`, `scripts/sync-status.mjs` — entry points.
- `scripts/lib/entities/*.mjs` — start with a no-op test entity to validate the harness.
- `scripts/test/` — Vitest unit tests, run in CI.
- `scripts/README.md` — for vanilla-terminal users.
- `manifest.json` adds `"scripts"` array enumerating .mjs files.
- `CLAUDE.md` adds "How sync works" section.
- `skills/resolve-sync-conflicts.md`.

**Tauri (in `openit-app/`):**
- `src-tauri/src/sync.rs` — three Tauri commands: `sync_pull`, `sync_push`, `sync_status`. Spawn `node <repo>/.claude/scripts/<file>.mjs`, capture stdout (JSON) + stderr (log lines), return parsed result.
- `src/lib/syncEngine.ts` — TS wrapper around those commands. Exposes `pullAll(repo, onLog)`, `pushAll(repo, onLog)`, `subscribeConflicts(fn)`.
- `src/lib/skillsSync.ts` — extend to download `scripts/` files.
- Migration of `.openit/kb-state.json` and `.openit/fs-state.json` runs inside the script (Phase 1's adapters trigger it).

**Phase 0 deliverables (all must land before Phase 1):**
- Plugin script harness with no-op test entity.
- Tauri `sync_pull` / `sync_push` / `sync_status` commands.
- `src/lib/syncEngine.ts` wrapper.
- `skillsSync.ts` extended to download `scripts/`.
- **Plugin-sync ordering moved from last to first in `PinkfishOauthModal.tsx`** (otherwise scripts aren't on disk when the engine tries to run).
- **CI matrix passing on macOS-latest, ubuntu-latest, windows-latest.** Unit + integration. No manual sign-off — green CI gates the merge.
- A canary script exec round-trip from Tauri returning JSON, verified on all three OSes.

Phase 0 ships nothing user-visible — it's the harness.

### Phase 1 — port KB and filestore to the engine

Rewrite `kbSync.ts` and `filestoreSync.ts` as thin wrappers over `syncEngine.ts`. The actual logic moves into `scripts/lib/entities/kb.mjs` and `scripts/lib/entities/filestore.mjs`.

Ships zero new functionality. Validates the engine on entities that already had bidirectional sync.

**Phase 1 deliverables:**
- KB and filestore adapters in scripts/lib/entities/.
- TS wrappers maintain existing public API (`startKbSync`, `pullOnce`, etc.) so call sites don't change.
- Migrator `lib/migrate.mjs`: harvests `kb-state.json` / `fs-state.json` `remote_version` values into `sync-timestamps.json`, deletes the old files, sets `refs/openit/last-pull` to current HEAD. Idempotent.
- **Backwards-compat smoke test** (gates merge): with a real prior-version repo on disk that has both pre-existing `.openit/*-state.json` files AND uncommitted local edits in `knowledge-base/`:
  1. Start app at new version.
  2. Verify migrator runs, old files are gone, `sync-timestamps.json` exists with the harvested entries.
  3. Verify `git status` still shows the user's pre-existing local edits as `M`.
  4. Verify a pull doesn't delete those local edits.
  5. Verify a push uploads them and clears the diff.
- A regression test that captures stderr from a sync run and greps for token-shaped strings (must be empty).

### Phase 2 — datastores on the engine

`scripts/lib/entities/datastore.mjs` adapter:
- `list`: hit `/memory/bquery`, map items → `{ path, updatedAt, fetchContent }`.
- `write`: write canonical JSON to `databases/<collection>/<key>.json`.

Wire into modal connect + relaunch path. **Solves the "every row shows as M after every sync" problem.**

### Phase 3 — agents and workflows on the engine

Same shape as Phase 2. One file per entity. Conflict shadow `<name>.server.json`.

### Phase 4 — banner + Resolve-in-Claude UI

- New component `ConflictBanner.tsx` subscribed to `syncEngine.subscribeConflicts`.
- Wire **Resolve in Claude** button to type `/resolve-sync-conflicts` into the embedded terminal.
- Replace existing `Shell.tsx` "Resolve merge conflicts" prompt-bubble path with the banner.

Independent of push. Works as soon as Phase 1 lands.

### Phase 5 — push for datastores, agents, workflows

Audit completed (2026-04-25). All three are unblocked via REST. Each entity adapter gains `apiUpsert(path, content)` / `apiDelete(path)` calling the REST endpoints documented in *API mapping per entity*. Engine's `pushEntity` already exists from Phase 0.

Sub-phases (ship independently):

- **Phase 5a — datastore push.** Lowest risk. `/memory/items/*` is a clean CRUD surface, items are small JSON, no UI-author overlap.
- **Phase 5b — agent push.** Medium risk. `/user-agents/*` works, but agents have richer metadata (skills, tags, public-version) that may surface conflicts we haven't seen on simpler entities.
- **Phase 5c — workflow push.** Highest risk. `/automations/*` works for drafts, but UI-authored workflows are a real concurrent-edit risk. Manual cross-edit smoke test required before enabling for users. **Sync targets the draft only — never auto-release.**

### Phase 6 — Deploy/Sync button unification

`DeployButton.tsx` currently shells out to `pinkit deploy`. Replace with `syncEngine.pushAll(repo)` which fans out to every entity.

**Pre-Phase-6 decision required**: what happens to `pinkit deploy`?
- **Option A** — retire it. Sync engine handles all writes; `pinkit` becomes vestigial.
- **Option B** — keep as a separate "publish to environment" semantic, distinct from entity sync. Document the line.
- **Option C** — coexist as one of the buttons in the Sync tab.

This decision needs an owner and a date before Phase 6 starts. Track as a Phase-6-blocker, not deferred indefinitely.

---

## Open questions and risks

### Resolved by 2026-04-25 audit
- ~~Datastore item update/delete endpoints~~ — **resolved**: `POST/PUT/PATCH/DELETE /memory/items` confirmed.
- ~~`updatedAt` on `agent_list` / `workflow_list`~~ — **resolved**: irrelevant. Sync moves to REST (`/user-agents`, `/automations`) which exposes `updatedAt`. MCP shape is unchanged for skill-side use.
- ~~Workflows push endpoints~~ — **resolved**: `POST/PUT/DELETE /automations/{id}` confirmed. Drafts only; releases stay explicit (`POST /automations/{id}/release` is *not* called by the sync engine).

### Still open

1. **Auth header per endpoint family.** Memory/Resources use `Auth-Token`; platform entities (`/user-agents`, `/automations`) use `Authorization`. Scripts' `lib/api.mjs` must dispatch the right header. Mistakes silently 401; cover with integration tests.
2. **Workflow push safety in practice.** Audit confirms endpoints exist, but 3-way merge on `/automations/{id}` JSON has not been tested against a UI-edited draft. Phase 5c needs a manual cross-edit smoke test before enabling for users. If merges corrupt drafts in practice, fall back to: only allow workflow push when `git diff` is non-conflicting; otherwise require user to "make this the source of truth" explicit action.
3. **Schema mutation.** `_schema.json` is read-only for v1. Future schema-update API enables real bidirectional schema sync. Until then: scripts write `_schema.json` on pull, ignore it on push, log a warning if a user has edited it locally.
4. **Volatile API metadata.** Each entity adapter must strip `createdAt` / `updatedAt` (and similar) from `content` before writing to disk, otherwise every pull rewrites the file with a new timestamp. Per-entity contract; cover with tests.
5. **JSON merge invalidation.** Line-based `git merge-file` can produce invalid JSON when both sides edit nearby keys. Mitigation: write canonical JSON (one key per line, sorted). Conflict markers still need hand-resolution in Claude.
6. **Pre-existing user edits at migration time.** Migrating from the old per-entity manifests, any uncommitted local edits show up as "to push" in the next push diff. Manual smoke test before shipping the migrator.
7. ~~Plugin sync ordering~~ — **promoted to Phase 0 deliverable.**
8. **`pinkit` CLI** — keep / retire / coexist decision tracked as a **Phase-6 blocker** with an explicit owner and date, not as an indefinite deferral. See Phase 6 deliverables.
9. **Embedded terminal Node availability.** At startup, verify `node --version`; if missing or < 18, surface a friendly setup message instead of letting sync fail mysteriously.
10. **Banner persistence.** I propose: banner stays until `sync-status.mjs` reports zero conflicts. Dismiss is per-session only. Confirm with user.
11. **Concurrency between user-typed Claude commands and background poll.** Both can spawn scripts. The lock prevents data corruption but the user may see brief "sync already in progress" messages. Acceptable; revisit if it becomes annoying.
12. **Plugin update during active sync.** If the plugin manifest version bumps mid-sync, the running script keeps using the old code on disk. Next invocation uses new. No mid-flight script swap. (Generally safe; document.)
13. **Conflict on a deleted entity.** A deletes locally, B edits remotely. On A's next pull, B's edit appears as a "new file" (no base in `refs/openit/last-pull` for that path). Treat as "remote-resurrected", surface as conflict, let Claude decide.
14. **Auth token logging.** Scripts must NEVER log the token to stderr. Lock down `lib/log.mjs` and `lib/api.mjs` so no helper string-interpolates the auth header. Cover with a test that greps captured stderr for token-shaped strings.
15. **Releases vs sync.** Document explicitly that the sync engine never auto-releases workflows. CLAUDE.md should also tell Claude not to release on the user's behalf without explicit instruction. Releases are publish operations; sync is editing operations.

---

## Recommended landing order

1. **Phase 0** — plugin script harness + Tauri invoker. Largest single PR; everything downstream rides on it. Cross-platform CI (macOS / Linux / Windows) gates the merge.
2. **Phase 1** — port KB + filestore to the engine. Backwards-compat smoke test gates the merge.
3. **Phase 2** — datastores pull. Ships the original requested fix.
4. **Phase 3** — agents + workflows pull.
5. **Phase 4** — banner + Resolve-in-Claude UI.
6. **Phase 5a / 5b / 5c** — push paths, sub-phased by risk (datastore → agent → workflow).
7. **Pre-Phase-6 decision** — `pinkit` CLI fate (named owner + date).
8. **Phase 6** — Deploy/Sync button unification.

Phases 1-4 are fully unblocked. Phase 5 is unblocked via REST per the 2026-04-25 audit. Phase 6 is gated on the `pinkit` decision.

---

## Plan Review Findings

**Gate:** Plan Review (per `autonomous-dev/development_process/02-implementation-plan-review.md`)

**Changes made:**
- Folded the 2026-04-25 API audit into the API-mapping section; resolved three open questions; sub-phased Phase 5 by risk (datastore → agent → workflow).
- Added a "Channel selection" architectural section codifying REST-for-sync, built-in-MCP-for-skills, gateway-for-third-party. Updated CLAUDE.md to match (light version).
- Promoted "plugin sync ordering" from open question to Phase 0 deliverable.
- Made cross-platform CI green an explicit Phase 0 merge gate.
- Made backwards-compat migration smoke test an explicit Phase 1 merge gate, with the steps spelled out.
- Promoted `pinkit` CLI decision from "deferred to Phase 6" to "Phase-6 blocker with named owner + date."
- Added a stderr-token-leak regression test as a Phase 1 deliverable.

| Finding | Error type |
|---|---|
| Plugin sync ordering buried in open questions; should be a phase deliverable since it's actionable today and Phase 0 depends on it. | omission |
| Cross-platform CI mentioned but not gated to Phase 0 merge; risk of platform-specific regressions sneaking through. | omission |
| Backwards-compat migration smoke test was implicit; needs to gate Phase 1 merge with concrete steps. | omission |
| `pinkit` CLI fate left as "decided in Phase 6" with no owner — would block Phase 6 indefinitely. | omission |
| Initial plan had multiple architectural directions (manifest-vs-git, bash-vs-Node, in-app-vs-script). Resolved through prior discussion to one path; review confirms no remaining ambiguity. | (resolved before review) |

No `incoherent` findings. No `systematic` findings — the chosen patterns match existing project conventions (scripts in plugin, REST-via-fetch, Tauri Rust commands, git for state).
