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

export async function syncSkillsToDisk(repo: string, creds: PinkfishCreds): Promise<{ bubbles: Bubble[] }> {
  try {
    const manifest = await fetchSkillsManifest(creds);

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
        }
      } catch (err) {
        console.warn(`[skillsSync] Failed to sync ${file.path}:`, err);
      }
    }

    return {
      bubbles: manifest.bubbles ?? [],
    };
  } catch (error) {
    console.error("[skillsSync] syncSkillsToDisk failed:", error);
    return {
      bubbles: [],
    };
  }
}
