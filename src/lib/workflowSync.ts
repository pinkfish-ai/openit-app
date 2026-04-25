import { pinkfishMcpCall, entityWriteFile } from "./api";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";

export type Workflow = {
  id: string;
  name: string;
  description?: string;
  triggers?: Array<{ id: string; name: string; url?: string }>;
  inputs?: Array<{ name: string; type: string; required?: boolean }>;
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
  console.log(`[workflowSync] ${tool} ->`, sc);
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
 * List workflows via the platform MCP automations endpoint, filtered by
 * the openit-* naming prefix.
 */
export async function resolveProjectWorkflows(
  creds: PinkfishCreds,
): Promise<Workflow[]> {
  const raw = (await call(
    creds,
    "pinkfish-sidekick",
    "workflow_list",
    { filter: "all" },
  )) as {
    workflows?: Array<Record<string, unknown>>;
  } | null;

  const workflows: Workflow[] = (raw?.workflows ?? []).map((w) => ({
    id: String(w.id ?? ""),
    name: String(w.name ?? ""),
    description:
      typeof w.description === "string" ? w.description : undefined,
    triggers: Array.isArray(w.triggers)
      ? w.triggers.map((t: Record<string, unknown>) => ({
          id: String(t.id ?? ""),
          name: String(t.name ?? ""),
          url: typeof t.url === "string" ? t.url : undefined,
        }))
      : undefined,
    inputs: Array.isArray(w.inputs)
      ? w.inputs.map((i: Record<string, unknown>) => ({
          name: String(i.name ?? ""),
          type: String(i.type ?? "string"),
          required: typeof i.required === "boolean" ? i.required : undefined,
        }))
      : undefined,
  }));

  return workflows.filter((w) => w.name.startsWith(PREFIX));
}

export async function syncWorkflowsToDisk(repo: string, workflows: Workflow[]): Promise<void> {
  for (const wf of workflows) {
    const filename = wf.name.replace(/[/\\:*?"<>|]/g, "_") + ".json";
    await entityWriteFile(repo, "workflows", filename, JSON.stringify(wf, null, 2));
  }
}
