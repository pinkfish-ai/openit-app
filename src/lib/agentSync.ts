// Agent sync wrapper. Engine-driven via agentAdapter (entities/agent.ts).
// Replaces the legacy MCP `agent_list` + content-equality syncAgentsToDisk
// with REST `/user-agents` + the engine's manifest-based diff.
//
// On bootstrap: ensures an `openit-triage-<orgId>` agent exists. This is
// the helpdesk vision's Phase A — the user has an agent to talk to out
// of the box (see auto-dev/plans/2026-04-26-helpdesk-vision.md).
// Built on the generic startReadOnlyEntitySync helper from syncEngine.ts.

import { agentAdapter, resolveProjectAgents, type AgentRow } from "./entities/agent";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import {
  clearConflictsForPrefix,
  startReadOnlyEntitySync,
  type ReadOnlySyncHandle,
} from "./syncEngine";

// Backward-compat alias for FileExplorer's in-memory tree state.
export type Agent = AgentRow;

export { resolveProjectAgents };

let handle: ReadOnlySyncHandle | null = null;

/// Per-org cache + cooldown so re-firing startAgentSync (e.g., on
/// reconnect) doesn't hammer the create endpoint when the agent
/// already exists. Mirrors the datastore/filestore resolve pattern.
const triageEnsuredForOrg = new Set<string>();
const triageInflight = new Map<string, Promise<AgentRow | null>>();

function triageAgentName(orgId: string): string {
  return `openit-triage-${orgId}`;
}

/// Instructions text for the triage agent. Encodes the log-ticket /
/// search-KB / answer-or-escalate flow. The agent uses the Pinkfish
/// gateway (capabilities_discover → gateway_invoke) to reach KB and
/// datastore tools — no per-agent resource bindings needed for V1.
function triageAgentInstructions(orgId: string): string {
  return `You are openit-triage, an IT helpdesk triage agent for org \`${orgId}\`.

When a user sends you a question or ticket, do this in order:

1. **Log the ticket first.** Always create a row in the \`openit-tickets-${orgId}\` datastore. Use \`capabilities_discover\` to find the right datastore tool, then \`gateway_invoke\` to create the row. Include who asked, what they asked, when, and a short summary. This happens for EVERY incoming question, before any answer or escalation.

2. **Search the knowledge base.** Use \`knowledge-base_ask\` (gateway, server \`knowledge-base\`) with the user's question. Pass the org's KB collection (\`openit-${orgId}\`) when you can identify it.

3. **If the KB returns a confident answer**, write a clear, concise reply using that information. Update the ticket row you logged in step 1 with status \`answered\`, the answer text, and the KB source(s).

4. **If the KB doesn't have a confident answer**, reply to the user along the lines of: "I don't have an answer for that yet — I've logged your question and a human will follow up." Update the ticket row: set status to \`open\` (or whatever the schema's \"needs human\" field is — read \`_schema.json\` if unsure).

Rules:
- **Never invent answers.** If the KB doesn't know, escalate. Don't guess.
- **Always log, always reply.** No silent drops.
- **Be concise.** Lead with the answer or the next step, then context.
- If the question is unclear, ask ONE focused clarifying question before logging and searching — but log the ticket once you have the answer to your clarifying question.
`;
}

/// Minimal-but-functional payload for POST /service/useragents.
/// Matches the shape /web's useSaveAgent.ts uses, with empty resource
/// arrays (V1 — agent uses the gateway for resource access; explicit
/// bindings + API key plumbing is V2).
function triageAgentPayload(orgId: string): Record<string, unknown> {
  return {
    name: triageAgentName(orgId),
    description:
      "Triage IT tickets — check the knowledge base, answer if found, log + escalate if not.",
    instructions: triageAgentInstructions(orgId),
    selectedModel: "sonnet",
    isShared: false,
    servers: [],
    workflows: [],
    datastores: [],
    filestores: [],
    knowledgeBases: [],
    promptExamples: [],
  };
}

