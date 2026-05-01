# Agent sync V2 — three-block instructions, attached resources, auto-release

**Date:** 2026-05-01
**Ticket:** PIN-TBD
**Status:** Draft (stage 02) — design decisions locked with user
**Owner:** Sankalp

---

## Problem

V1 round-trips three flat fields (`name`, `description`, `instructions`) and ships agents to Pinkfish in **draft** state. Five concrete gaps emerged from real testing:

1. **Cloud agent doesn't actually work** — without resources attached, the cloud triage has nothing to operate on. Without tools (MCP servers), it has no verbs to call. Push succeeds, but the agent on cloud is functionally inert.
2. **Local instructions don't translate to cloud** — the `instructions` text references `Glob`, `Read`, `Bash`, file paths under `databases/`, the `ai-intake` skill, stdout markers. None of those exist in Pinkfish runtime; the cloud agent reads instructions written for a different environment.
3. **Agent stays in draft forever** — Pinkfish's `latestRelease > 0` gate (the gate org-wide Slack routing depends on, V3) never trips.
4. **Identity is incomplete** — the admin can't set the model, sharing, prompt bubbles, or intro message from disk.
5. **Edit experience is read-only-ish** — Phase A fields and resources/tools require Raw-mode JSON editing.

## Design decisions locked

User and Ben agreed on these in conversation 2026-05-01. They drive everything in this plan.

| Decision | Lock |
|---|---|
| **File layout** | `agents/triage/` folder containing `triage.json` + three `.md` files: `common.md`, `cloud.md`, `local.md` |
| **Three-block instructions** | Replace V1's single `instructions` field with three composable blocks. Cloud receives `common + cloud`; local intake reads `common + local` |
| **Block ownership** | User owns all three .md files. Plugin ships defaults on first install. Write-once gate preserves user edits across plugin version bumps |
| **Default resources** | Bundled triage attaches: KB:`default`, datastores:`tickets`/`people`/`conversations`, filestores:`library`/`attachments`/`skills`/`scripts` |
| **Default tools** | Bundled triage attaches MCP servers: `knowledge-base`, `datastore-structured`, `filestorage` — all with `allTools: true` |
| **Edit tab UI** | Full UI — flat-field inputs + resource pickers + tool toggles. Mirrors web builder's authoring surface |
| **Pull conflict semantics for instructions** | Same shadow pattern as every other entity. If cloud's assembled `instructions` differs from what we last pushed AND local block(s) advanced, write `instructions.server.md` shadow. No fast-forward (would need to reverse-split the cloud string). |
| **Migration** | Auto-shim: detect flat `agents/triage.json` on first launch, move `instructions` into `common.md`, drop bundled `cloud.md` + `local.md`, delete the old flat file |
| **Auto-release** | Every successful POST/PATCH triggers `POST /service/useragents/{id}/releases`. Failure persists `release_pending: true` in manifest; retried on next sync even if agent is otherwise clean |
| **Resource resolution failure** | Skip with warning (not strict-fail). Push continues with the resources that resolve |
| **Channels** | Deferred to V3 — Slack/Teams binding is its own product question (local Socket Mode vs cloud OAuth blending) |
| **`metadata` fields** | Deferred to V3 — `iconUrl`, `background`, `textStyle`, `dashboardFiles`. PATCH overlays `metadata` shallowly; needs read-merge to safely write a single field |
| **API keys / public sharing** | Out of scope. Server-managed via dedicated web modals |

## Mental model

| OpenIT-side | Pinkfish-side |
|---|---|
| Untracked / dirty file | (nothing — local-only) |
| Committed + pushed | **Released agent** (auto-released by sync; no separate gesture) |

No "draft" state on Pinkfish for OpenIT-managed agents. Push-then-release is one Commit click.

## Success criteria

