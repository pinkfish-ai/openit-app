import { pinkfishMcpCall, entityWriteFile } from "./api";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";

export type Agent = {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  selectedModel?: string;
  isShared?: boolean;
};

const PREFIX = "openit-";

/**
 * Call a Pinkfish MCP tool and extract structuredContent, following the same
 * error-handling pattern as kb.ts.
 */
async function call(
  creds: PinkfishCreds,
  server: string,
  tool: string,
  args: unknown,
): Promise<unknown> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);
  const resp = await pinkfishMcpCall({
    accessToken: token.accessToken,
    orgId: creds.orgId,
    server,
    tool,
    arguments: args,
    baseUrl: urls.mcpBaseUrl,
  });
  const r = resp as {
    result?: {
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
    error?: unknown;
  };
  if (r.error) throw new Error(`${tool}: ${JSON.stringify(r.error)}`);

  // Try structuredContent first, fall back to parsing content[0].text
  let sc = r.result?.structuredContent ?? null;
  if (!sc && r.result?.content) {
    const textEntry = r.result.content.find((c) => c.type === "text" && c.text);
    if (textEntry?.text) {
      try {
        sc = JSON.parse(textEntry.text);
      } catch {
        // not valid JSON
      }
    }
  }
  console.log(`[agentSync] ${tool} ->`, sc);
  if (
    sc &&
    typeof sc === "object" &&
    "error" in (sc as Record<string, unknown>)
  ) {
    const errMsg = (sc as { error: unknown }).error;
    throw new Error(
      `${tool}: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}`,
    );
  }
  return sc;
}

/**
 * List agents via the platform MCP user-agents endpoint, filtered by
 * the openit-* naming prefix.
 */
export async function resolveProjectAgents(
  creds: PinkfishCreds,
): Promise<Agent[]> {
  const raw = (await call(creds, "agent-management", "agent_list", {})) as {
    agents?: Array<Record<string, unknown>>;
  } | null;

  const agents: Agent[] = (raw?.agents ?? []).map((a) => ({
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    description:
      typeof a.description === "string" ? a.description : undefined,
    instructions:
      typeof a.instructions === "string" ? a.instructions : undefined,
    selectedModel:
      typeof a.selectedModel === "string" ? a.selectedModel : undefined,
    isShared: typeof a.isShared === "boolean" ? a.isShared : undefined,
  }));

  return agents.filter((a) => a.name.startsWith(PREFIX));
}

export async function syncAgentsToDisk(repo: string, agents: Agent[]): Promise<void> {
  // Write/overwrite each file — don't clear first to avoid empty-dir flash
  for (const agent of agents) {
    const filename = agent.name.replace(/[/\\:*?"<>|]/g, "_") + ".json";
    await entityWriteFile(repo, "agents", filename, JSON.stringify(agent, null, 2));
  }
}