/// Ensure the triage agent exists for this org. Idempotent — checks
/// the existing agent list first; only POSTs when missing. Returns
/// the agent row on success, null on failure (we don't fail the
/// whole sync over this — the modal's onLog surfaces the issue and
/// the user can carry on without the triage agent).
export async function resolveOrCreateTriageAgent(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<AgentRow | null> {
  // De-duplicate concurrent calls per-org. The cache flag makes
  // post-first-success calls a no-op without re-listing.
  if (triageEnsuredForOrg.has(creds.orgId)) {
    return null;
  }
  const inflight = triageInflight.get(creds.orgId);
  if (inflight) return inflight;

  const promise = resolveOrCreateTriageAgentImpl(creds, onLog).then((row) => {
    if (row) triageEnsuredForOrg.add(creds.orgId);
    return row;
  });
  triageInflight.set(creds.orgId, promise);
  try {
    return await promise;
  } finally {
    triageInflight.delete(creds.orgId);
  }
}

async function resolveOrCreateTriageAgentImpl(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<AgentRow | null> {
  const wantedName = triageAgentName(creds.orgId);
  let existing: AgentRow[];
  try {
    existing = await resolveProjectAgents(creds);
  } catch (e) {
    console.error("[agentSync] triage check: list failed:", e);
    onLog?.(`  ✗ triage agent: list failed (${String(e)})`);
    return null;
  }
  const hit = existing.find((a) => a.name === wantedName);
  if (hit) {
    return hit;
  }

  const token = getToken();
  if (!token) {
    console.warn("[agentSync] triage create skipped: not authenticated");
    return null;
  }
  const urls = derivedUrls(creds.tokenUrl);
  const fetchFn = makeSkillsFetch(token.accessToken, "bearer");
  const url = new URL("/service/useragents", urls.appBaseUrl);

  try {
    const resp = await fetchFn(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(triageAgentPayload(creds.orgId)),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    const created = (await resp.json()) as Record<string, unknown>;
    const row: AgentRow = {
      id: String(created.id ?? ""),
      name: String(created.name ?? wantedName),
      description:
        typeof created.description === "string" ? created.description : undefined,
      instructions:
        typeof created.instructions === "string" ? created.instructions : undefined,
      selectedModel:
        typeof created.selectedModel === "string" ? created.selectedModel : undefined,
      isShared: typeof created.isShared === "boolean" ? created.isShared : undefined,
      updatedAt: typeof created.updatedAt === "string" ? created.updatedAt : undefined,
      createdAt: typeof created.createdAt === "string" ? created.createdAt : undefined,
    };
    onLog?.(`  ✓ created triage agent ${wantedName} (id: ${row.id || "?"})`);
    return row;
  } catch (e) {
    console.error("[agentSync] triage create failed:", e);
    onLog?.(`  ✗ triage agent create failed: ${String(e)}`);
    return null;
  }
}

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

  // Bootstrap step: ensure the triage agent exists before the first
  // pull. If it just got created, `resolveProjectAgents` inside
  // `buildAdapter` below will see it and pull it down to disk on the
  // first tick. Failures here log but don't block the rest of the
  // sync (the user can still see and edit other agents).
  await resolveOrCreateTriageAgent(creds, onLog);

  // Pre-fetch once so the adapter can reuse this list on its first
  // listRemote call instead of issuing a duplicate REST request.
  let isFirstBuild = true;
  handle = startReadOnlyEntitySync({
    repo,
    buildAdapter: async () => {
      const agents = await resolveProjectAgents(creds);
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

// Test-only helper: reset the per-org "ensured" set so a unit test can
// re-run the resolve flow without leaking state from a prior case.
export function _resetTriageEnsuredForTesting(): void {
  triageEnsuredForOrg.clear();
  triageInflight.clear();
}
