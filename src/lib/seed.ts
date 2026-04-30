// Bundled-seed helper, exposed via the "Create sample dataset" CTA in
// `getting-started.md`. Writes sample tickets/people/conversations/KB
// articles to disk so a user has something to interact with.
//
// **Connected mode never auto-seeds.** Seeding is exclusively user-
// triggered — once an account is in the loop, we trust whatever's on
// disk and in the cloud.
//
// Gate is **per-file**, not per-folder: re-clicking the CTA fills in
// any missing sample without clobbering files that already exist on
// disk. A user who deleted `sample-ticket-3.json` and clicks again
// gets just that one file back. A user who has authored their own
// tickets alongside the samples gets nothing rewritten.

import { invoke } from "@tauri-apps/api/core";
import { fsRead } from "./api";
import { fetchSkillFile, fetchSkillsManifest } from "./skillsSync";

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
  if (manifestPath.startsWith("seed/skills/")) {
    return { subdir: "filestores/skills", filename: manifestPath.replace("seed/skills/", "") };
  }
  if (manifestPath.startsWith("seed/scripts/")) {
    return { subdir: "filestores/scripts", filename: manifestPath.replace("seed/scripts/", "") };
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

/// Does the destination file already exist on disk? Used by the
/// per-file seed gate to skip without clobbering. `fsRead` throws
/// (file not found / permission / unreadable) → treat as missing.
async function fileExists(repo: string, subdir: string, filename: string): Promise<boolean> {
  try {
    await fsRead(`${repo}/${subdir}/${filename}`);
    return true;
  } catch {
    return false;
  }
}

/// Run the seed pass. Gate is per-file: every missing sample lands,
/// every existing sample is skipped (no clobber).
export async function seedIfEmpty(args: {
  repo: string;
  onLog?: (msg: string) => void;
}): Promise<{ wrote: number; skipped: number }> {
  const { repo, onLog } = args;
  const manifest = await fetchSkillsManifest(null);

  let wrote = 0;
  let skipped = 0;
  for (const file of manifest.files) {
    const route = seedRoute(file.path);
    if (!route) continue;
    if (await fileExists(repo, route.subdir, route.filename)) {
      skipped += 1;
      continue;
    }
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

  onLog?.(`seed: wrote ${wrote} sample file(s), skipped ${skipped} already on disk`);
  return { wrote, skipped };
}
