// Bundled-seed first-install helper. Writes sample tickets/people/
// conversations/KB articles to disk on a fresh local-only install so
// the user lands on a populated workspace before connecting.
//
// **Connected mode never seeds.** The seed is a first-install affordance
// only — once an account is in the loop, we trust cloud state. (Earlier
// drafts gated on `local-empty AND cloud-empty`, but the cloud probe was
// a footgun: a transient blip that returned 0 collections would mis-seed
// on top of populated orgs. Decoupling makes the contract simple: seed
// runs in local-only bootstrap, never anywhere else.)
//
// Per-target gate is just "is the local folder empty?" — `_schema.json`
// (plugin contract) and dotfiles don't count. Once a sample is written,
// it's a normal local row; deleting it doesn't bring it back, and a
// later connect treats it as a regular unstaged push.

import { invoke } from "@tauri-apps/api/core";
import { fsList } from "./api";
import { fetchSkillFile, fetchSkillsManifest } from "./skillsSync";

type SeedTarget = "tickets" | "people" | "conversations" | "knowledge";

type TargetConfig = {
  target: SeedTarget;
  /** Workspace path under `<repo>/`. */
  localDir: string;
};

const TARGETS: TargetConfig[] = [
  { target: "tickets",       localDir: "databases/tickets" },
  { target: "people",        localDir: "databases/people" },
  { target: "conversations", localDir: "databases/conversations" },
  { target: "knowledge",     localDir: "knowledge-bases/default" },
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

/// Run the local-only seed pass. Safe to call multiple times — gates
/// re-evaluate on every call and a target with any user-authored content
/// short-circuits.
export async function seedIfEmpty(args: {
  repo: string;
  onLog?: (msg: string) => void;
}): Promise<{ wrote: number }> {
  const { repo, onLog } = args;
  const manifest = await fetchSkillsManifest(null);

  const eligible = new Set<SeedTarget>();
  for (const t of TARGETS) {
    const empty = await isLocalTargetEmpty(repo, t.localDir);
    if (!empty) continue;
    eligible.add(t.target);
  }

  if (eligible.size === 0) {
    onLog?.("seed: every target is already populated locally — skipping");
    return { wrote: 0 };
  }

  let wrote = 0;
  for (const file of manifest.files) {
    const target = manifestPathToTarget(file.path);
    if (!target || !eligible.has(target)) continue;
    const route = seedRoute(file.path);
    if (!route) continue;
    try {
      const content = await fetchSkillFile(file.path, null);
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
