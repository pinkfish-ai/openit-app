// Workflow adapter for syncEngine. Lists `/automations` (REST) — replaces
// the pre-R4 MCP-based workflow_list call. Each openit-* automation
// becomes a JSON file at `workflows/<name>.json`.
//
// Read-only adapter (no apiUpsert / apiDelete). Per the plan, sync
// targets the *draft* (releaseVersion: -1); explicit releases stay a
// user action via POST /automations/{id}/release — the engine will not
// auto-release anything.

import { entityDeleteFile, entityWriteFile } from "../api";
import { invoke } from "@tauri-apps/api/core";
import { makeSkillsFetch } from "../../api/fetchAdapter";
import { derivedUrls, getToken, type PinkfishCreds } from "../pinkfishAuth";
import {
  canonicalFromShadow,
  classifyAsShadow,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type Manifest,
  type RemoteItem,
} from "../syncEngine";

const DIR = "workflows";
const PREFIX = "openit-";

export type WorkflowRow = {
  id: string;
  name: string;
  description?: string;
  triggers?: Array<{ id: string; name: string; url?: string }>;
  inputs?: Array<{ name: string; type: string; required?: boolean }>;
  updatedAt?: string;
  createdAt?: string;
};

function canonicalizeForDisk(wf: WorkflowRow): string {
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wf)) {
    if (k === "updatedAt" || k === "createdAt" || k === "lastRunAt") continue;
    stripped[k] = v;
  }
  return JSON.stringify(stripped, null, 2);
}

function safeFilename(name: string): string {
  return `${name.replace(/[/\\:*?"<>|]/g, "_")}.json`;
}

async function listAutomations(creds: PinkfishCreds): Promise<WorkflowRow[]> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);
  // Same X-Selected-Org requirement as /user-agents (see agent adapter).
  const fetchFn = makeSkillsFetch(token.accessToken, "bearer", creds.orgId);
  const url = new URL("/automations", urls.appBaseUrl);
  const resp = await fetchFn(url.toString());
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  const raw = (await resp.json()) as Array<Record<string, unknown>> | null;
  const items = Array.isArray(raw) ? raw : [];
  return items.map((w) => ({
    id: String(w.id ?? ""),
    name: String(w.name ?? ""),
    description: typeof w.description === "string" ? w.description : undefined,
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
    updatedAt: typeof w.updatedAt === "string" ? w.updatedAt : undefined,
    createdAt: typeof w.createdAt === "string" ? w.createdAt : undefined,
  }));
}

export async function resolveProjectWorkflows(
  creds: PinkfishCreds,
): Promise<WorkflowRow[]> {
  const all = await listAutomations(creds);
  return all.filter((w) => w.name.startsWith(PREFIX));
}

async function listLocalWorkflows(repo: string): Promise<{ filename: string; mtime_ms: number | null }[]> {
  return invoke<{ filename: string; mtime_ms: number | null; size: number }[]>(
    "entity_list_local",
    { repo, subdir: DIR },
  );
}

export function workflowAdapter(args: {
  creds: PinkfishCreds;
  /// Pre-resolved workflow list — see agentAdapter for rationale.
  initialWorkflows?: WorkflowRow[];
}): EntityAdapter {
  const { creds } = args;
  let cachedFirst: WorkflowRow[] | undefined = args.initialWorkflows;
  return {
    prefix: "workflow",

    loadManifest: (repo) =>
      invoke<Manifest>("entity_state_load", { repo, name: "workflow" }),
    saveManifest: (repo, m) =>
      invoke<void>("entity_state_save", { repo, name: "workflow", state: m }),

    async listRemote(_repo) {
      const workflows = cachedFirst ?? (await resolveProjectWorkflows(creds));
      cachedFirst = undefined;
      const items: RemoteItem[] = [];
      for (const w of workflows) {
        if (!w.name) continue;
        const filename = safeFilename(w.name);
        const content = canonicalizeForDisk(w);
        items.push({
          manifestKey: filename,
          workingTreePath: `${DIR}/${filename}`,
          updatedAt: w.updatedAt ?? "",
          fetchAndWrite: (repo) => entityWriteFile(repo, DIR, filename, content),
          writeShadow: (repo) =>
            entityWriteFile(repo, DIR, shadowFilename(filename), content),
        });
      }
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      const files = await listLocalWorkflows(repo);
      const siblings = new Set(files.map((f) => f.filename));
      const out: LocalItem[] = files.map((f) => {
        const shadow = classifyAsShadow(f.filename, siblings);
        return {
          manifestKey: shadow ? canonicalFromShadow(f.filename) : f.filename,
          workingTreePath: `${DIR}/${f.filename}`,
          mtime_ms: f.mtime_ms,
          isShadow: shadow,
        };
      });
      return out;
    },

    /// Server-deleted workflow → delete the local file. Same rationale
    /// as KB / filestore / agents.
    async onServerDelete({ repo, manifestKey, manifest, touched, local }) {
      const stillOnDisk = local.some(
        (f) => !f.isShadow && f.manifestKey === manifestKey,
      );
      if (stillOnDisk) {
        try {
          await entityDeleteFile(repo, DIR, manifestKey);
          touched.push(`${DIR}/${manifestKey}`);
        } catch (e) {
          console.error(`[workflow] failed to delete local ${manifestKey}:`, e);
        }
      }
      delete manifest.files[manifestKey];
      return true;
    },
  };
}
