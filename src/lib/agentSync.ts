// Agent sync wrapper. Engine-driven via agentAdapter (entities/agent.ts).
// Replaces the legacy MCP `agent_list` + content-equality syncAgentsToDisk
// with REST `/user-agents` + the engine's manifest-based diff.
//
// V1 push surface lives in `pushAllToAgents` below. The read path
// (startAgentSync, stopAgentSync) is unchanged — both surfaces share
// the same adapter.

import { invoke } from "@tauri-apps/api/core";
import {
  agentAdapter,
  AGENT_PREFIX,
  assembleInstructions,
  cloudAgentName,
  getUserAgent,
  instructionsHash,
  listUserAgentsWithMeta,
  localAgentName,
  patchUserAgent,
  postUserAgent,
  releaseUserAgent,
  resolveResourceRefs,
  TRIAGE_LOCAL_NAME,
  TRIAGE_SUBDIR,
  type AgentResources,
  type AgentRow,
  type AgentTools,
  type AgentUpsertBody,
  type FullAgentResponse,
  type WireResource,
  resolveProjectAgents,
} from "./entities/agent";
import {
  entityDeleteFile,
  entityListLocal,
  entityWriteFile,
  fsRead,
  gitStatusShort,
  type KbStatePersisted,
} from "./api";
import { type PinkfishCreds } from "./pinkfishAuth";
import {
  clearConflictsForPrefix,
  commitTouched,
  OutOfSync,
  pullEntity,
  startReadOnlyEntitySync,
  withRepoLock,
  type Conflict,
  type ReadOnlySyncHandle,
} from "./syncEngine";

// Backward-compat alias for FileExplorer's in-memory tree state.
export type Agent = AgentRow;

export { resolveProjectAgents };

let handle: ReadOnlySyncHandle | null = null;

export async function startAgentSync(args: {
  creds: PinkfishCreds;
  repo: string;
  onLog?: (msg: string) => void;
}): Promise<void> {
  const { creds, repo, onLog } = args;
  if (handle) {
    handle.stop();
    handle = null;
  }

  // Pre-fetch once so the adapter can reuse this list on its first
  // listRemote call instead of issuing a duplicate REST request.
  let isFirstBuild = true;
  handle = startReadOnlyEntitySync({
    repo,
    buildAdapter: async () => {
      const agents = (await listUserAgentsWithMeta(creds)).filter((a) =>
        a.name.startsWith(AGENT_PREFIX),
      );
      if (isFirstBuild && onLog) {
        // Log the local form so the bootstrap log matches what the user
        // sees in the file tree (`triage`, not `openit-triage`).
        for (const a of agents) {
          const local = localAgentName(a.name);
          onLog(`  ✓ ${local || "(unnamed)"}  (id: ${a.id || "?"})`);
        }
      }
      const built = agentAdapter({
        creds,
        initialAgents: isFirstBuild ? agents : undefined,
      });
      isFirstBuild = false;
      return built;
    },
    onLog,
    itemLabel: (count, pulled) => `    ${count} agent(s) — ${pulled} pulled`,
  });
  // Surface first-attempt failures to the caller (modal's syncErrors
  // flag trips). Timer is already installed; auto-recovery runs.
  await handle.firstAttempt;
}

export function stopAgentSync(): void {
  if (handle) {
    handle.stop();
    handle = null;
  }
  clearConflictsForPrefix("agent");
}

// ---------------------------------------------------------------------------
// V1 push surface.
// ---------------------------------------------------------------------------

