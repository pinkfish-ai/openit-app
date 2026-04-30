// Bundled-seed first-run helper. Writes sample tickets/people/conversations/
// KB articles to disk if BOTH gates pass per-target:
//   1. Local folder for the target is empty (no user content yet).
//   2. Cloud has no `openit-<X>` collection (org hasn't been used yet).
//
// Engine push uploads the seeds to cloud on the next commit / auto-push so
// the user lands on a populated workspace whether they're online or offline.
//
// No idempotency sentinel needed — the disk + cloud state ARE the gate. A
// user who deletes a sample doesn't get it back (folder no longer empty).
// A user reconnecting against a populated org doesn't get samples (cloud
// already has the collection).

import { invoke } from "@tauri-apps/api/core";
import { fsList } from "./api";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { fetchSkillFile, fetchSkillsManifest } from "./skillsSync";

type SeedTarget = "tickets" | "people" | "conversations" | "knowledge";

type TargetConfig = {
  target: SeedTarget;
  /** REST collection type (`datastore` | `knowledge_base`). */
  cloudType: "datastore" | "knowledge_base";
  /** Exact name on cloud — gate fails if this collection already exists. */
  cloudName: string;
  /** Workspace path under `<repo>/`. */
  localDir: string;
};

const TARGETS: TargetConfig[] = [
  { target: "tickets",       cloudType: "datastore",      cloudName: "openit-tickets",       localDir: "databases/tickets" },
  { target: "people",        cloudType: "datastore",      cloudName: "openit-people",        localDir: "databases/people" },
  { target: "conversations", cloudType: "datastore",      cloudName: "openit-conversations", localDir: "databases/conversations" },
  { target: "knowledge",     cloudType: "knowledge_base", cloudName: "openit-default",       localDir: "knowledge-bases/default" },
];

/// Map a `seed/<target>/<...>` manifest path to its workspace destination.
/// Returns null if the path doesn't match a known seed pattern.
export function seedRoute(
  manifestPath: string,
): { subdir: string; filename: string } | null {
  if (manifestPath.startsWith("seed/tickets/")) {
    return { subdir: "databases/tickets", filename: manifestPath.replace("seed/tickets/", "") };
  }
  if (manifestPath.startsWith("seed/people/")) {
    return { subdir: "databases/people", filename: manifestPath.replace("seed/people/", "") };
  }
  if (manifestPath.startsWith("seed/knowledge/")) {
    return { subdir: "knowledge-bases/default", filename: manifestPath.replace("seed/knowledge/", "") };
  }
  if (manifestPath.startsWith("seed/conversations/")) {
    // Preserve the per-ticket subfolder: seed/conversations/<ticketId>/<file>
    // → databases/conversations/<ticketId>/<file>.
    const rel = manifestPath.replace("seed/conversations/", "");
    const lastSlash = rel.lastIndexOf("/");
    if (lastSlash < 0) return null;
    return {
      subdir: `databases/conversations/${rel.slice(0, lastSlash)}`,
      filename: rel.slice(lastSlash + 1),
    };
  }
  return null;
}

function manifestPathToTarget(manifestPath: string): SeedTarget | null {
  if (manifestPath.startsWith("seed/tickets/")) return "tickets";
  if (manifestPath.startsWith("seed/people/")) return "people";
  if (manifestPath.startsWith("seed/conversations/")) return "conversations";
  if (manifestPath.startsWith("seed/knowledge/")) return "knowledge";
  return null;
}

/// Whether a local folder is "empty" for seed purposes — i.e. has no
/// user-authored rows yet. `_schema.json` (plugin contract) and dotfiles
/// don't count; for nested layouts (conversations) any leaf file counts.
async function isLocalTargetEmpty(repo: string, localDir: string): Promise<boolean> {
  const root = `${repo}/${localDir}`;
  let nodes;
  try {
    nodes = await fsList(root);
  } catch {
    // Directory doesn't exist yet → treat as empty.
    return true;
  }
  for (const n of nodes) {
    if (n.is_dir) {
      // Recurse one level for nested layouts (conversations).
      const sub = await fsList(n.path).catch(() => []);
      for (const f of sub) {
        if (!f.is_dir && !f.name.startsWith(".") && f.name !== "_schema.json") {
          return false;
        }
      }
      continue;
    }
    if (n.name.startsWith(".") || n.name === "_schema.json") continue;
    return false;
  }
  return true;
}

