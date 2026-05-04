import { invoke } from "@tauri-apps/api/core";
import { type PinkfishCreds } from "./pinkfishAuth";

export type Skill = {
  name: string;
  description: string;
  path: string;
};

export type Bubble = {
  label: string;
  skill: string;
};

export type PluginManifest = {
  version?: string;
  files: Array<{ path: string }>;
  bubbles?: Array<Bubble>;
};

/// Path of the on-disk version sentinel relative to repo root. Tracks the
/// `manifest.version` of the most recent successful bundled-plugin sync
/// so relaunches can tell when the bundle has rolled forward and
/// re-sync is needed (without nuking user edits to non-plugin files).
const PLUGIN_VERSION_SENTINEL = ".openit/plugin-version";

/// Read the version of the last successful sync. Returns null when the
/// sentinel is missing or unreadable — the caller treats that as
/// "out-of-date" so a fresh sync runs on first launch under a new build.
export async function readSyncedPluginVersion(repo: string): Promise<string | null> {
  try {
    const raw = await invoke<string>("fs_read", { path: `${repo}/${PLUGIN_VERSION_SENTINEL}` });
    const trimmed = raw.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function writeSyncedPluginVersion(repo: string, version: string): Promise<void> {
  try {
    await invoke("entity_write_file", {
      repo,
      subdir: ".openit",
      filename: "plugin-version",
      content: version,
    });
  } catch (err) {
    console.warn("[skillsSync] failed to write plugin-version sentinel:", err);
  }
}

/// Fetch the manifest. Always reads the bundled copy shipped with the app
/// binary. Cloud-served plugin fetch is disabled until dev is stable —
/// re-enable by restoring the `creds` branch that calls
/// `skills_fetch_manifest` (Rust command stays registered).
export async function fetchSkillsManifest(
  _creds: PinkfishCreds | null,
): Promise<PluginManifest> {
  const manifestJson = await invoke<string>("skills_fetch_bundled_manifest");
  return JSON.parse(manifestJson);
}

export async function fetchSkillFile(
  skillPath: string,
  _creds: PinkfishCreds | null,
): Promise<string> {
  return await invoke<string>("skills_fetch_bundled_file", { skillPath });
}

/// Resolve where on disk a manifest file lands. Returns { subdir, filename }
/// relative to the repo root, or null to skip writing this file.
///
/// Database/agent dirs use stable, slug-free names so the layout matches
/// the user's mental model and stays consistent if they later connect to
/// cloud (the engine maps these to `<colName>-<orgId>` collections at
/// push time; the local layout doesn't change).
///
/// Routing rules:
///   - `CLAUDE.md`                          → `CLAUDE.md` (repo root)
///   - `claude-md.template.md` (legacy)     → `CLAUDE.md` (repo root)
///   - `skills/<name>.md`                   → `.claude/skills/<name>/SKILL.md`
///   - `schemas/<col>._schema.json`         → `databases/<col>/_schema.json`
///   - `agents/<name>.template.json`        → `agents/<name>.json`
///   - `scripts/<file>`                     → `.claude/scripts/<file>`
///   - `seed/<target>/...`                  → null (handled by seedIfEmpty;
///                                              writing seed during the main
///                                              plugin sync would clobber
///                                              user-touched rows on every
///                                              bundle bump)
///   - anything else                        → preserve original layout
///
/// `substituteSlug` is no longer set by any current rule (the slug
/// suffix on dirs was dropped) but the field is kept for future per-
/// file substitution if needed.
export function routeFile(
  filePath: string,
  _slug: string,
): { subdir: string; filename: string; substituteSlug: boolean } | null {
  if (filePath === "CLAUDE.md" || filePath === "claude-md.template.md") {
    return { subdir: "", filename: "CLAUDE.md", substituteSlug: false };
  }
  if (filePath.startsWith("skills/") && filePath.endsWith(".md")) {
    const skillName = filePath.replace("skills/", "").replace(".md", "");
    return {
      subdir: `.claude/skills/${skillName}`,
      filename: "SKILL.md",
      substituteSlug: false,
    };
  }
  if (filePath.startsWith("schemas/") && filePath.endsWith("._schema.json")) {
    const colName = filePath
      .replace("schemas/", "")
      .replace("._schema.json", "");
    return {
      subdir: `databases/${colName}`,
      filename: "_schema.json",
      substituteSlug: false,
    };
  }
  if (filePath.startsWith("agents/") && filePath.endsWith(".template.json")) {
    // Preserve any folder structure so `agents/triage/triage.template.json`
    // lands at `agents/triage/triage.json`, not `agents/triage/triage.json`
    // with a slash inside the filename (which entity_write_file mishandles
    // for path-aware tools downstream).
    const lastSlash = filePath.lastIndexOf("/");
    const subdir = filePath.slice(0, lastSlash);
    const filename = filePath
      .slice(lastSlash + 1)
      .replace(".template.json", ".json");
    return { subdir, filename, substituteSlug: false };
  }
  if (filePath.startsWith("scripts/")) {
    const filename = filePath.replace("scripts/", "");
    return { subdir: ".claude/scripts", filename, substituteSlug: false };
  }
  // Seed files are not written by the plugin-sync pass. `seedIfEmpty`
  // (src/lib/seed.ts) gates them on per-target empty-folder + cloud-empty
  // and writes once on first connect. Returning null here keeps
  // `syncSkillsToDisk` from re-writing samples on every plugin bump.
  if (filePath.startsWith("seed/")) {
    return null;
  }
  // Default: preserve manifest layout under repo root.
  const parts = filePath.split("/");
  const filename = parts.pop() ?? filePath;
  const subdir = parts.length > 0 ? parts.join("/") : "";
  return { subdir, filename, substituteSlug: false };
}

/// Probe disk for an existing file. Used by the agent write-once gate
/// below — once the user has edited `agents/openit-triage.json`, every
/// future plugin version bump must leave their edits alone. `fsRead`
/// throws on missing → false; any other failure path also returns
/// false so a transient read error doesn't permanently block re-sync.
async function fileExistsOnDisk(
  repo: string,
  subdir: string,
  filename: string,
): Promise<boolean> {
  try {
    const path = subdir ? `${repo}/${subdir}/${filename}` : `${repo}/${filename}`;
    await invoke<string>("fs_read", { path });
    return true;
  } catch {
    return false;
  }
}

function ensureSkillFrontmatter(skillName: string, content: string): string {
  if (content.startsWith("---")) return content;
  const nameMatch = content.match(/^name:\s*(.+?)$/m);
  const descMatch = content.match(/^description:\s*(.+?)$/m);
  // `||` not `??` — a `description:` line that's present but empty (or
  // whitespace-only after trim) should still fall back to the skill
  // name, not write an empty description into the frontmatter.
  const skillTitle = nameMatch?.[1]?.trim() || skillName;
  const description = descMatch?.[1]?.trim() || skillName;
  return `---\nname: ${skillTitle}\ndescription: ${description}\n---\n\n${content}`;
}

export async function syncSkillsToDisk(
  repo: string,
  creds: PinkfishCreds | null,
  onLog?: (msg: string) => void,
): Promise<{ bubbles: Bubble[] }> {
  // Slug = repo basename. Same value used by kbSync / datastoreSync to
  // suffix collection names. Keeps schemas/agents/databases all aligned.
  const slug = repo.split("/").filter(Boolean).pop() ?? repo;
  try {
    const manifest = await fetchSkillsManifest(creds);
    let skillCount = 0;
    let fileCount = 0;
    const bubbleCount = (manifest.bubbles ?? []).length;
    const writtenPaths: string[] = [];

    for (const file of manifest.files) {
      try {
        const route = routeFile(file.path, slug);
        if (!route) continue;
        // Write-once gate for agent files. The plugin sync runs on every
        // version bump; without this, an upgrade silently overwrites
        // user-edited `agents/<name>.json` instructions. Agents are the
        // only manifest-routed destination the user edits in place — KB
        // articles / scripts / schemas are managed by Claude or the
        // plugin, not free-text user input.
        if (route.subdir === "agents" || route.subdir.startsWith("agents/")) {
          if (await fileExistsOnDisk(repo, route.subdir, route.filename)) {
            console.log(
              `[skillsSync] preserved user-edited ${route.subdir}/${route.filename}`,
            );
            continue;
          }
        }
        let content = await fetchSkillFile(file.path, creds);
        if (route.substituteSlug) {
          content = content.replace(/\{\{slug\}\}/g, slug);
        }
        if (file.path.startsWith("skills/") && file.path.endsWith(".md")) {
          const skillName = file.path.replace("skills/", "").replace(".md", "");
          content = ensureSkillFrontmatter(skillName, content);
          skillCount += 1;
        } else {
          fileCount += 1;
        }
        await invoke("entity_write_file", {
          repo,
          subdir: route.subdir,
          filename: route.filename,
          content,
        });
        const relPath = route.subdir ? `${route.subdir}/${route.filename}` : route.filename;
        // Skip paths that .gitignore rejects (.claude/, CLAUDE.md). Passing
        // them to `git add` is fatal — git refuses the entire add list with
        // "paths are ignored by one of your .gitignore files", which then
        // blocks the auto-commit of the non-ignored siblings.
        const isGitignored =
          relPath.startsWith(".claude/") ||
          relPath === "CLAUDE.md" ||
          relPath.startsWith(".openit/");
        if (!isGitignored) writtenPaths.push(relPath);
        console.log(`[skillsSync] Synced ${file.path} → ${relPath}`);
      } catch (err) {
        console.warn(`[skillsSync] Failed to sync ${file.path}:`, err);
        onLog?.(`  ✗ ${file.path}: ${err}`);
      }
    }

    // Roll the synced files into a commit so a fresh bootstrap doesn't
    // surface bundled scaffolding as "untracked changes" in the Deploy
    // panel. git_commit_paths is a no-op when nothing in `paths` has
    // changed, so this stays clean on subsequent re-syncs.
    if (writtenPaths.length > 0) {
      try {
        await invoke("git_commit_paths", {
          repo,
          paths: writtenPaths,
          message: "init: bundled plugin",
        });
      } catch (err) {
        console.warn("[skillsSync] commit of bundled plugin failed:", err);
      }
    }

    if (manifest.version) {
      await writeSyncedPluginVersion(repo, manifest.version);
    }

    onLog?.(`    ${fileCount} file(s), ${skillCount} skill(s), ${bubbleCount} bubble(s) — synced`);
    return { bubbles: manifest.bubbles ?? [] };
  } catch (error) {
    console.error("[skillsSync] syncSkillsToDisk failed:", error);
    onLog?.(`    ✗ manifest fetch failed: ${error}`);
    return { bubbles: [] };
  }
}
