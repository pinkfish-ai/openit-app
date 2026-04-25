import { invoke } from "@tauri-apps/api/core";
import { type PinkfishCreds } from "./pinkfishAuth";

export type Skill = {
  name: string;
  description: string;
  path: string;
};

export async function fetchSkillsManifest(creds: PinkfishCreds): Promise<{ files: Array<{ path: string }> }> {
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

export async function syncSkillsToDisk(repo: string, creds: PinkfishCreds): Promise<Skill[]> {
  try {
    const manifest = await fetchSkillsManifest(creds);
    const skills: Skill[] = [];

    for (const file of manifest.files) {
      if (!file.path.startsWith("skills/") || !file.path.endsWith(".md")) {
        continue;
      }

      try {
        const content = await fetchSkillFile(file.path, creds);

        const skillName = file.path.replace("skills/", "").replace(".md", "");
        const skillContent = content;

        await invoke("entity_write_file", {
          repo,
          subdir: ".claude/skills",
          filename: `${skillName}.md`,
          content: skillContent,
        });

        const nameMatch = skillContent.match(/^name:\s*(.+)$/m);
        const descMatch = skillContent.match(/^description:\s*(.+)$/m);

        skills.push({
          name: nameMatch?.[1] ?? skillName,
          description: descMatch?.[1] ?? "",
          path: `${repo}/.claude/skills/${skillName}.md`,
        });

        console.log(`[skillsSync] Synced skill: ${skillName}`);
      } catch (err) {
        console.warn(`[skillsSync] Failed to sync ${file.path}:`, err);
      }
    }

    return skills;
  } catch (error) {
    console.error("[skillsSync] syncSkillsToDisk failed:", error);
    return [];
  }
}