- [ ] On first launch with V2 code, an existing user with flat `agents/triage.json` sees it auto-migrated to `agents/triage/triage.json` + `common.md` + `cloud.md` + `local.md`. The user's existing `instructions` text lands verbatim in `common.md`.
- [ ] Edit tab shows: Description, Common instructions, Cloud instructions, Local instructions, Model (dropdown), Shared (checkbox), Prompt bubbles (textarea, one per line), Intro message (textarea), Resources (3 sections × multi-select), Tools (3 server toggles). Save writes each .md file separately and `triage.json` for structured fields.
- [ ] Hit Commit → push fires → cloud agent reflects every changed field, with resources attached, in **released** state (web shows "Published"). Within ~3s of Commit completing.
- [ ] Cloud agent's `instructions` field on Pinkfish equals `common.md + "\n\n" + cloud.md`.
- [ ] Local intake.rs subprocess receives `common.md + "\n\n" + local.md` as its prompt.
- [ ] If a referenced resource doesn't exist locally (e.g. user deleted `databases/people/`), push logs `⚠ skipping people datastore (not found)` and continues. Other resources still attach.
- [ ] If the release call fails (network, 5xx), upsert still counts as success. Manifest entry gets `release_pending: true`. Next push retries the release even if the agent is otherwise clean.
- [ ] Pull-side: if cloud's `instructions` diverges from what we last pushed AND any of `common.md`/`cloud.md` mtime advanced past `pulled_at_mtime_ms`, write `agents/triage/instructions.server.md` shadow + record conflict via the engine's aggregate.
- [ ] V1 regression: existing 3-field push (description, model-less, etc.) for any non-triage `openit-*` agents continues to work.
- [ ] All tests pass; TypeScript clean.

## Out of scope (deferred)

- **V3:** channels (Slack/Teams binding), `metadata` fields (icon/background), workflows attached to agent
- **V4:** Tools station UI in OpenIT (CLI + MCP tabs), per-tool configuration, multi-agent creation in-app, `outputSchema`
- **Out forever in V*:** API keys, public sharing, ACL — server-managed

---

## Architecture

### File layout

```
agents/triage/
  triage.json     # structured: name, description, model, isShared,
                  # promptExamples, introMessage, resources, tools
  common.md       # shared persona — true everywhere
  cloud.md        # cloud-runtime HOW — MCPs, datastore CRUD, KB ask
  local.md        # local-runtime HOW — Glob+Read, file paths, ai-intake
```

`triage.json` no longer has an `instructions` field. The three .md files replace it.

### Disk schema (`triage.json`)

```jsonc
{
  "id": "ua_…",                          // server-issued; empty until first push
  "name": "triage",                      // unprefixed local form
  "description": "First-line responder for incoming IT support questions...",
  "selectedModel": "haiku",              // optional; omit-when-absent on push
  "isShared": false,                     // optional; omit-when-absent on push
  "promptExamples": [                    // optional; if present, sent verbatim (omit-when-absent)
    "I can't access SharePoint",
    "VPN won't connect"
  ],
  "introMessage": "Hi! I'm the IT helpdesk triage bot...",  // optional; omit-when-absent
  "resources": {                         // optional; if present, sent (with resolved IDs)
    "knowledgeBases": [
      { "name": "default", "canRead": true, "canWrite": false, "canDelete": false }
    ],
    "datastores": [
      { "name": "tickets",       "canRead": true, "canWrite": true, "canDelete": false },
      { "name": "people",        "canRead": true, "canWrite": true, "canDelete": false },
      { "name": "conversations", "canRead": true, "canWrite": true, "canDelete": false }
    ],
    "filestores": [
      { "name": "library",     "canRead": true, "canWrite": false, "canDelete": false },
      { "name": "attachments", "canRead": true, "canWrite": false, "canDelete": false },
      { "name": "skills",      "canRead": true, "canWrite": false, "canDelete": false },
      { "name": "scripts",     "canRead": true, "canWrite": false, "canDelete": false }
    ]
  },
  "tools": {                             // optional; if present, sent
    "servers": [
      { "name": "knowledge-base",       "allTools": true },
      { "name": "datastore-structured", "allTools": true },
      { "name": "filestorage",          "allTools": true }
    ]
  }
}
```

**Omit-when-absent rule for V2 fields.** Any field absent from disk → absent from PATCH body → cloud value preserved. Disk-key presence is the user's "I own this" signal.

