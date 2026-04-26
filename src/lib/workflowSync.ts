// Workflow sync wrapper. Engine-driven via workflowAdapter
// (entities/workflow.ts). Replaces the legacy MCP `workflow_list` +
// content-equality syncWorkflowsToDisk with REST `/automations` + the
// engine's manifest-based diff.
//
// Read-only (no push). Per the plan, sync targets the *draft* —
// release-vs-draft handling stays an explicit user action and is not
// in scope for the engine.

import {
  resolveProjectWorkflows,
  workflowAdapter,
  type WorkflowRow,
} from "./entities/workflow";
import { type PinkfishCreds } from "./pinkfishAuth";
import {
  DEFAULT_POLL_INTERVAL_MS,
  pullEntity,
  type EntityAdapter,
} from "./syncEngine";

export type Workflow = WorkflowRow;

export { resolveProjectWorkflows };

let stopPoll: (() => void) | null = null;

export async function startWorkflowSync(args: {
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
        const workflows = await resolveProjectWorkflows(creds);
        if (isFirst && onLog) {
          for (const w of workflows) {
            onLog(`  ✓ ${w.name || "(unnamed)"}  (id: ${w.id || "?"})`);
          }
        }
        adapter = workflowAdapter({ creds });
      } catch (e) {
        console.error("[workflowSync] resolve failed:", e);
        if (isFirst) throw e;
        return;
      }
    }
    try {
      const r = await pullEntity(adapter, repo);
      if (isFirst) {
        onLog?.(`    ${r.remoteCount} workflow(s) — ${r.pulled} pulled`);
      }
    } catch (e) {
      console.error("[workflowSync] pull failed:", e);
      if (isFirst) throw e;
    }
  };

  const timer = setInterval(tryResolveAndPull, DEFAULT_POLL_INTERVAL_MS);
  stopPoll = () => clearInterval(timer);
  await tryResolveAndPull();
}

export function stopWorkflowSync(): void {
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }
}
