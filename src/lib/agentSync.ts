// Agent sync wrapper. Engine-driven via agentAdapter (entities/agent.ts).
// Replaces the legacy MCP `agent_list` + content-equality syncAgentsToDisk
// with REST `/user-agents` + the engine's manifest-based diff.
//
// Read-only today (no push). Built on the generic startReadOnlyEntitySync
// helper from syncEngine.ts — same shape as workflowSync.

import {
  agentAdapter,
  AGENT_DIR,
  AGENT_PREFIX,
  listUserAgentsWithMeta,
  resolveProjectAgents,
  type AgentRow,
} from "./entities/agent";
import { type PinkfishCreds } from "./pinkfishAuth";
import {
  clearConflictsForPrefix,
  startReadOnlyEntitySync,
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