/// Returns the set of `openit-*` collection names of the given type.
/// Throws if the cloud state can't be determined (no auth token, HTTP
/// error, parse error). Callers MUST treat thrown as "unknown" and
/// abort seeding rather than treating an empty set as "cloud is empty"
/// — that would write samples on top of populated orgs whenever the
/// token momentarily disappears (e.g. mid-refresh). (PIN-5793 BugBot R4
/// finding.)
async function listOpenitCollectionNames(
  creds: PinkfishCreds,
  type: "datastore" | "knowledge_base",
): Promise<Set<string>> {
  const token = getToken();
  if (!token) {
    throw new Error("seed: cannot check cloud state — no auth token available");
  }
  const urls = derivedUrls(creds.tokenUrl);
  const url = new URL("/datacollection/", urls.skillsBaseUrl);
  url.searchParams.set("type", type);
  const fetchFn = makeSkillsFetch(token.accessToken);
  const resp = await fetchFn(url.toString());
  if (!resp.ok) {
    throw new Error(`seed: cloud list failed (HTTP ${resp.status}) for type=${type}`);
  }
  const data = (await resp.json()) as Array<{ name?: string }> | null;
  if (!Array.isArray(data)) {
    throw new Error(`seed: cloud list returned non-array for type=${type}`);
  }
  return new Set(
    data
      .map((c) => c.name)
      .filter((n): n is string => typeof n === "string" && n.startsWith("openit-")),
  );
}

/// Run the seed pass. Safe to call multiple times — gates re-evaluate on
/// every call and short-circuit when either gate fails for a target.
///
/// `creds` is optional: in local-only mode (no connection) we skip the
/// cloud-empty check and seed purely on local-empty. There's no cloud
/// state that could be clobbered, and a fresh-install user wants sample
/// rows to interact with before they decide to connect.
export async function seedIfEmpty(args: {
  repo: string;
  creds: PinkfishCreds | null;
  onLog?: (msg: string) => void;
}): Promise<{ wrote: number }> {
  const { repo, creds, onLog } = args;
  const manifest = await fetchSkillsManifest(creds);

  // If we can't determine cloud state (no token, network blip, etc.) we
  // abort seeding entirely — the next connect will retry. Treating
  // "unknown cloud state" as "cloud is empty" would seed samples on top
  // of populated orgs. Local-only mode (no creds) explicitly treats
  // every target as cloud-empty since there's no cloud to consult.
  let cloudDatastores: Set<string>;
  let cloudKbs: Set<string>;
  if (creds) {
    try {
      cloudDatastores = await listOpenitCollectionNames(creds, "datastore");
      cloudKbs = await listOpenitCollectionNames(creds, "knowledge_base");
    } catch (err) {
      onLog?.(`seed: skipping — cloud state unknown (${err instanceof Error ? err.message : String(err)})`);
      return { wrote: 0 };
    }
  } else {
    cloudDatastores = new Set();
    cloudKbs = new Set();
  }

  // Map each target → which cloud-name set governs its gate.
  const cloudHas = (t: TargetConfig): boolean =>
    t.cloudType === "datastore" ? cloudDatastores.has(t.cloudName) : cloudKbs.has(t.cloudName);

  // Per-target gate: local-empty AND cloud-empty.
  const eligible = new Set<SeedTarget>();
  for (const t of TARGETS) {
    if (cloudHas(t)) continue;
    const empty = await isLocalTargetEmpty(repo, t.localDir);
    if (!empty) continue;
    eligible.add(t.target);
  }

  if (eligible.size === 0) {
    onLog?.("seed: every target is already populated locally or remotely — skipping");
    return { wrote: 0 };
  }

  let wrote = 0;
  for (const file of manifest.files) {
    const target = manifestPathToTarget(file.path);
    if (!target || !eligible.has(target)) continue;
    const route = seedRoute(file.path);
    if (!route) continue;
    try {
      const content = await fetchSkillFile(file.path, creds);
      await invoke("entity_write_file", {
        repo,
        subdir: route.subdir,
        filename: route.filename,
        content,
      });
      wrote += 1;
    } catch (err) {
      console.warn(`[seed] failed to write ${file.path}:`, err);
    }
  }

  onLog?.(`seed: wrote ${wrote} sample file(s) across ${eligible.size} target(s)`);
  return { wrote };
}
