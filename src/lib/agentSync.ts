// Agent sync wrapper. Engine-driven via agentAdapter (entities/agent.ts).
// Replaces the legacy MCP `agent_list` + content-equality syncAgentsToDisk
// with REST `/user-agents` + the engine's manifest-based diff.
//
// Read-only today (no push). agentAdapter has no apiUpsert/apiDelete.

import { agentAdapter, resolveProjectAgents, type AgentRow } from "./entities/agent";
import { type PinkfishCreds } from "./pinkfishAuth";
import {
  DEFAULT_POLL_INTERVAL_MS,
  pullEntity,
  type EntityAdapter,
} from "./syncEngine";

// Backward-compat type alias — pre-R4 callers (FileExplorer) still want
// to render an Agent[] for the in-memory tree. Same shape modulo the
// new `updatedAt` field (optional, callers ignore it).
export type Agent = AgentRow;

export { resolveProjectAgents };

let stopPoll: (() => void) | null = null;

/// Resolve openit-* agents and start the 60s engine-driven pull.
/// Idempotent — safe to call multiple times across modal connect /
/// App relaunch / org change. First-attempt errors propagate to the
/// caller so the modal's syncErrors flag trips; subsequent poll-tick
/// errors are console-only to avoid spamming the modal log.
export async function startAgentSync(args: {
  creds: PinkfishCreds;
  repo: string;
  onLog?: (msg: string) => void;
}): Promise<void> {
  const { creds, repo, onLog } = args;
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }

  let adapter: EntityAdapter | null = null;
  let firstAttempt = true;

  const tryResolveAndPull = async () => {
    const isFirst = firstAttempt;
    firstAttempt = false;
    if (!adapter) {
      try {
        const agents = await resolveProjectAgents(creds);
        if (isFirst && onLog) {
          for (const a of agents) {
            onLog(`  ✓ ${a.name || "(unnamed)"}  (id: ${a.id || "?"})`);
          }
        }
        adapter = agentAdapter({ creds });
      } catch (e) {
        console.error("[agentSync] resolve failed:", e);
        if (isFirst) throw e;
        return;
      }
    }
    try {
      const r = await pullEntity(adapter, repo);
      if (isFirst) {
        onLog?.(`    ${r.remoteCount} agent(s) — ${r.pulled} pulled`);
      }
    } catch (e) {
      console.error("[agentSync] pull failed:", e);
      if (isFirst) throw e;
    }
  };

  // Install poller before awaiting so first-attempt failures don't
  // strand the user without auto-recovery (matches datastore pattern).
  const timer = setInterval(tryResolveAndPull, DEFAULT_POLL_INTERVAL_MS);
  stopPoll = () => clearInterval(timer);
  await tryResolveAndPull();
}

export function stopAgentSync(): void {
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }
}
