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
  files: Array<{ path: string }>;
  bubbles?: Array<Bubble>;
};

/// Fetch the manifest. Tries cloud when creds are provided and falls back to
/// the bundled copy. With no creds, reads bundled directly. Local-first means
/// the bundled copy is always the source of truth at install/first-run time —
/// cloud is only ahead once an admin has actually edited it there.
export async function fetchSkillsManifest(
  creds: PinkfishCreds | null,
): Promise<PluginManifest> {
  if (creds) {
    try {
      const manifestJson = await invoke<string>("skills_fetch_manifest", {
        appApiUrl: creds.tokenUrl,
      });
      return JSON.parse(manifestJson);
    } catch (error) {
      console.warn("[skillsSync] cloud manifest fetch failed, falling back to bundled:", error);
    }
  }
  const manifestJson = await invoke<string>("skills_fetch_bundled_manifest");
  return JSON.parse(manifestJson);
}

export async function fetchSkillFile(
  skillPath: string,
  creds: PinkfishCreds | null,
): Promise<string> {
  if (creds) {
    try {
      return await invoke<string>("skills_fetch_file", {
        appApiUrl: creds.tokenUrl,
        skillPath,
      });
    } catch (error) {
      console.warn(`[skillsSync] cloud fetch ${skillPath} failed, falling back to bundled:`, error);
    }
  }
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
    const agentBase = filePath
      .replace("agents/", "")
      .replace(".template.json", "");
    return {
      subdir: "agents",
      filename: `${agentBase}.json`,
      substituteSlug: false,
    };
  }
  if (filePath.startsWith("scripts/")) {
    const filename = filePath.replace("scripts/", "");
    return { subdir: ".claude/scripts", filename, substituteSlug: false };
  }
  // Default: preserve manifest layout under repo root.
  const parts = filePath.split("/");
  const filename = parts.pop() ?? filePath;
  const subdir = parts.length > 0 ? parts.join("/") : "";
  return { subdir, filename, substituteSlug: false };
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

    onLog?.(`    ${fileCount} file(s), ${skillCount} skill(s), ${bubbleCount} bubble(s) — synced`);
    return { bubbles: manifest.bubbles ?? [] };
  } catch (error) {
    console.error("[skillsSync] syncSkillsToDisk failed:", error);
    onLog?.(`    ✗ manifest fetch failed: ${error}`);
    return { bubbles: [] };
  }
}
