import { pinkfishMcpCall } from "./api";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";

export type KbCollection = { id: string; name: string; description?: string };

export type KbFile = {
  id: string;
  filename: string;
  /// ISO timestamp of last server-side update — used as the "remote version"
  /// in the local manifest.
  updatedAt: string;
  /// Server-provided link for download. Pinkfish's filestorage API returns
  /// short-lived URLs.
  downloadUrl?: string;
  size?: number;
};

function kbName(orgSlug: string): string {
  return `openit-${orgSlug}`;
}

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
  const r = resp as { result?: { structuredContent?: unknown }; error?: unknown };
  if (r.error) throw new Error(`${tool}: ${JSON.stringify(r.error)}`);
  return r.result?.structuredContent ?? null;
}

export async function listCollections(creds: PinkfishCreds): Promise<KbCollection[]> {
  const out = (await call(creds, "knowledge-base", "knowledge-base_list_collections", {})) as {
    collections?: KbCollection[];
  } | null;
  return out?.collections ?? [];
}

export async function createCollection(
  creds: PinkfishCreds,
  name: string,
  description: string,
): Promise<KbCollection> {
  const out = (await call(creds, "knowledge-base", "knowledge-base_create_collection", {
    name,
    description,
  })) as { id?: string; name?: string };
  if (!out?.id) throw new Error("create_collection returned no id");
  return { id: out.id, name: out.name ?? name };
}

/// Find or create the OpenIT-managed KB for this project. Naming convention:
/// `openit-<orgSlug>`. Description includes the slug for traceability.
export async function resolveProjectKb(
  creds: PinkfishCreds,
  orgSlug: string,
  orgName: string,
): Promise<KbCollection> {
  const expected = kbName(orgSlug);
  const collections = await listCollections(creds);
  const existing = collections.find((c) => c.name === expected);
  if (existing) return existing;
  return createCollection(
    creds,
    expected,
    `OpenIT knowledge base for ${orgName}. Synced from local 'knowledge-base/' folder.`,
  );
}

export async function listFiles(
  creds: PinkfishCreds,
  collectionId: string,
): Promise<KbFile[]> {
  const out = (await call(creds, "filestorage", "filestorage_list_items", {
    fileLinksExpireInDays: 1,
    format: "light",
    collectionId,
  })) as { items?: Array<Record<string, unknown>> } | null;
  return (out?.items ?? []).map((it) => ({
    id: String(it.id ?? ""),
    filename: String(it.filename ?? it.name ?? ""),
    updatedAt: String(it.updatedAt ?? it.updated_at ?? it.modifiedAt ?? ""),
    downloadUrl: typeof it.downloadUrl === "string" ? it.downloadUrl : undefined,
    size: typeof it.size === "number" ? it.size : undefined,
  }));
}

export async function uploadFile(
  creds: PinkfishCreds,
  collectionId: string,
  filename: string,
  content: string,
): Promise<void> {
  await call(creds, "knowledge-base", "knowledge-base_upload_file", {
    collectionId,
    filename,
    fileContent: content,
  });
}
