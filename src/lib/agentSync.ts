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
    const adapter = agentAdapter({ creds });
    const result = await pullEntity(adapter, repo);
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
    return await fsRead(`${repo}/${TRIAGE_SUBDIR}/${filename}`);
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
    const wire = await resolveResourceRefs(
      creds,
      parsed.resources as AgentResources | undefined,
      onLine,
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

    // Detect dirty using three signals — same shape as `pushAllToKb`:
    // (1) file isn't tracked yet (never synced), (2) git status reports
    // it modified/untracked (uncommitted edits), (3) mtime advanced past
    // the last-pulled stamp (committed-after-last-sync — the case where
    // the SourceControl panel commits before push runs, leaving git
    // status clean but the manifest baseline behind). Without (3),
    // every Commit-and-Push flow would silently no-op for agents.
    //
    // Any of the three .md blocks being dirty also marks the agent's
    // .json as needing push (instructions are assembled from common +
    // cloud at push time). The manifest only tracks the .json row, so
    // probe git status for .md changes to surface the dependency.
    const local = await entityListLocal(repo, TRIAGE_SUBDIR);
    const gitFiles = await gitStatusShort(repo).catch(() => []);
    const dirtyPaths = new Set(
      gitFiles
        .filter((g) => g.path.startsWith(`${TRIAGE_SUBDIR}/`))
        .map((g) => g.path.slice(`${TRIAGE_SUBDIR}/`.length)),
    );
    const mdDirty = ["common.md", "cloud.md", "local.md"].some((f) =>
      dirtyPaths.has(f),
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
        // The .json might be clean but a sibling .md (common/cloud)
        // bumped — those affect the assembled `instructions` field on
        // cloud, so the .json's row needs push too.
        if (mdDirty && f.filename === `${TRIAGE_LOCAL_NAME}.json`) return true;
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
