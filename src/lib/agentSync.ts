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
  AGENT_DIR,
  AGENT_PREFIX,
  listUserAgentsWithMeta,
  patchUserAgent,
  postUserAgent,
  resolveProjectAgents,
  type AgentRow,
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

const LEGACY_FILENAME = "triage.json";
const CURRENT_FILENAME = "openit-triage.json";
const LEGACY_NAME = "triage";
const CURRENT_NAME = "openit-triage";

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
        for (const a of agents) {
          onLog(`  ✓ ${a.name || "(unnamed)"}  (id: ${a.id || "?"})`);
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
// Migration shim. The legacy bundled-plugin wrote `agents/triage.json`
// (`name: "triage"`); V1 standardises on `agents/openit-triage.json`
// (`name: "openit-triage"`) so the local filename, the in-file `name`,
// and the platform's `openit-` filter all agree.
//
// Must run **before** the first cloud pull. If a stale `openit-triage`
// exists on cloud, a cloud-pull-first ordering would write that
// version to `openit-triage.json` before the shim runs, the shim
// would see the new file already exists and bail, and the user's
// local edits in `triage.json` would be lost. (Reviewer flagged.)
// ---------------------------------------------------------------------------

async function fileExistsOnDisk(
  repo: string,
  subdir: string,
  filename: string,
): Promise<boolean> {
  try {
    await fsRead(`${repo}/${subdir}/${filename}`);
    return true;
  } catch {
    return false;
  }
}

export async function migrateLegacyTriageFilename(repo: string): Promise<void> {
  const oldExists = await fileExistsOnDisk(repo, AGENT_DIR, LEGACY_FILENAME);
  const newExists = await fileExistsOnDisk(repo, AGENT_DIR, CURRENT_FILENAME);
  if (!oldExists || newExists) return;
  try {
    const content = await fsRead(`${repo}/${AGENT_DIR}/${LEGACY_FILENAME}`);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Malformed JSON — bail without losing the file. User can fix and
      // restart; the shim no-ops on subsequent runs once the new file
      // exists.
      console.warn("[migrate] agents/triage.json is malformed; skipping rename");
      return;
    }
    // Only rewrite name if it's still the bundled default. A user-edited
    // name (e.g. they renamed the agent) is preserved verbatim.
    if (parsed.name === LEGACY_NAME) parsed.name = CURRENT_NAME;
    await entityWriteFile(
      repo,
      AGENT_DIR,
      CURRENT_FILENAME,
      JSON.stringify(parsed, null, 2),
    );
    await entityDeleteFile(repo, AGENT_DIR, LEGACY_FILENAME);
    console.log(
      `[migrate] renamed agents/${LEGACY_FILENAME} → agents/${CURRENT_FILENAME}`,
    );
  } catch (e) {
    console.error("[migrate] failed:", e);
  }
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

/// Re-list local agent filenames after a write so we can pick up the
/// post-write mtime. `entity_stat` doesn't exist; pulling the whole
/// dir is one IPC call and the directory is small.
async function readMtimeAfterWrite(
  repo: string,
  filename: string,
): Promise<number | null> {
  try {
    const list = await entityListLocal(repo, AGENT_DIR);
    const match = list.find((f) => f.filename === filename);
    return match?.mtime_ms ?? null;
  } catch {
    return null;
  }
}

export async function pushAllToAgents(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine: (line: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, onLine } = args;
  return withRepoLock(repo, "agent", async () => {
    const allFiles = await gitStatusShort(repo).catch(() => []);
    const dirty = allFiles
      .map((f) => f.path)
      .filter((p) => p.startsWith(`${AGENT_DIR}/`) && p.endsWith(".json"))
      .filter((p) => !p.includes(".server."))
      .map((p) => p.slice(`${AGENT_DIR}/`.length));

    if (dirty.length === 0) return { pushed: 0, failed: 0 };

    const manifest = await invoke<KbStatePersisted>("entity_state_load", {
      repo,
      name: "agent",
    });
    if (!manifest.files || typeof manifest.files !== "object") {
      manifest.files = {};
    }

    const touched: string[] = [];
    let pushed = 0;
    let failed = 0;

    for (const filename of dirty) {
      try {
        const localStr = await fsRead(`${repo}/${AGENT_DIR}/${filename}`);
        const parsed = JSON.parse(localStr) as Partial<AgentRow>;
        const name = String(parsed.name ?? "");
        if (!name) {
          onLine(`  ✗ ${filename}: missing 'name' field`);
          failed += 1;
          continue;
        }

        const body = {
          name,
          description: parsed.description ?? "",
          instructions: parsed.instructions ?? "",
        };

        let serverAgent;
        if (!parsed.id) {
          serverAgent = await postUserAgent(creds, body);
          // Write the server-issued id back to disk so subsequent edits
          // PATCH instead of duplicating via POST. Bumping the manifest
          // mtime baseline below to the post-write mtime is the
          // load-bearing part: without it the next poll tick sees the
          // file as dirty (mtime > tracked baseline) and re-pushes
          // forever.
          const updated: AgentRow = {
            id: serverAgent.id,
            name,
            description: body.description,
            instructions: body.instructions,
          };
          await entityWriteFile(
            repo,
            AGENT_DIR,
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
        manifest.files[filename] = {
          remote_version: remoteVersion,
          pulled_at_mtime_ms: postWriteMtime ?? Date.now(),
          conflict_remote_version: undefined,
        };
        touched.push(`${AGENT_DIR}/${filename}`);
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
