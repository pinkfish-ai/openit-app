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

export async function fetchSkillsManifest(creds: PinkfishCreds): Promise<PluginManifest> {
  try {
    const manifestJson = await invoke<string>("skills_fetch_manifest", {
      appApiUrl: creds.tokenUrl,
    });
    return JSON.parse(manifestJson);
  } catch (error) {
    console.error("[skillsSync] Failed to fetch manifest:", error);
    throw error;
  }
}

export async function fetchSkillFile(skillPath: string, creds: PinkfishCreds): Promise<string> {
  try {
    return await invoke<string>("skills_fetch_file", {
      appApiUrl: creds.tokenUrl,
      skillPath,
    });
  } catch (error) {
    console.error(`[skillsSync] Failed to fetch ${skillPath}:`, error);
    throw error;
  }
}

export async function syncSkillsToDisk(
  repo: string,
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<{ bubbles: Bubble[] }> {
  try {
    const manifest = await fetchSkillsManifest(creds);
    let skillCount = 0;
    let fileCount = 0;
    let bubbleCount = (manifest.bubbles ?? []).length;

    for (const file of manifest.files) {
      try {
        const content = await fetchSkillFile(file.path, creds);

        // Handle different file types
        if (file.path === "claude-md.template.md") {
          // Write template as CLAUDE.md to repo root
          await invoke("entity_write_file", {
            repo,
            subdir: "",
            filename: "CLAUDE.md",
            content,
          });
          console.log("[skillsSync] Synced CLAUDE.md from template");
          fileCount += 1;
        } else if (file.path.startsWith("scripts/") && file.path.endsWith(".mjs")) {
          // Route plugin scripts to `.claude/scripts/<name>.mjs`. The
          // conflict prompt and other Claude-callable flows reference
          // them by that path; writing to the literal `scripts/` dir
          // would put them somewhere Claude isn't told to look.
          //
          // Manifest paths come from the network, so don't trust them
          // structurally. A path like `scripts/../../etc/passwd` would
          // strip just the leading `scripts/` and pass the traversal
          // segments straight to entity_write_file — its Rust handler
          // doesn't canonicalize. Restrict to a flat basename of the
          // expected shape; reject anything else loudly so we notice
          // when the manifest delivers something unexpected.
          const scriptName = file.path.slice("scripts/".length);
          if (
            scriptName.length === 0 ||
            !/^[a-zA-Z0-9._-]+\.mjs$/.test(scriptName) ||
            scriptName.includes("..") ||
            scriptName.includes("/") ||
            scriptName.includes("\\") ||
            scriptName.startsWith(".")
          ) {
            console.warn(
              `[skillsSync] rejected suspicious script path: ${file.path}`,
            );
            onLog?.(`  ✗ ${file.path}: invalid script name`);
            continue;
          }
          await invoke("entity_write_file", {
            repo,
            subdir: ".claude/scripts",
            filename: scriptName,
            content,
          });
          console.log(`[skillsSync] Synced script: ${scriptName}`);
          fileCount += 1;
        } else if (file.path.startsWith("skills/") && file.path.endsWith(".md")) {
          // Write skills to .claude/skills/<skillName>/SKILL.md
          const skillName = file.path.replace("skills/", "").replace(".md", "");
          let skillContent = content;

          // Ensure proper SKILL.md format with frontmatter
          if (!skillContent.startsWith("---")) {
            const nameMatch = skillContent.match(/^name:\s*(.+?)$/m);
            const descMatch = skillContent.match(/^description:\s*(.+?)$/m);
            const skillTitle = nameMatch?.[1]?.trim() ?? skillName;
            const description = descMatch?.[1]?.trim() ?? "";

            skillContent = `---
name: ${skillTitle}
description: ${description || skillName}
---

${skillContent}`;
          }

          await invoke("entity_write_file", {
            repo,
            subdir: `.claude/skills/${skillName}`,
            filename: "SKILL.md",
            content: skillContent,
          });
          console.log(`[skillsSync] Synced skill: ${skillName}`);
          skillCount += 1;
        } else {
          // Write other files preserving directory structure
          const parts = file.path.split("/");
          const filename = parts.pop() ?? file.path;
          const subdir = parts.length > 0 ? parts.join("/") : "";

          await invoke("entity_write_file", {
            repo,
            subdir,
            filename,
            content,
          });
          console.log(`[skillsSync] Synced file: ${file.path}`);
          fileCount += 1;
        }
      } catch (err) {
        console.warn(`[skillsSync] Failed to sync ${file.path}:`, err);
        onLog?.(`  ✗ ${file.path}: ${err}`);
      }
    }

    onLog?.(`    ${fileCount} file(s), ${skillCount} skill(s), ${bubbleCount} bubble(s) — synced`);
    return {
      bubbles: manifest.bubbles ?? [],
    };
  } catch (error) {
    console.error("[skillsSync] syncSkillsToDisk failed:", error);
    onLog?.(`    ✗ manifest fetch failed: ${error}`);
    return {
      bubbles: [],
    };
  }
}
