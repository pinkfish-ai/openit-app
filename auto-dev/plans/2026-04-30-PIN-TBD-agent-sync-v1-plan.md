# Agent sync V1 — push the triage agent to Pinkfish

**Date:** 2026-04-30
**Ticket:** PIN-TBD
**Status:** Draft (stage 02), revised after self-critique
**Owner:** Sankalp

---

## Problem

OpenIT today pulls Pinkfish agents read-only and stores a 6-field subset on disk. The user can edit `agents/triage.json` instructions in OpenIT, but those edits never leave the laptop. Hitting "Sync to Cloud" doesn't do anything for agents — only KB / filestore / datastore push.

Three other gaps surface alongside this:

1. **Naming inconsistency** — the plugin template writes `agents/triage.json` (`name: "triage"`); App.tsx's bootstrap sentinel checks `agents/openit-triage-${slug}.json` ([App.tsx:87](../../src/App.tsx#L87)); the remote-list filter requires the `openit-` prefix ([entities/agent.ts:96](../../src/lib/entities/agent.ts#L96)). All three disagree.
2. **Pull strips silently** — pulled agents land on disk with `selectedModel` and `isShared` baked in, but V1 push won't carry those fields. If the user edits `selectedModel` on disk, the change is silently dropped on push. Fix: narrow on-disk shape to exactly the fields V1 owns.
3. **Plugin sync clobbers user edits** — `syncSkillsToDisk` writes `agents/*.json` unconditionally on every plugin version bump ([skillsSync.ts:191-196](../../src/lib/skillsSync.ts#L191)). Today this is invisible because users have no reason to edit the agent (they can't push). Once V1 ships, plugin bumps will silently overwrite user instructions. **This is a blocker.**

## Desired outcome

A user runs OpenIT, opens `agents/openit-triage.json`, edits the `instructions` field, clicks "Sync to Cloud" in the Sync tab, and sees the new instructions in the Pinkfish web agent builder within seconds. The reverse loop (edit on web, pull to disk on the next 60s tick) also works. Conflict on both sides surfaces a `openit-triage.server.json` shadow + banner via the existing pull pipeline (no new shadow code).

## Success criteria

- [ ] On a fresh OpenIT install with cloud connected, `agents/openit-triage.json` lands on disk with `{id, name, description, instructions}` only (no `selectedModel`, no `isShared`, no `updatedAt`).
- [ ] User edits `instructions` locally → click Commit → push request goes out → Pinkfish web shows the new instructions on the `openit-triage` agent.
- [ ] User edits `instructions` on web → next 60s poll pulls the change to disk → no conflict.
- [ ] User edits both sides → push pre-pull surfaces conflict via the existing pull pipeline → `openit-triage.server.json` shadow appears → banner shows "Resolve in Claude" → resolve script + retry push works.
- [ ] If cloud has no `openit-triage` agent yet, push creates it via POST. Disk file is rewritten with the server-issued `id`. Manifest's `pulled_at_mtime_ms` is bumped to the post-write mtime so the next poll doesn't re-flag the file as dirty.
- [ ] PATCH body sends ONLY `{name, description, instructions}` — never `acl`, `apiKeyId`, `slack`, `servers`, `metadata`, `selectedModel`, `isShared`, etc. POST body sends the same plus whatever minimal defaults the platform Create handler requires (TBD — see Open Question 1).
- [ ] HTTP 409 (version conflict) on PATCH: caller catches the error, runs a re-pull which writes the shadow, surfaces conflict via the existing pull pipeline. **No silent retry that could clobber.**
- [ ] Plugin version bumps after V1 do **not** overwrite user-edited `agents/openit-triage.json`.
- [ ] Existing read-only pull behavior for non-triage `openit-*` agents continues to work (no regression).

## Out of scope (deferred to V2+)

- Tools, MCP servers, resources, channels, prompt bubbles, model, output schema, metadata (background/icon/dashboard), workflows, API keys, sharing, releases, ACL.
- `connect-slack` rewrite — stays local Socket Mode.
- A generic `EntityAdapter`-level push contract. V1 keeps push functions on `agentSync.ts`, mirroring how `kbSync.ts`/`filestoreSync.ts`/`datastoreSync.ts` already work. Workflow push (Phase 5c) will inform whether a shared abstraction is worth building later.
- Multi-instance / multi-laptop conflict scenarios beyond what the existing engine handles.
- Banner / toast for push errors (V1 surfaces all errors in the Sync tab streaming log only).

---

## Architecture (revised)

The V1 design keeps the engine surface narrow:

- **No new `EntityAdapter` fields.** Agents push through their own wrapper, mirroring KB/filestore/datastore. The reviewer caught that `EntityAdapter` is a pull contract today; widening it is a half-abstraction that the four other entities don't use. Defer until at least two entities need the same shape.
- **One shared addition to `syncEngine.ts`:** export an `OutOfSync` error class. Cross-cutting; lives at the engine level for any future push wrapper to use.
- **Conflict shadows come from the existing pull pipeline.** Every push starts with a pre-push `pullAgentsOnce`. If cloud changed underneath us, the pull writes a shadow + records a conflict; push aborts. The PATCH-throws-409 path is a **race-window safety net** (remote edit between pre-pull and PATCH) that triggers another `pullAgentsOnce` to write the shadow. **No engine changes for shadows.**
- **Post-write mtime bump.** After POST-and-write-back-id, manifest `pulled_at_mtime_ms` is set to the post-write file mtime so the next poll tick doesn't see the file as dirty. Mirrors KB's post-push baseline reset.
- **Plugin manifest write-once for agents.** `syncSkillsToDisk` gets a `routeFile`-aware skip rule: if the destination is under `agents/` and already exists on disk, skip the write. This protects user edits across plugin version bumps. Same effect as the seed pipeline's per-file gate.

---

## Files to modify

| File | Change |
|---|---|
| `src/lib/syncEngine.ts` | Add `export class OutOfSync extends Error`. No other changes. |
| `src/lib/entities/agent.ts` | Narrow `AgentRow` to `{id, name, description, instructions}`. Strip `selectedModel`/`isShared`/`updatedAt`/`createdAt` in `canonicalizeForDisk`. Add typed REST wrappers `getUserAgent`, `postUserAgent`, `patchUserAgent`, `deleteUserAgent`. Map 409 responses to `OutOfSync` throws. |
| `src/lib/agentSync.ts` | Add `pushAllToAgents({creds, repo, onLine})` — git-status-driven dirty detection + per-file POST/PATCH + manifest reconcile + auto-commit. Add `pullAgentsOnce` helper exposing the engine's existing pull as a once-and-return surface (mirroring `filestorePullOnce`/`pullDatastoresOnce`). Read-only `startAgentSync` keeps its current behavior. |
| `src/lib/pushAll.ts` | Add an agent block (pre-pull → conflict gate → push) following the filestore block's structure. Position between datastore and the closing log line. |
| `src/lib/skillsSync.ts` | In the `syncSkillsToDisk` writer, skip writing `agents/*.json` files that already exist on disk. (Same write-once gate idea as `seed.ts`'s `fileExists`.) |
| `src/App.tsx` | Update bootstrap sentinel from `openit-triage-${slug}.json` to `openit-triage.json`. Run migration shim **before** `startCloudSyncs`. |
| `scripts/openit-plugin/manifest.json` | Update the manifest entry from `agents/triage.template.json` → `agents/openit-triage.template.json`. |
| `scripts/openit-plugin/agents/triage.template.json` | Rename to `openit-triage.template.json`. Inside, change `name: "triage"` → `name: "openit-triage"`. Drop `selectedModel: "haiku"` and `isShared: false` (out of V1 scope, will get platform defaults on POST). |
| `scripts/openit-plugin/CLAUDE.md` | Replace `agents/triage.json` references (2 of them — directory layout table line, and the "The triage agent" prose section). |
| `scripts/openit-plugin/skills/ai-intake.md` (or wherever `ai-intake` lives) | Replace `agents/triage.json` references. Confirm by grep. |
| `src/lib/skillsSync.test.ts` | Update the four test assertions referencing `agents/triage.template.json` to the new filename. |
| `src/lib/agentSync.ts` (migration shim) | New function `migrateLegacyTriageFilename(repo)` — if `agents/triage.json` exists and `agents/openit-triage.json` does not, rename + rewrite the in-file `name` field (only if the existing `name === "triage"`; otherwise preserve user-edited name). Called from App.tsx **before** `startCloudSyncs`. |

**File count:** ~12 files modified, 1 file renamed.

---

## Implementation steps

### Step 1 — Pre-flight verifications (do before writing TS)

These would block the implementer if skipped:

1. **Confirm POST required fields.** `cd /Users/sankalpgunturi/Repositories/platform && grep -n "func.*Create.*UserAgent\|handleCreateUserAgent" servers/appapi/useragents.go services/useragents.go`. Read the Create handler and identify any field beyond `{name, description, instructions}` that's required at create time. Common candidates: `selectedModel` (may default server-side), `version` (likely server-side), `acl` (computed). Update the POST body in Step 4 to include any required-on-create field with a sensible default.
2. **Confirm PATCH 409 error shape.** Same grep — find where `OutOfSync` is mapped to HTTP. Likely `repo/useragents.go:380`. Confirm response status is 409 and the body shape so the TS adapter can detect it (status code is enough; body parse is a nice-to-have).
3. **Grep `selectedModel` and `isShared` across `src/`.** If any UI component reads these off `AgentRow` (FileExplorer, Viewer, an agent panel), narrowing the type breaks compilation. Either remove the reads (V1 doesn't expose those fields) or stage the narrowing for later. Likely there are no reads — but grep first.
4. **Smoke-test the runtime token against PATCH.** Get a runtime token from a running OpenIT instance (Keychain). `curl -X PATCH https://app-api.<env>.pinkfish.ai/service/useragents/<existing-id> -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"description":"smoke test"}' -i`. Confirm 200. Confirms write scope.
5. **Confirm plugin manifest path.** Read `scripts/openit-plugin/manifest.json` to find the agent template entry. Confirm the routing logic in `skillsSync.ts:121-130`'s `routeFile` actually strips `.template.json` for agents. Likely yes.

### Step 2 — `OutOfSync` error in `syncEngine.ts`

```ts
export class OutOfSync extends Error {
  constructor(public readonly serverHint?: string) {
    super(serverHint ? `out of sync: ${serverHint}` : "out of sync");
    this.name = "OutOfSync";
  }
}
```

That's it. No other engine change.

### Step 3 — Narrow `AgentRow` + typed REST in `entities/agent.ts`

```ts
export type AgentRow = {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
};

function canonicalizeForDisk(agent: AgentRow): string {
  return JSON.stringify(
    {
      id: agent.id,
      name: agent.name,
      description: agent.description ?? "",
      instructions: agent.instructions ?? "",
    },
    null,
    2,
  );
}
```

Update `listUserAgents` to map exactly these 4 fields (drop `selectedModel`, `isShared`, `updatedAt`, `createdAt` from the returned `AgentRow`). The manifest still tracks `updatedAt` separately; it's read off the API response inline in `listRemote` rather than carried through `AgentRow`.

Add typed REST wrappers (using `makeSkillsFetch(token, "bearer")` per the existing pattern at `entities/agent.ts:70`):

```ts
type FullAgentResponse = { id: string; name: string; description?: string;
  instructions?: string; version?: number; versionDate?: string;
  /* … other fields exist but we don't read them */ };

async function getUserAgent(creds: PinkfishCreds, id: string): Promise<FullAgentResponse>;
async function postUserAgent(creds: PinkfishCreds, body: object): Promise<FullAgentResponse>;
async function patchUserAgent(creds: PinkfishCreds, id: string, body: object): Promise<FullAgentResponse>;
async function deleteUserAgent(creds: PinkfishCreds, id: string): Promise<void>;
```

Inside `patchUserAgent`, on `resp.status === 409`, throw `new OutOfSync()`. (Body parse for additional context is optional.)

### Step 4 — `pushAllToAgents` in `agentSync.ts`

Mirrors `pushAllToKb`. Pseudocode:

```ts
export async function pushAllToAgents(args: {
  creds: PinkfishCreds; repo: string; onLine: (line: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  return withRepoLock(repo, "agent", async () => {
    const allFiles = await gitStatusShort(repo);
    const dirty = allFiles
      .filter(f => f.path.startsWith("agents/") && f.path.endsWith(".json"))
      .filter(f => !f.path.includes(".server."))
      .map(f => f.path.replace("agents/", ""));

    if (dirty.length === 0) return { pushed: 0, failed: 0 };

    const manifest = await invoke<Manifest>("entity_state_load", { repo, name: "agent" });
    const touched: string[] = [];
    let pushed = 0, failed = 0;

    for (const filename of dirty) {
      try {
        const localStr = await fsRead(`${repo}/agents/${filename}`);
        const parsed: AgentRow = JSON.parse(localStr);

        let serverAgent: FullAgentResponse;
        if (!parsed.id) {
          // Create flow.
          serverAgent = await postUserAgent(creds, {
            name: parsed.name,
            description: parsed.description ?? "",
            instructions: parsed.instructions ?? "",
            // + any required-on-create defaults from Step 1
          });
          // Write the server-issued id back to disk, then bump manifest mtime
          // baseline so the next poll doesn't re-flag this file as dirty.
          parsed.id = serverAgent.id;
          await entityWriteFile(repo, "agents", filename, canonicalizeForDisk(parsed));
        } else {
          // Update flow — read-merge-PATCH. Read for current state (we don't
          // need it for the body since PATCH overlays, but a parallel edit
          // surface should have already been caught by pre-push pull).
          serverAgent = await patchUserAgent(creds, parsed.id, {
            name: parsed.name,
            description: parsed.description ?? "",
            instructions: parsed.instructions ?? "",
          });
        }

        // Manifest reconcile: refresh remote_version + mtime baseline.
        const localStat = await invoke<{ mtime_ms: number }>("entity_stat", {
          repo, subdir: "agents", filename,
        });
        manifest.files[filename] = {
          remote_version: serverAgent.versionDate ?? new Date().toISOString(),
          pulled_at_mtime_ms: localStat.mtime_ms,
          conflict_remote_version: undefined,
        };
        touched.push(`agents/${filename}`);
        onLine(`  ✓ pushed ${filename}`);
        pushed++;
      } catch (e) {
        if (e instanceof OutOfSync) {
          // Race-window catch: remote changed between pre-pull and PATCH.
          // Trigger a re-pull which writes a shadow and records the
          // conflict via the existing pull pipeline.
          onLine(`  ✗ ${filename}: out of sync — re-pulling`);
          await pullEntity(buildAgentAdapter(creds), repo);
          failed++;
        } else {
          onLine(`  ✗ ${filename}: ${String(e)}`);
          failed++;
        }
      }
    }

    await invoke("entity_state_save", { repo, name: "agent", state: manifest });
    if (touched.length > 0) {
      await commitTouched(repo, touched, `sync: push @ ${new Date().toISOString()}`);
    }
    return { pushed, failed };
  });
}
```

Note: `entity_stat` may not exist as a Tauri command yet — if not, derive mtime from a fresh `entity_list_local` call (already exists). Implementer to check and pick the lower-friction path.

`pullAgentsOnce` is a thin wrapper that calls `pullEntity(buildAgentAdapter(creds), repo)` once and returns the resulting `{ pulled, conflicts, ok, error }` shape. Same pattern as `filestorePullOnce` (`filestoreSync.ts`).

### Step 5 — Wire into `pushAll.ts`

After the datastore block ([pushAll.ts:188-196](../../src/lib/pushAll.ts#L188)), before the final `▸ sync: done` log, add:

```ts
onLine("▸ sync: agents pre-push pull");
let agentPushSafe = true;
try {
  const { ok, pulled, conflicts, error } = await pullAgentsOnce({ creds, repo });
  if (!ok) {
    agentPushSafe = false;
    onLine(`✗ sync: agents pre-push pull failed: ${error ?? "unknown"}`);
  } else if (conflicts.length > 0) {
    agentPushSafe = false;
    onLine("✗ sync: agents pull surfaced conflicts — resolve in Claude, then commit again:");
    for (const c of conflicts) onLine(`  • ${c.filename}: ${c.reason}`);
  } else if (pulled > 0) {
    onLine(`  ✓ pulled ${pulled} agent(s) before push`);
  }
} catch (e) {
  agentPushSafe = false;
  onLine(`✗ sync: agents pre-push pull failed: ${String(e)}`);
}
if (agentPushSafe) {
  onLine("▸ sync: agents pushing");
  try {
    const { pushed, failed } = await pushAllToAgents({ creds, repo, onLine });
    onLine(`▸ sync: agent push complete — ${pushed} ok, ${failed} failed`);
  } catch (e) {
    onLine(`✗ sync: agent push failed: ${String(e)}`);
  }
}
```

### Step 6 — Plugin manifest write-once gate for agents

In `skillsSync.ts`, find the writer that fans out the manifest to disk (around line 191). Before each write, check if the destination is under `agents/` and already exists. If so, skip and log `[skills] preserved user-edited <path>`.

```ts
async function writeManifestFile(repo: string, route: { subdir: string; filename: string }, content: string) {
  if (route.subdir === "agents") {
    const exists = await fileExistsOnDisk(repo, route.subdir, route.filename);
    if (exists) {
      console.log(`[skills] preserved user-edited ${route.subdir}/${route.filename}`);
      return;
    }
  }
  await invoke("entity_write_file", { repo, ...route, content });
}
```

This is the same gate `seed.ts` uses for sample data. Without it, every plugin version bump silently overwrites user-edited agent instructions.

### Step 7 — Migration shim

In `agentSync.ts`:

```ts
export async function migrateLegacyTriageFilename(repo: string): Promise<void> {
  const oldExists = await fileExistsOnDisk(repo, "agents", "triage.json");
  const newExists = await fileExistsOnDisk(repo, "agents", "openit-triage.json");
  if (!oldExists || newExists) return; // nothing to do, or new already wins
  try {
    const content = await fsRead(`${repo}/agents/triage.json`);
    const parsed = JSON.parse(content);
    // Only rewrite name if it's still the default; preserve user-edited name.
    if (parsed.name === "triage") parsed.name = "openit-triage";
    await entityWriteFile(repo, "agents", "openit-triage.json", JSON.stringify(parsed, null, 2));
    await entityDeleteFile(repo, "agents", "triage.json");
    console.log("[migrate] renamed agents/triage.json → agents/openit-triage.json");
  } catch (e) {
    console.error("[migrate] failed:", e);
  }
}
```

In `App.tsx`, call `await migrateLegacyTriageFilename(repo)` **before** `startCloudSyncs`. This must run before any agent pull, otherwise:

> If the user has a stale `openit-triage` on cloud (from a prior test) AND a local `triage.json` with edited instructions, a cloud-pull-first ordering writes the cloud version to `openit-triage.json` BEFORE the shim runs. The shim then sees `openit-triage.json` already exists and bails. The user's local edits are lost. — Reviewer flagged this; ordering is the fix.

### Step 8 — Renames + reference updates

```bash
# In the worktree:
git mv scripts/openit-plugin/agents/triage.template.json scripts/openit-plugin/agents/openit-triage.template.json
```

Then edit:
- The renamed file: `name: "triage"` → `name: "openit-triage"`. Drop `selectedModel`, `isShared`.
- `scripts/openit-plugin/manifest.json`: update the entry path.
- `scripts/openit-plugin/CLAUDE.md`: 2 references to `agents/triage.json` → `agents/openit-triage.json`.
- `scripts/openit-plugin/skills/ai-intake.md` (and grep for any other `triage.json` references): same rename.
- `src/lib/skillsSync.test.ts`: 4 assertions referencing `agents/triage.template.json` → `agents/openit-triage.template.json`.
- `src/App.tsx:87`: sentinel filename `openit-triage-${slug}.json` → `openit-triage.json`.

Verify completeness: `cd openit-app && grep -rn "triage\.json\|triage\.template\.json" src/ scripts/ src-tauri/ auto-dev/` after the renames. Anything not under a planned change is a missed reference.

---

## Tests

### Unit tests

| Test | File | Verifies |
|---|---|---|
| `canonicalizeForDisk drops everything except 4 fields` | `src/lib/entities/agent.test.ts` | Pulled agent with `selectedModel`/`isShared`/`updatedAt` lands on disk with only `{id,name,description,instructions}`. |
| `patchUserAgent throws OutOfSync on 409` | `src/lib/entities/agent.test.ts` | Mock fetch returning 409 → throw is `OutOfSync`. |
| `patchUserAgent body is exactly 3 fields` | `src/lib/entities/agent.test.ts` | The PATCH body sent to the server has only `{name, description, instructions}` keys, no extras. |
| `pushAllToAgents skips clean files` | `src/lib/agentSync.test.ts` | Mock `gitStatusShort` returning empty → no REST calls fired. |
| `pushAllToAgents skips shadow files` | `src/lib/agentSync.test.ts` | Dirty list includes `openit-triage.server.json` → it is not pushed. |
| `pushAllToAgents POSTs when id missing, then bumps manifest mtime` | `src/lib/agentSync.test.ts` | File with empty/no `id` triggers POST; afterward, manifest's `pulled_at_mtime_ms` matches the post-write file mtime. |
| `pushAllToAgents PATCHes when id present` | `src/lib/agentSync.test.ts` | File with `id: "ua_…"` triggers PATCH (no GET-then-PATCH unless we add that for Step 4 read-merge — see open Q5). |
| `pushAllToAgents calls re-pull on OutOfSync` | `src/lib/agentSync.test.ts` | Mock PATCH 409 → assert `pullEntity` is called and the failure count increments. |
| `migrateLegacyTriageFilename moves only when old exists and new does not` | `src/lib/agentSync.test.ts` | Three cases: only old → moves; both → no-op; only new → no-op. |
| `migrateLegacyTriageFilename preserves user-edited name` | `src/lib/agentSync.test.ts` | If old file's name is `"my-agent"`, after migration the new file still has `name: "my-agent"`. |
| `skillsSync preserves user-edited agent files` | `src/lib/skillsSync.test.ts` | Existing `agents/openit-triage.json` is not overwritten on subsequent `syncSkillsToDisk` calls. |

### Manual scenarios

Authored as a separate file `auto-dev/plans/2026-04-30-PIN-TBD-agent-sync-v1-manual-testing.md` once the implementation is ready. Sketch:

1. Fresh-pull happy path — connect cloud on empty project; assert `agents/openit-triage.json` lands with 4 fields.
2. Local edit → push — edit instructions, click Commit, assert web shows new instructions.
3. Remote edit → pull — edit instructions on web, wait 60s, assert disk file updates clean.
4. Both edits → conflict — edit both sides, click Commit, assert shadow + banner; resolve and re-commit.
5. First push (cloud has no agent) — push from a project that's never seen cloud; assert POST + write-back of `id`. Wait one poll tick; assert no spurious dirty status (mtime baseline working).
6. Plugin version bump preserves user edits — bump `bundledPlugin.version` locally, restart app, assert `agents/openit-triage.json` instructions are unchanged.
7. Migration — start with `agents/triage.json` on disk, restart app, assert it moves to `openit-triage.json` and contents preserved.
8. Stale-cloud migration — same as #7 but cloud has an old `openit-triage`. Confirm shim runs before pull (i.e. ordering in App.tsx). Assert local edits survive.
9. PATCH race — manually script a 409 (mock the API or coordinate with another session). Assert push surfaces the conflict via the re-pull path.
10. Non-triage agent regression — create `openit-helpdesk` on web, confirm it pulls read-only; create one locally with `id: ""`, push, confirm it gets created on cloud.

---

## Implementation checklist

- [ ] **Step 1 — Pre-flight verifications** (do FIRST; block on any failure)
  - [ ] POST handler required fields confirmed
  - [ ] PATCH 409 status code confirmed
  - [ ] Grep `selectedModel` / `isShared` across `src/` — no UI reads, or fix them
  - [ ] Smoke-test runtime token against PATCH on a real cloud agent
  - [ ] Plugin manifest path confirmed
- [ ] **Step 2 — `OutOfSync` in `syncEngine.ts`**
  - [ ] Add the class export, no other engine changes
- [ ] **Step 3 — Narrow `AgentRow` + typed REST**
  - [ ] Update type
  - [ ] Update `canonicalizeForDisk`
  - [ ] Update `listUserAgents` mapping
  - [ ] Add `getUserAgent`/`postUserAgent`/`patchUserAgent`/`deleteUserAgent`
  - [ ] Map 409 → `OutOfSync`
  - [ ] Unit tests for the above
- [ ] **Step 4 — `pushAllToAgents` + `pullAgentsOnce`**
  - [ ] Implement per spec above (note the post-write mtime bump — critical)
  - [ ] Unit tests including the OutOfSync re-pull path
- [ ] **Step 5 — Wire into `pushAll.ts`**
  - [ ] Add agent block after datastore
  - [ ] Manual smoke: hit Commit and verify Sync tab shows agent lines
- [ ] **Step 6 — Plugin manifest write-once gate**
  - [ ] Skip rule for `agents/*.json`
  - [ ] Unit test in `skillsSync.test.ts`
- [ ] **Step 7 — Migration shim**
  - [ ] Implement `migrateLegacyTriageFilename`
  - [ ] Wire into `App.tsx` BEFORE `startCloudSyncs` (ordering matters)
  - [ ] Unit tests for the three cases
- [ ] **Step 8 — Renames**
  - [ ] `git mv` template
  - [ ] Rename in template (`name`, drop fields)
  - [ ] Manifest entry updated
  - [ ] CLAUDE.md (2 refs)
  - [ ] `ai-intake.md` (and any other refs — grep)
  - [ ] `skillsSync.test.ts` (4 refs)
  - [ ] `App.tsx` sentinel
  - [ ] Final grep audit: `grep -rn "triage\.json\|triage\.template\.json" src/ scripts/ src-tauri/ auto-dev/` — flag anything unplanned
- [ ] **Verification**
  - [ ] `npm run code-check --workspace=@pinkfish/app` passes
  - [ ] `npm run biome:write` clean
  - [ ] `npm test` (vitest) passes — including the new agent tests
  - [ ] `cargo test` passes if any Rust touches (probably not for V1)
  - [ ] Spot-check the Sync tab logs end-to-end with `npm run tauri dev`

---

## Open questions (must answer during Step 1)

1. **POST required fields beyond `{name, description, instructions}`** — Status: open. Will be answered by reading the platform Create handler in Step 1.
2. **PATCH 409 vs other error codes** — Status: open. Need to confirm 409 is the actual status from the OutOfSync error path. If platform returns 412 or 400-with-message, adjust the mapping.
3. **`entity_stat` Tauri command exists?** — Status: open. If not, use `entity_list_local` and pick the matching filename. Implementer's call.
4. **Does PATCH overlay the body, or full-replace?** — Status: confirmed PATCH overlays per the platform discovery agent's report ([services/useragents.go:267-294](../../../platform/servers/appapi/useragents.go#L267)). Sending only 3 fields will not clear other fields on the server.
5. **Does the read-merge GET serve any purpose?** — Reviewer flagged that since PATCH overlays, the GET in the original "read-merge-PATCH" plan is unnecessary for the V1 3-field case. Decision: **drop the GET**. Just PATCH directly. The version conflict that GET was supposed to detect is handled by the 409→re-pull path. Simpler and one fewer round-trip per push.

## Risks

1. **Agent push + plugin sync ordering on a fresh org** — fresh OAuth → first app launch → plugin sync writes `openit-triage.json` (write-once gate doesn't fire because file is missing) → migration shim no-ops (no `triage.json` exists either) → cloud pull happens → PUSH does not fire automatically (no dirty file). User has to edit instructions to trigger a push. Acceptable for V1; document in the manual testing scenarios.
2. **The `ai-intake` skill spawns `claude -p` reading the JSON file**, possibly while a push is mid-write. `entity_write_file` writes are not atomic against concurrent reads. Mitigation: not addressed in V1 (no observed failures). Document as a known issue. If failures emerge, switch `entity_write_file` to write-then-rename.
3. **Worker drift** — if the user has multiple OpenIT instances open on the same project (e.g. two laptops syncing through git/iCloud), V1 push on instance A → instance B's poll detects remote change → instance B pulls clean (no shadow) — fine. If B has local edits since last pull, B sees a conflict via the standard pull pipeline. No new code needed.
4. **PATCH body size** — sending only 3 fields keeps body tiny. No risk.
5. **Reverting V1** — if we have to back out, the rename is the messiest part. Migration shim is one-way (deletes old file). Acceptable; ship behind a feature flag if cautious. (V1 plan does not include a flag — judgment call: not worth the complexity for a small initial scope.)
6. **`AgentRow` narrowing** — reviewer flagged that any UI code reading `selectedModel` or `isShared` will break. Mitigated by Step 1's grep; if reads exist, decide whether to keep those fields on disk (compromising the "narrow shape" goal) or update the UI to not read them. Step 1 surfaces this before any rewrite.

## What this unlocks

- **Phase 5c (workflow push):** if the V1 push pattern works (gitStatus dirty detection + per-file POST/PATCH + manifest reconcile + auto-commit), workflows can copy it. Workflows have draft/release semantics that won't fit a generic helper, but the wrapper-level shape is the right size.
- **Phase 2 agent fields:** adding `description` (already in V1), then `selectedModel`, `isShared`, `promptExamples`, etc. is one-field-at-a-time on top of the V1 push surface. Each addition needs grep-the-UI + add-to-disk + add-to-PATCH-body + tests.
- **`OutOfSync` engine type:** any future record-shaped entity gets a free conflict-on-push convention.

---

## Review notes

This plan was self-critiqued by a reviewer who caught:

- ✅ The original `apiUpsert` on `EntityAdapter` was a half-abstraction. Pulled.
- ✅ Missing post-write mtime bump would cause infinite re-push loop on first POST. Added explicitly.
- ✅ `syncSkillsToDisk` clobbers user-edited agent files on every plugin bump. Write-once gate added.
- ✅ Migration ordering — shim must run before first cloud pull or stale cloud agents overwrite local edits. Made explicit in App.tsx step.
- ✅ Missing rename targets: `skillsSync.test.ts` (4 refs), `ai-intake.md`. Added.
- ✅ Shadow shape clarification — shadows are 4-field disk shape, not full wire shape. Already implicit in the existing `writeShadow` impl; called out in success criteria.
- ✅ The read-merge GET in the original PATCH flow is unnecessary; PATCH overlays. GET dropped, one fewer round-trip.
- ✅ Pre-flight verifications captured as Step 1 — implementer must answer them before writing TS.
