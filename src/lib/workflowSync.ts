// Workflow sync wrapper. Engine-driven via workflowAdapter
// (entities/workflow.ts). REST `/automations` + manifest-based diff.
//
// Read-only (no push). Per the plan, sync targets the workflow draft
// only — explicit releases stay a user action via
// POST /automations/{id}/release.

import {
  resolveProjectWorkflows,
  workflowAdapter,
  type WorkflowRow,
} from "./entities/workflow";
import { type PinkfishCreds } from "./pinkfishAuth";
import {
  startReadOnlyEntitySync,
  type ReadOnlySyncHandle,
} from "./syncEngine";

export type Workflow = WorkflowRow;

export { resolveProjectWorkflows };

let handle: ReadOnlySyncHandle | null = null;

export async function startWorkflowSync(args: {
  creds: PinkfishCreds;
  repo: string;
  onLog?: (msg: string) => void;
}): Promise<void> {
  const { creds, repo, onLog } = args;
  if (handle) {
    handle.stop();
    handle = null;
  }

  let firstResolve: WorkflowRow[] | undefined;
  handle = await startReadOnlyEntitySync({
    repo,
    buildAdapter: async () => {
      const workflows =
        firstResolve ?? (await resolveProjectWorkflows(creds));
      if (firstResolve === undefined && onLog) {
        for (const w of workflows) {
          onLog(`  ✓ ${w.name || "(unnamed)"}  (id: ${w.id || "?"})`);
        }
      }
      const built = workflowAdapter({ creds, initialWorkflows: workflows });
      firstResolve = [];
      return built;
    },
    onLog,
    itemLabel: (count, pulled) => `    ${count} workflow(s) — ${pulled} pulled`,
  });
}

export function stopWorkflowSync(): void {
  if (handle) {
    handle.stop();
    handle = null;
  }
}