This applies to:
- `selectedModel`, `isShared`, `promptExamples`, `introMessage` (PATCH overlays at top level)
- `resources.knowledgeBases`, `resources.datastores`, `resources.filestores` (PATCH replaces array whole — must omit if user didn't author the resources block)
- `tools.servers` (same)

V1 fields (`name`, `description`, `instructions`) are always present in the body — they were V1's covenant.

### Three-block assembly

**Push to cloud:**
```
instructions = read(common.md) + "\n\n" + read(cloud.md)
```
Sent in the PATCH body's `instructions` field. The cloud agent never knows about the split.

**Local intake** ([intake.rs:load_triage_agent](src-tauri/src/intake.rs#L1204)):
```rust
instructions = read(common.md) + "\n\n" + read(local.md)
```
Passed to the `claude -p` subprocess as the agent's prompt.

If any .md file is missing on disk (mid-edit, mid-migration), assembly substitutes `""` and logs a warning. No assembly failure aborts push or intake — the partial prompt is still functional.

### Resource resolution at push

The wire shape needs `id` and `proxyEndpointId` per resource. Both are environment-specific. Reading from `getSyncStatus().collections` (KB) / `getFilestoreSyncStatus().collections` (filestore) would race the parallel `Promise.allSettled` in `pushAllEntities`: `runAgent` could try to resolve a brand-new KB before `runKb`'s pre-pull populates the cached state.

**Fix: `resolveResourceRefs` does a fresh `listAllCollections` REST call inside the helper.** One extra GET per push when resources are non-empty. Pattern matches `syncEngine.ts:1224`. Datastore collections (no exposed status helper) are also covered by the fresh fetch.

**Failure mode:** if a referenced name doesn't resolve (typo, deleted collection), log and skip — push continues with the resources that DID resolve. Surface in the streaming log:

```
▸ sync: agents pushing
  ⚠ skipping datastore "people" (not found locally)
  ✓ pushed triage
▸ sync: agent push complete — 1 ok, 0 failed
```

This is friendlier than fail-fast for a default-templated resource the user removed. The cloud agent ends up with fewer resources than the disk file declares, but it works.

### Auto-release with retry

After every successful POST/PATCH, fire `POST /service/useragents/{id}/releases`:

```ts
try {
  await releaseUserAgent(creds, serverAgent.id);
  delete manifest.files[filename].release_pending;
} catch (e) {
  onLine(`  ✗ release failed (will retry next sync): ${String(e)}`);
  manifest.files[filename].release_pending = true;
  // Do NOT fail the push — upsert already succeeded. The agent is
  // up-to-date on cloud; just not yet released.
}
```

**Retry mechanism:** `runAgent`'s skip-clean check today returns early when nothing's dirty ([pushAll.ts:484-495](src/lib/pushAll.ts#L484)). Add a clause: if any tracked agent has `release_pending: true`, do NOT skip — fall through to the push step which will only fire `releaseUserAgent` (no upsert needed for that agent). Until the release succeeds, the flag stays set and every sync retries.

```ts
// In runAgent skip-clean check:
const m = await invoke<KbStatePersisted>("entity_state_load", { repo, name: "agent" });
const hasPendingRelease = Object.values(m.files ?? {}).some(
  (f) => (f as { release_pending?: boolean }).release_pending,
);
if (hasPendingRelease) {
  // Fall through; release retry will run inside pushAllToAgents.
} else if (/* normal skip-clean */) {
  return; // skipped (clean)
}
```

### Migration shim

```ts
async function migrateFlatTriage(repo: string): Promise<void> {
  const flatExists = await fileExistsOnDisk(repo, "agents", "triage.json");
  const folderExists = await fileExistsOnDisk(repo, "agents/triage", "triage.json");
  if (!flatExists || folderExists) return;

  try {
    // Read flat file
    const content = await fsRead(`${repo}/agents/triage.json`);
    const parsed = JSON.parse(content) as { instructions?: string; [k: string]: unknown };

    // 1. Move all structured fields into agents/triage/triage.json
    //    (drop the instructions string — it goes into common.md)
    const { instructions, ...structured } = parsed;
    await entityWriteFile(
      repo,
      "agents/triage",
      "triage.json",
      JSON.stringify(structured, null, 2),
    );

    // 2. Write the existing instructions verbatim to common.md
    if (typeof instructions === "string" && instructions.length > 0) {
      await entityWriteFile(repo, "agents/triage", "common.md", instructions);
    }

    // 3. cloud.md and local.md come from the bundled plugin defaults —
    //    plugin sync writes them on its next tick (write-once gate
    //    treats them as new files since the folder didn't exist).

    // 4. Delete the flat file
    await entityDeleteFile(repo, "agents", "triage.json");

    console.log("[migrate] flat agents/triage.json → agents/triage/ folder");
  } catch (e) {
    console.error("[migrate] V2 folder migration failed:", e);
  }
}
```

Run from `App.tsx` BEFORE `startCloudSyncs` (same ordering rule as V1's migration shim — must precede any cloud pull).

### Plugin manifest routing

`scripts/openit-plugin/manifest.json` adds entries for the new bundled files. Routes:

| Manifest path | Disk destination |
|---|---|
| `agents/triage/triage.template.json` | `agents/triage/triage.json` |
| `agents/triage/common.md` | `agents/triage/common.md` |
| `agents/triage/cloud.md` | `agents/triage/cloud.md` |
| `agents/triage/local.md` | `agents/triage/local.md` |

The existing `agents/<name>.template.json` routing rule in `skillsSync.ts:121-130` strips `.template` and lands at `agents/<name>.json`. With the folder layout, `routeFile` needs to handle the `agents/<folder>/<file>` pattern: strip `.template` from filenames if present, preserve folder structure. Markdown files (`.md`) pass through unchanged.

The write-once gate (added in V1) for `agents/*.json` extends to all files under `agents/<folder>/` — preserves user edits to `triage.json`, `common.md`, `cloud.md`, `local.md` across plugin version bumps.

### Edit tab UI (option B — full)

The Edit tab gets full form inputs:

```
┌─────────────────────────────────────────────────┐
│ Description                                     │
│ ┌─────────────────────────────────────────────┐ │
│ │ <input type="text">                         │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Common instructions (universal)                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ <textarea rows={10}>                        │ │
│ │   …common.md content…                       │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Cloud instructions (Pinkfish runtime)           │
│ ┌─────────────────────────────────────────────┐ │
│ │ <textarea rows={6}>                         │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Local instructions (OpenIT runtime)             │
│ ┌─────────────────────────────────────────────┐ │
│ │ <textarea rows={6}>                         │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Model        [haiku ▾]                          │
│ Shared       [ ] yes                            │
│                                                 │
│ Prompt bubbles (one per line)                   │
│ ┌─────────────────────────────────────────────┐ │
│ │ <textarea rows={4}>                         │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Intro message                                   │
│ ┌─────────────────────────────────────────────┐ │
│ │ <textarea rows={3}>                         │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ─── Resources ────────────────────────────────  │
│                                                 │
│ Knowledge bases                                 │
│   [✓] default       R [✓]  W [ ]  D [ ]         │
│                                                 │
│ Datastores                                      │
│   [✓] tickets       R [✓]  W [✓]  D [ ]         │
│   [✓] people        R [✓]  W [✓]  D [ ]         │
│   [✓] conversations R [✓]  W [✓]  D [ ]         │
│                                                 │
│ Filestores                                      │
│   [✓] library       R [✓]  W [ ]  D [ ]         │
│   [✓] attachments   R [✓]  W [ ]  D [ ]         │
│   [✓] skills        R [✓]  W [ ]  D [ ]         │
│   [✓] scripts       R [✓]  W [ ]  D [ ]         │
│                                                 │
│ ─── Tools ────────────────────────────────────  │
│                                                 │
│ MCP servers                                     │
│   [✓] knowledge-base       (all tools)          │
│   [✓] datastore-structured (all tools)          │
│   [✓] filestorage          (all tools)          │
│                                                 │
│              [Cancel]  [Save]                   │
└─────────────────────────────────────────────────┘
```

**Sourcing the collection lists.** On Edit-tab mount:
- KB: subscribe to `getSyncStatus()` (already exists in kbSync)
- Filestore: subscribe to `getFilestoreSyncStatus()` (already exists in filestoreSync)
- Datastore: call `resolveProjectDatastores(creds)` directly (no status helper exposed; one fetch per Edit-tab open)

**Empty state per section.** If the user has no collections of that type yet, show: `"No knowledge bases connected — connect cloud first"` (or equivalent for datastores / filestores).

**Validation.** At-least-one-permission per attached row. Unchecking all three removes the row from the array (mirrors platform's `validateResources`).

**Default permissions on first attach.** `canRead: true, canWrite: false, canDelete: false`. User toggles up.

**Save behavior.** Writes:
1. `triage.json` with structured fields (description, model, isShared, promptExamples, introMessage, resources, tools)
2. `common.md`, `cloud.md`, `local.md` with their respective textarea contents

If any write fails, surface the error inline and don't flip back to View mode.

**Tool servers.** V2 hardcodes the three default MCPs as the editable list. No "add custom server" option — that lives in V4 with the full Tools station UX.

### Read view rendering

The read mode (View tab) shows:

```
triage
First-line responder for incoming IT support questions. Logs every
ticket, searches the knowledge base, and either answers if a
confident match exists or escalates to a human admin.

DETAILS
ID            ua_d7qc4qfnodes708tr7sg
Model         haiku
Shared        No

INTRO MESSAGE
Hi! I'm the IT helpdesk triage bot. Try asking me a question…

PROMPT BUBBLES
• I can't access SharePoint
• VPN won't connect

RESOURCES
Knowledge bases   default
Datastores        tickets, people, conversations
Filestores        library, attachments, skills, scripts

TOOLS
MCP servers       knowledge-base, datastore-structured, filestorage

INSTRUCTIONS

Common
[markdown render of common.md]

Cloud-runtime
[markdown render of cloud.md]

Local-runtime
[markdown render of local.md]
```

---

## Files to modify

| File | Change |
|---|---|
| `src/lib/entities/agent.ts` | Widen `AgentRow` to V2 shape (drop `instructions`, add `selectedModel`/`isShared`/`promptExamples`/`introMessage`/`resources`/`tools`). Add `releaseUserAgent` REST wrapper. Add `resolveResourceRefs` helper. Add `assembleInstructionsForCloud(common, cloud)` helper. Update `canonicalizeForDisk` to omit V2 fields when absent. |
| `src/lib/agentSync.ts` | New `pushAllToAgents` body construction with omit-when-absent. Read three .md files, assemble for cloud. Resolve resource refs. Call release post-upsert with retry-on-fail. New `migrateFlatTriage` shim. Update dirty detection to include `triage/*.md` files. |
| `src/shell/Viewer.tsx` | Edit tab: full UI per the sketch above. Read tab: render new fields + three .md blocks side by side. Subscribe to KB/filestore status, fetch datastores list. |
| `src/shell/types.ts` | If `kind: "agent"` source needs the path of the .md files passed in (likely yes). |
| `src/lib/skillsSync.ts` | `routeFile` handles `agents/<folder>/<file>` pattern. Write-once gate covers `agents/<folder>/*` not just `agents/*.json`. |
| `src/lib/pushAll.ts` | `runAgent` skip-clean fall-through when any tracked agent has `release_pending`. Resource-related dirty detection (any `agents/triage/*.md` change makes the agent dirty). |
| `src/App.tsx` | Wire `migrateFlatTriage` before `startCloudSyncs`. Update sentinel paths if needed. |
| `src-tauri/src/intake.rs` | `load_triage_agent` reads `agents/triage/triage.json` (new path) AND assembles `common.md + local.md` for the prompt. |
| `scripts/openit-plugin/agents/triage/triage.template.json` | New bundled file. Structured shape per disk schema above (with default resources + tools). |
| `scripts/openit-plugin/agents/triage/common.md` | New bundled file. Default content per locked draft. |
| `scripts/openit-plugin/agents/triage/cloud.md` | New bundled file. Default content per locked draft. |
| `scripts/openit-plugin/agents/triage/local.md` | New bundled file. Default content per locked draft. |
| `scripts/openit-plugin/agents/triage.template.json` | DELETE (replaced by folder layout). |
| `scripts/openit-plugin/manifest.json` | Update entries: remove `agents/triage.template.json`, add the four new files in `agents/triage/`. |
| `scripts/openit-plugin/CLAUDE.md` | Update `agents/triage.json` references → `agents/triage/triage.json` (or the broader description that triage is a folder). |
| `scripts/openit-plugin/skills/ai-intake.md` | Update `agents/triage.json` reference → `agents/triage/` (intake reads triage.json + common.md + local.md). |
| `src/lib/agentSync.test.ts` | New tests per the test list below. Update existing tests for V2 shape. |
| `src/lib/entities/agent.test.ts` | New tests for `releaseUserAgent`, `resolveResourceRefs`, `assembleInstructionsForCloud`. |
| `src/lib/skillsSync.test.ts` | Update `routeFile` test for folder pattern. New write-once test for `agents/<folder>/*` files. |
| `src/lib/pushAll.test.ts` | New test: `runAgent` falls through skip-clean when manifest has `release_pending`. |

**File count:** ~13 files modified, 4 files added, 1 file deleted, 1 directory restructured.

---

## Implementation steps

### Step 1 — Pre-flight verifications

Same shape as V1's preflight. Append findings to `auto-dev/plans/2026-05-01-PIN-TBD-agent-sync-v2-preflight.md`.

1. **Confirm release endpoint shape.** Read `/Users/sankalpgunturi/Repositories/platform/services/useragent-releases.go`. Verify endpoint path (`POST /service/useragents/{id}/releases`?), required body, idempotency on no-change, return code semantics.
2. **Confirm PATCH body for V2 fields.** Re-verify `PatchUpdate` ([services/useragents.go:1102-1146](../../../platform/services/useragents.go#L1102)) overlays at the top-level for `selectedModel`, `isShared`, `promptExamples`, `introMessage`. Confirm arrays (`promptExamples`, `datastores`, etc.) are whole-replace.
3. **Confirm `DataCollectionReference` wire shape.** [entities/entities.go:1592-1601](../../../platform/entities/entities.go#L1592). Required fields: `id`, `name`, `canRead`, `canWrite`, `canDelete`, `proxyEndpointId`. Optional: `description`, `isStructured`. Confirm we drop description + isStructured on disk.
4. **Confirm `listAllCollections` REST endpoint.** What path / params does the platform expose to enumerate all collections in one call? If no single endpoint, what's the cheapest sequence?
5. **Confirm MCP server shape on the wire.** `entities.go:1745` `McpServer`: `name`, `serviceKey`, `allTools`, `tools`, `isDynamic`, `embedded`. We send only `name` + `allTools: true` for V2 — verify platform accepts that minimal shape.
6. **Inspect `autoCommitDriver.ts`.** Already verified clean in V1 review (lines 53-79 explicitly exclude agents); add a regression test that asserts `agents/triage/*.md` and `agents/triage/triage.json` are NOT in the auto-commit scope.
7. **Inspect plugin sync `routeFile`.** Confirm folder-layout files route correctly. May need a code change to handle the new pattern.

### Step 2 — Migration shim

Implement and wire FIRST so existing installs don't break on first launch with later steps:

1. Add `migrateFlatTriage(repo)` to `agentSync.ts` per the spec above
2. Add unit tests (3 cases: only-flat-exists migrates; only-folder-exists no-ops; both-exist no-ops)
3. Wire into `App.tsx` BEFORE `startCloudSyncs`
4. Manual smoke: drop the existing flat `agents/triage.json` into a fresh project, restart app, confirm folder layout appears with content preserved

### Step 3 — Bundled plugin files

1. Create the four new files under `scripts/openit-plugin/agents/triage/` with the locked default content
2. Update `scripts/openit-plugin/manifest.json` entries
3. Update `scripts/openit-plugin/CLAUDE.md` and `skills/ai-intake.md` references
4. Delete old `scripts/openit-plugin/agents/triage.template.json`
5. Update `skillsSync.ts` `routeFile` to handle `agents/<folder>/<file>` paths
6. Update write-once gate to cover `agents/<folder>/*` (not just `agents/*.json`)
7. Manual test: fresh install (no triage on disk) → plugin sync writes the folder layout

### Step 4 — Schema + adapters

1. Widen `AgentRow` in `entities/agent.ts` per disk schema. Drop `instructions` from the type.
2. Update `canonicalizeForDisk` to write `triage.json` (structured fields only) — DOES NOT include `instructions`. The .md files are written separately.
3. Update pull (`listRemote`) to project the cloud agent down: structured → `triage.json`, but `instructions` field gets compared against assembled-last-pushed for shadow detection (NOT written to disk on fast-forward).
4. Add typed REST wrappers: `releaseUserAgent`. Confirm `patchUserAgent` body shape supports the new fields.
5. Add `resolveResourceRefs(creds, local)` helper. Fresh `listAllCollections` fetch, filter by type, resolve names → wire shape.
6. Add `assembleInstructionsForCloud(common, cloud)` and `assembleInstructionsForLocal(common, local)` helpers (both: simple `${a}\n\n${b}`).
7. Unit tests per the test list.

### Step 5 — Push wrapper updates

1. `pushAllToAgents` dirty detection: include `agents/triage/*.md` files in the scope. Any block change makes the agent dirty.
2. Body construction: omit-when-absent rule for all V2 fields. Required: name, description, instructions (assembled).
3. Resource resolution + skip-with-warning failure mode.
4. Auto-release post-upsert. On failure, set `release_pending: true` in manifest entry.
5. Update `runAgent` in `pushAll.ts`: skip-clean falls through if any tracked agent has `release_pending`.
6. When fall-through fires for retry-only (no actual upsert needed), emit `▸ sync: agents retrying release for <name>` log and call `releaseUserAgent` directly.

### Step 6 — Pull wrapper updates

1. The cloud's full `instructions` string is informational on V2. Don't write to .md files on fast-forward (would conflate the three blocks).
2. On both-changed conflict: write `agents/triage/instructions.server.md` with cloud's verbatim `instructions` string. Engine's existing aggregate picks it up.
3. Manifest entry stores last-pushed assembled string for diff-detection (or its hash; cheaper).

### Step 7 — Edit tab UI

1. Subscribe to KB/filestore status; fetch datastore list on tab mount
2. Render the form per the sketch above
3. Save handler: write `triage.json` + three .md files
4. Validation: at-least-one-permission per attached resource row
5. Empty-state messages per section
6. Manual test: every field edits and saves; cancel discards; save+commit pushes correctly

### Step 8 — Read view + intake

1. Read view renders: details table + new fields + three .md sections (markdown rendered)
2. Intake.rs: `load_triage_agent` reads new path (`agents/triage/triage.json`) AND assembles `common.md + local.md` for the subprocess prompt

### Step 9 — Verification

```
cd /Users/sankalpgunturi/Repositories/openit-app/.claude/worktrees/agent-aa4e0224a210adc9c
npx tsc --noEmit -p .
npm test
cargo test  (in src-tauri/)
```

All green. Manual test the 10 scenarios below.

---

## Tests

### Unit tests

| Test | File | Verifies |
|---|---|---|
| `migrateFlatTriage moves flat → folder` | `agentSync.test.ts` | Three states: only-flat → migrates; only-folder → no-op; both → no-op |
| `migrateFlatTriage preserves user instructions verbatim` | `agentSync.test.ts` | `instructions` from flat lands in common.md unchanged |
| `assembleInstructionsForCloud joins common + cloud` | `entities/agent.test.ts` | `${common}\n\n${cloud}`; handles missing files |
| `releaseUserAgent fires POST /releases` | `entities/agent.test.ts` | Endpoint hit with correct URL |
| `releaseUserAgent throws on non-2xx` | `entities/agent.test.ts` | Failure surfaces |
| `resolveResourceRefs uses fresh REST fetch` | `entities/agent.test.ts` | Doesn't depend on cached engine state |
| `resolveResourceRefs returns wire shape with id + proxyEndpointId` | `entities/agent.test.ts` | Local name → cloud `openit-<name>` → wire ref |
| `resolveResourceRefs skips unresolved with warning` | `entities/agent.test.ts` | Bad name returns null + log; doesn't throw |
| `pushAllToAgents body omits absent V2 fields` | `agentSync.test.ts` | Disk file with no `selectedModel` → body has no `selectedModel` |
| `pushAllToAgents body includes V2 fields when present` | `agentSync.test.ts` | Each V2 field round-trips |
| `pushAllToAgents calls release post-upsert` | `agentSync.test.ts` | Release fires on success |
| `pushAllToAgents sets release_pending on release failure` | `agentSync.test.ts` | Manifest entry gets the flag; pushed count still increments |
| `pushAllToAgents retries release when manifest has release_pending` | `agentSync.test.ts` | Even with no other dirty, release fires |
| `runAgent skip-clean falls through when release_pending set` | `pushAll.test.ts` | Tracked agent with flag bypasses skip |
| `routeFile handles agents/<folder>/<file>` | `skillsSync.test.ts` | `agents/triage/common.md` → `agents/triage/common.md` |
| `routeFile strips .template from triage/triage.template.json` | `skillsSync.test.ts` | `agents/triage/triage.template.json` → `agents/triage/triage.json` |
| `syncSkillsToDisk preserves user-edited triage/*.md` | `skillsSync.test.ts` | Write-once gate covers folder contents |
| `auto-commit driver doesn't include agents/triage/*` | `autoCommitDriver.test.ts` | Regression test for V1 review finding |

### Manual scenarios

Authored as a separate file `auto-dev/plans/2026-05-01-PIN-TBD-agent-sync-v2-manual-testing.md` once implementation is ready. Sketch:

1. **Fresh install** — empty project, connect cloud, confirm `agents/triage/` folder lands with all four files. Cloud builder shows triage as Published with all default resources/tools attached.
2. **Migration** — V1 install with flat `agents/triage.json` containing customized instructions. Restart with V2. Confirm shim moves it to folder layout, `common.md` has the user's text, `cloud.md`/`local.md` have bundled defaults, flat file deleted.
3. **Edit common.md → push** — change a sentence in common.md, Commit. Web shows the change in `instructions` (in both `common`+`cloud` portions). Local intake also picks it up (test by running an intake turn).
4. **Edit cloud.md → push** — change cloud-only HOW, Commit. Web shows the change. Local intake unchanged.
5. **Edit local.md → push** — change local-only HOW, Commit. Web does NOT change (local.md isn't sent). Local intake picks up the change.
6. **Edit Phase A field via UI** — change model from haiku to sonnet via dropdown, Save, Commit. Web reflects.
7. **Detach a resource** — uncheck `people` datastore in Edit, Save, Commit. Web shows agent without people attached.
8. **Reference unresolvable resource** — manually edit triage.json to add `{name: "nonexistent"}`, Commit. Push log shows `⚠ skipping datastore "nonexistent"`. Other resources still attach.
9. **Release failure simulation** — block release endpoint (e.g. mock or break network mid-push), confirm `release_pending` lands in manifest, agent shows pushed but not released. Restore network, next sync retries. Web shows agent as Published.
10. **Both-sides edit instructions** — edit on web, then edit `cloud.md` locally without first pulling. Push. Confirm conflict: `agents/triage/instructions.server.md` shadow file appears, banner shows. Resolve script + retry push works.

---

## Implementation checklist

- [ ] **Step 1 — Pre-flight**
  - [ ] Release endpoint path + body confirmed
  - [ ] PATCH overlay semantics for V2 fields confirmed
  - [ ] DataCollectionReference wire shape confirmed
  - [ ] listAllCollections REST surface identified
  - [ ] McpServer minimal-shape acceptance confirmed
  - [ ] autoCommitDriver scope re-verified
  - [ ] routeFile changes scoped
- [ ] **Step 2 — Migration shim**
  - [ ] migrateFlatTriage implemented + tested
  - [ ] App.tsx wires it before startCloudSyncs
  - [ ] Smoke-tested with a synthetic flat install
- [ ] **Step 3 — Bundled plugin files**
  - [ ] Four new files created with locked default content
  - [ ] manifest.json updated
  - [ ] Plugin doc + skill references updated
  - [ ] Old triage.template.json deleted
  - [ ] routeFile handles new path
  - [ ] Write-once gate covers folder contents
- [ ] **Step 4 — Schema + adapters**
  - [ ] AgentRow widened, instructions dropped
  - [ ] canonicalizeForDisk writes structured-only
  - [ ] releaseUserAgent + resolveResourceRefs + assemble helpers
  - [ ] Unit tests
- [ ] **Step 5 — Push wrapper**
  - [ ] Dirty detection includes `agents/triage/*.md`
  - [ ] Omit-when-absent body
  - [ ] Resource skip-with-warning
  - [ ] Auto-release with release_pending retry
  - [ ] Skip-clean fall-through for pending releases
- [ ] **Step 6 — Pull wrapper**
  - [ ] Manifest tracks last-pushed assembled instructions
  - [ ] Both-changed → write instructions.server.md shadow
- [ ] **Step 7 — Edit tab UI**
  - [ ] Three .md textareas
  - [ ] Phase A field inputs
  - [ ] Three resource sections with collection lists, validation, empty states
  - [ ] Tools toggles
  - [ ] Save handler writes JSON + 3 MDs
- [ ] **Step 8 — Read view + intake**
  - [ ] Read tab renders new fields + three blocks
  - [ ] intake.rs reads new path + assembles common+local
- [ ] **Step 9 — Verification**
  - [ ] `npx tsc --noEmit -p .` clean
  - [ ] `npm test` green
  - [ ] `cargo test` green
  - [ ] All 10 manual scenarios pass

---

## Risks & open items

1. **Edit tab UI complexity.** Option B is a meaningful expansion — three resource pickers with permission checkboxes, MCP toggles, three textareas. Estimate: ~half the V2 work. If implementation runs long, consider falling back to option A (Phase A inputs + Raw-only for resources/tools) for V2 ship and add the resource UI in V2.1.
2. **`release_pending` flag in manifest** is new schema. The `KbStatePersisted` type may need extending. Backward compat: treat absence as `false`.
3. **Cloud `instructions` round-trip.** We're explicitly not pulling `instructions` to disk (only writing on conflict shadow). If a real user edits on web AND we don't surface the shadow correctly (e.g. our last-pushed cache is wrong), edits get silently overwritten. V1 had the same risk for description/instructions; V2 inherits it. Worth testing scenario 10 thoroughly.
4. **Migration shim runs before plugin sync** in the same launch. If migration creates the folder, plugin sync sees it and applies the write-once gate, so bundled `cloud.md`/`local.md` get written (folder is new) but if migration already wrote `common.md`, the gate preserves it. Verify the ordering is correct in `App.tsx`.
5. **Datastore collection-list fetch** at Edit-tab open is one extra REST call per Edit. Negligible, but document the latency.
6. **Three .md files instead of one** could feel like over-engineering to a casual user. The Edit tab labels them clearly; the read view shows all three. Worth watching whether real users get confused.
7. **`routeFile` change** is a small but cross-cutting plugin-sync change. Test thoroughly to avoid breaking other entity routes (KB, filestores, etc.).
8. **Bundled `cloud.md` references real Pinkfish MCP tool names.** If platform tool naming shifts (e.g. `knowledge-base_ask` → `kb_search`), the bundled translation breaks for new installs and the user has to re-edit. V2 ships with current names; we accept this drift risk.

## What V2 unlocks

- **V3 (channels):** the `latestRelease > 0` gate is satisfied. Org-wide Slack/Teams routing on Pinkfish is one OAuth flow away.
- **V4 (Tools station + workflows):** the disk schema for tools is established. V4 expands the editing surface; data shape stays the same.
- **Multi-agent creation in OpenIT:** the folder-per-agent layout is now first-class. Future "New Agent" button writes a new folder; everything else is the same.