/// Thin wrapper that exposes the engine's pull as a one-shot for the
/// pushAll orchestrator. Mirrors `filestorePullOnce` / `pullDatastoresOnce`.
///
/// After the engine pull completes, run a separate divergence check on
/// the assembled `instructions` field: cloud's full string is
/// informational on V2 (the three .md blocks own the disk side, and
/// reverse-splitting a server string into common/cloud is impossible),
/// so the engine's normal `fetchAndWrite` doesn't touch the .md
/// blocks. Instead, compare cloud's hash against `pushed_instructions_hash`
/// in the manifest. If they differ, write `instructions.server.md` as a
/// shadow so the user can resolve manually.
export async function pullAgentsOnce(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<{
  ok: boolean;
  error?: string;
  pulled: number;
  conflicts: Conflict[];
}> {
  const { creds, repo } = args;
  try {
    // Single REST fetch shared by the adapter (via initialAgents) and the
    // divergence check below — without this both paths would issue their
    // own /user-agents call on every poll tick.
    const all = await listUserAgentsWithMeta(creds);
    const adapter = agentAdapter({ creds, initialAgents: all });
    const result = await pullEntity(adapter, repo);
    await detectInstructionsDivergence({ all, repo }).catch((e) =>
      console.error("[agentSync] instructions divergence check failed:", e),
    );
    return {
      ok: true,
      pulled: result.pulled,
      conflicts: result.conflicts,
    };
  } catch (e) {
    console.error("[agentSync] pull failed:", e);
    return { ok: false, error: String(e), pulled: 0, conflicts: [] };
  }
}

/// Compare cloud `instructions` against the last-pushed-hash recorded
/// in the manifest. On mismatch, write a `instructions.server.md`
/// shadow inside the agent's folder so the resolve-conflict flow has
/// something tangible to surface.
///
/// Skipped silently when:
/// - The manifest has no `pushed_instructions_hash` yet (first-launch
///   pull window — we've never sent anything, so cloud's value is the
///   baseline; next push records the hash).
/// - No `triage.json` row in the manifest (agent doesn't exist yet).
async function detectInstructionsDivergence(args: {
  all: Awaited<ReturnType<typeof listUserAgentsWithMeta>>;
  repo: string;
}): Promise<void> {
  const { all, repo } = args;
  const manifest = await invoke<KbStatePersisted>("entity_state_load", {
    repo,
    name: "agent",
  });
  const filename = `${TRIAGE_LOCAL_NAME}.json`;
  const entry = manifest.files?.[filename] as
    | { pushed_instructions_hash?: string }
    | undefined;
  const lastSent = entry?.pushed_instructions_hash;
  if (!lastSent) return;

  const cloud = all.find(
    (a) => localAgentName(a.name) === TRIAGE_LOCAL_NAME,
  );
  if (!cloud) return;
  const cloudInstructions = cloud.instructionsRaw ?? "";
  const cloudHash = await instructionsHash(cloudInstructions);
  if (cloudHash === lastSent) return;

  // Divergence — cloud's instructions string differs from what we last
  // sent. Write the shadow so the resolve-conflict skill has something
  // to merge against.
  await entityWriteFile(
    repo,
    TRIAGE_SUBDIR,
    "instructions.server.md",
    cloudInstructions,
  );
  console.log(
    "[agentSync] instructions divergence — wrote instructions.server.md shadow",
  );
}

async function fileExistsOnDisk(repo: string, relPath: string): Promise<boolean> {
  try {
    await invoke<string>("fs_read", { path: `${repo}/${relPath}` });
    return true;
  } catch {
    return false;
  }
}

/// One-shot migration from V1's flat `agents/triage.json` to V2's
/// folder layout `agents/triage/{triage.json,common.md,cloud.md,local.md}`.
/// The user's existing `instructions` text lands verbatim in `common.md`;
/// `cloud.md` / `local.md` come from the bundled plugin defaults on the
/// next plugin sync tick (the write-once gate treats them as new files
/// because the folder didn't exist before this shim ran).
///
/// MUST run before `startCloudSyncs` so a stale cloud-side agent doesn't
/// get pulled before the local data is folded into the new layout.
export async function migrateFlatTriage(repo: string): Promise<void> {
  const flatExists = await fileExistsOnDisk(repo, "agents/triage.json");
  const folderExists = await fileExistsOnDisk(repo, "agents/triage/triage.json");
  if (!flatExists || folderExists) return;

  try {
    const content = await fsRead(`${repo}/agents/triage.json`);
    const parsed = JSON.parse(content) as {
      instructions?: unknown;
      [k: string]: unknown;
    };
    const { instructions, ...structured } = parsed;

    await entityWriteFile(
      repo,
      "agents/triage",
      "triage.json",
      JSON.stringify(structured, null, 2),
    );

    if (typeof instructions === "string" && instructions.length > 0) {
      await entityWriteFile(repo, "agents/triage", "common.md", instructions);
    }

    await entityDeleteFile(repo, "agents", "triage.json");
    console.log("[migrate] flat agents/triage.json → agents/triage/ folder");
  } catch (e) {
    console.error("[migrate] V2 folder migration failed:", e);
  }
}

/// Re-list local agent filenames after a write so we can pick up the
/// post-write mtime. `entity_stat` doesn't exist; pulling the whole
/// dir is one IPC call and the directory is small.
async function readMtimeAfterWrite(
  repo: string,
  filename: string,
): Promise<number | null> {
  try {
    const list = await entityListLocal(repo, TRIAGE_SUBDIR);
    const match = list.find((f) => f.filename === filename);
    return match?.mtime_ms ?? null;
  } catch {
    return null;
  }
}

/// Read one of the three sibling instruction blocks. Missing → empty
/// string so push can still assemble a partial prompt rather than abort.
async function readMdBlock(repo: string, filename: string): Promise<string> {
  try {
    return (await fsRead(`${repo}/${TRIAGE_SUBDIR}/${filename}`)) ?? "";
  } catch {
    return "";
  }
}

/// Build the upsert body. V1 fields (name, description, instructions)
/// are always present; V2 fields are present only when the disk file
/// declared them — omit-when-absent semantics so unspecified fields
/// preserve their cloud values across PATCH overlays.
async function buildUpsertBody(args: {
  creds: PinkfishCreds;
  repo: string;
  parsed: Partial<AgentRow>;
  onLine: (line: string) => void;
}): Promise<AgentUpsertBody> {
  const { creds, repo, parsed, onLine } = args;
  const localName = String(parsed.name ?? TRIAGE_LOCAL_NAME);
  const common = await readMdBlock(repo, "common.md");
  const cloud = await readMdBlock(repo, "cloud.md");
  const body: AgentUpsertBody = {
    name: cloudAgentName(localName),
    description: parsed.description ?? "",
    instructions: assembleInstructions(common, cloud),
  };
  if (parsed.selectedModel !== undefined) body.selectedModel = parsed.selectedModel;
  if (parsed.isShared !== undefined) body.isShared = parsed.isShared;
  if (parsed.promptExamples !== undefined)
    body.promptExamples = parsed.promptExamples;
  if (parsed.introMessage !== undefined) body.introMessage = parsed.introMessage;
  if (parsed.resources !== undefined) {
    // For an existing agent (PATCH path), GET the cloud's current
    // state and lift its resource wire shapes (which already carry
    // valid id + proxyEndpointId). resolveResourceRefs uses these
    // for any disk ref that matches by name; falls back to
    // /api/proxy-endpoints (Cognito-only, will 401) for new ones.
    // Net: resources attached on cloud round-trip cleanly; resources
    // on disk that aren't yet on cloud need to be attached via web
    // first.
    let cloudCurrent:
      | { knowledgeBases?: WireResource[]; datastores?: WireResource[]; filestores?: WireResource[] }
      | undefined;
    if (parsed.id) {
      try {
        const cur = await getUserAgent(creds, parsed.id);
        cloudCurrent = {
          knowledgeBases: cur.knowledgeBases,
          datastores: cur.datastores,
          filestores: cur.filestores,
        };
      } catch (e) {
        console.warn("[agentSync] GET current agent for resource lookup failed:", e);
      }
    }
    const wire = await resolveResourceRefs(
      creds,
      parsed.resources as AgentResources | undefined,
      onLine,
      cloudCurrent,
    );
    if (wire.knowledgeBases !== undefined)
      body.knowledgeBases = wire.knowledgeBases;
    if (wire.datastores !== undefined) body.datastores = wire.datastores;
    if (wire.filestores !== undefined) body.filestores = wire.filestores;
  }
  if (parsed.tools !== undefined) {
    const servers = (parsed.tools as AgentTools | undefined)?.servers;
    if (servers !== undefined) body.servers = servers;
  }
  return body;
}

async function fireReleaseWithRetry(args: {
  creds: PinkfishCreds;
  agentId: string;
  filename: string;
  manifest: KbStatePersisted;
  onLine: (line: string) => void;
}): Promise<void> {
  const { creds, agentId, filename, manifest, onLine } = args;
  try {
    await releaseUserAgent(creds, agentId);
    if (manifest.files[filename]) {
      delete (manifest.files[filename] as { release_pending?: boolean })
        .release_pending;
    }
  } catch (e) {
    if (manifest.files[filename]) {
      (manifest.files[filename] as { release_pending?: boolean }).release_pending =
        true;
    }
    onLine(`  ✗ release failed (will retry next sync): ${String(e)}`);
  }
}

export async function pushAllToAgents(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine: (line: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, onLine } = args;
  return withRepoLock(repo, "agent", async () => {
    const manifest = await invoke<KbStatePersisted>("entity_state_load", {
      repo,
      name: "agent",
    });
    if (!manifest.files || typeof manifest.files !== "object") {
      manifest.files = {};
    }

    // Retry release-pending entries before the dirty-list early-return.
    // Without this, a clean-but-release-pending agent would never retry
    // (we'd return at `dirty.length === 0` below).
    const releasePending = Object.entries(manifest.files)
      .filter(
        ([_, entry]) => (entry as { release_pending?: boolean }).release_pending,
      )
      .map(([fname]) => fname);
    let manifestDirty = false;
    for (const fname of releasePending) {
      const entry = manifest.files[fname] as { remote_id?: string };
      const remoteId = entry.remote_id;
      if (!remoteId) continue;
      try {
        await releaseUserAgent(creds, remoteId);
        delete (manifest.files[fname] as { release_pending?: boolean })
          .release_pending;
        manifestDirty = true;
        onLine(`  ✓ retried release for ${fname}`);
      } catch (e) {
        onLine(`  ✗ release retry failed for ${fname}: ${String(e)}`);
      }
    }
    if (manifestDirty) {
      await invoke("entity_state_save", {
        repo,
        name: "agent",
        state: manifest,
      });
    }

    // Detect dirty using three signals on the .json — same shape as
    // `pushAllToKb`: (1) file isn't tracked yet (never synced), (2) git
    // status reports it modified/untracked (uncommitted edits), (3) mtime
    // advanced past the last-pulled stamp (committed-after-last-sync —
    // the case where the SourceControl panel commits before push runs,
    // leaving git status clean but the manifest baseline behind).
    //
    // For the triage row specifically, also compare the assembled
    // (common + cloud) instructions hash against `pushed_instructions_hash`.
    // .md siblings aren't tracked by the manifest and don't bump the
    // .json's mtime, so neither git status nor mtime catch them after
    // they've been committed. The hash is what actually got sent to
    // cloud last time, so any disk-side drift means the row needs push.
    // Bonus: local.md isn't part of the assembled string, so editing it
    // alone won't trigger a spurious push.
    const local = await entityListLocal(repo, TRIAGE_SUBDIR);
    const gitFiles = await gitStatusShort(repo).catch(() => []);
    const dirtyPaths = new Set(
      gitFiles
        .filter((g) => g.path.startsWith(`${TRIAGE_SUBDIR}/`))
        .map((g) => g.path.slice(`${TRIAGE_SUBDIR}/`.length)),
    );
    const triageJson = `${TRIAGE_LOCAL_NAME}.json`;
    const triageCommon = await readMdBlock(repo, "common.md");
    const triageCloud = await readMdBlock(repo, "cloud.md");
    const triageInstructionsHash = await instructionsHash(
      assembleInstructions(triageCommon, triageCloud),
    );
    const dirty = local
      .filter((f) => f.filename.endsWith(".json"))
      .filter((f) => !f.filename.includes(".server."))
      .filter((f) => {
        const tracked = manifest.files[f.filename];
        if (!tracked) return true;
        if (dirtyPaths.has(f.filename)) return true;
        if (f.mtime_ms != null && f.mtime_ms > tracked.pulled_at_mtime_ms)
          return true;
        if (f.filename === triageJson) {
          const lastSent = (tracked as { pushed_instructions_hash?: string })
            .pushed_instructions_hash;
          if (lastSent !== triageInstructionsHash) return true;
        }
        return false;
      })
      .map((f) => f.filename);

    if (dirty.length === 0) return { pushed: 0, failed: 0 };

    const touched: string[] = [];
    let pushed = 0;
    let failed = 0;

    for (const filename of dirty) {
      try {
        const localStr = await fsRead(`${repo}/${TRIAGE_SUBDIR}/${filename}`);
        const parsed = JSON.parse(localStr) as Partial<AgentRow>;
        const name = String(parsed.name ?? "");
        if (!name) {
          onLine(`  ✗ ${filename}: missing 'name' field`);
          failed += 1;
          continue;
        }

        const body = await buildUpsertBody({ creds, repo, parsed, onLine });

        let serverAgent: FullAgentResponse;
        if (!parsed.id) {
          serverAgent = await postUserAgent(creds, body);
          // Write the server-issued id back to disk so subsequent edits
          // PATCH instead of duplicating via POST. Bumping the manifest
          // mtime baseline below to the post-write mtime is the
          // load-bearing part: without it the next poll tick sees the
          // file as dirty (mtime > tracked baseline) and re-pushes
          // forever.
          const updated: AgentRow = {
            ...parsed,
            id: serverAgent.id,
            name,
          } as AgentRow;
          await entityWriteFile(
            repo,
            TRIAGE_SUBDIR,
            filename,
            JSON.stringify(updated, null, 2),
          );
        } else {
          serverAgent = await patchUserAgent(creds, parsed.id, body);
        }

        const postWriteMtime = await readMtimeAfterWrite(repo, filename);
        const remoteVersion =
          serverAgent.versionDate ??
          serverAgent.updatedAt ??
          new Date().toISOString();
        const pushedHash = await instructionsHash(body.instructions);
        manifest.files[filename] = {
          remote_version: remoteVersion,
          pulled_at_mtime_ms: postWriteMtime ?? Date.now(),
          conflict_remote_version: undefined,
          pushed_instructions_hash: pushedHash,
          remote_id: serverAgent.id,
        };
        touched.push(`${TRIAGE_SUBDIR}/${filename}`);
        // Auto-release: every successful upsert tries to publish the
        // current snapshot. Failure flags release_pending in the
        // manifest entry; the next sync retries.
        await fireReleaseWithRetry({
          creds,
          agentId: serverAgent.id,
          filename,
          manifest,
          onLine,
        });
        onLine(`  ✓ pushed ${filename}`);
        pushed += 1;
      } catch (e) {
        if (e instanceof OutOfSync) {
          onLine(`  ✗ ${filename}: out of sync — re-pulling`);
          // Re-pull surfaces the new remote version into the engine and
          // writes the `.server.` shadow on top of the user's local
          // canonical, mirroring the conflict-on-pull path. The user
          // resolves through the existing conflict pipeline.
          try {
            await pullEntity(agentAdapter({ creds }), repo);
          } catch (pullErr) {
            console.error("[agentSync] re-pull after 409 failed:", pullErr);
          }
          failed += 1;
        } else {
          onLine(`  ✗ ${filename}: ${String(e)}`);
          failed += 1;
        }
      }
    }

    await invoke("entity_state_save", {
      repo,
      name: "agent",
      state: manifest,
    });
    if (touched.length > 0) {
      await commitTouched(
        repo,
        touched,
        `sync: agent push @ ${new Date().toISOString()}`,
      );
    }
    return { pushed, failed };
  });
}
