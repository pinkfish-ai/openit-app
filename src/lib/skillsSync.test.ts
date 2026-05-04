// Tests for the manifest-file routing table. routeFile is a pure
// function that maps a manifest entry's logical path to a concrete
// (subdir, filename) on disk, with optional {{slug}} substitution
// inside the file body. Getting any of these mappings wrong silently
// corrupts user folders (rows in the wrong dir, agents with literal
// "{{slug}}" placeholders, schemas missing), so each rule is locked
// down with an explicit case.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { routeFile, syncSkillsToDisk } from "./skillsSync";

describe("routeFile", () => {
  const slug = "my-helpdesk";

  describe("CLAUDE.md", () => {
    it("routes to repo root", () => {
      expect(routeFile("CLAUDE.md", slug)).toEqual({
        subdir: "",
        filename: "CLAUDE.md",
        substituteSlug: false,
      });
    });

    it("routes the legacy template name to the same place", () => {
      expect(routeFile("claude-md.template.md", slug)).toEqual({
        subdir: "",
        filename: "CLAUDE.md",
        substituteSlug: false,
      });
    });
  });

  describe("skills/", () => {
    it("expands name to .claude/skills/<name>/SKILL.md", () => {
      expect(routeFile("skills/ai-intake.md", slug)).toEqual({
        subdir: ".claude/skills/ai-intake",
        filename: "SKILL.md",
        substituteSlug: false,
      });
    });

    it("handles multi-word skill names", () => {
      expect(routeFile("skills/answer-ticket.md", slug)).toEqual({
        subdir: ".claude/skills/answer-ticket",
        filename: "SKILL.md",
        substituteSlug: false,
      });
    });
  });

  describe("schemas/", () => {
    it("routes <col>._schema.json to databases/<col>/_schema.json (slug-free)", () => {
      expect(routeFile("schemas/tickets._schema.json", slug)).toEqual({
        subdir: "databases/tickets",
        filename: "_schema.json",
        substituteSlug: false,
      });
    });

    it("handles people schema the same way", () => {
      expect(routeFile("schemas/people._schema.json", "local")).toEqual({
        subdir: "databases/people",
        filename: "_schema.json",
        substituteSlug: false,
      });
    });
  });

  describe("agents/<name>.template.json", () => {
    it("strips .template suffix; lands at agents/<name>.json (slug-free)", () => {
      expect(routeFile("agents/triage.template.json", slug)).toEqual({
        subdir: "agents",
        filename: "triage.json",
        substituteSlug: false,
      });
    });

    it("preserves the folder structure for nested agent templates", () => {
      expect(routeFile("agents/triage/triage.template.json", slug)).toEqual({
        subdir: "agents/triage",
        filename: "triage.json",
        substituteSlug: false,
      });
    });

    it("routes nested .md files under agents/<folder> through the default rule", () => {
      // common.md / cloud.md / local.md ride the default fallback —
      // the agent template rule only fires for .template.json basenames.
      expect(routeFile("agents/triage/common.md", slug)).toEqual({
        subdir: "agents/triage",
        filename: "common.md",
        substituteSlug: false,
      });
    });

    it("non-template agent files preserved as-is", () => {
      expect(routeFile("agents/some-other.json", slug)).toEqual({
        subdir: "agents",
        filename: "some-other.json",
        substituteSlug: false,
      });
    });
  });

  describe("scripts/", () => {
    it("routes scripts/<file> to .claude/scripts/<file>", () => {
      expect(routeFile("scripts/sync-push.mjs", slug)).toEqual({
        subdir: ".claude/scripts",
        filename: "sync-push.mjs",
        substituteSlug: false,
      });
    });

    it("preserves dotfile names under scripts/", () => {
      expect(routeFile("scripts/.helper.mjs", slug)).toEqual({
        subdir: ".claude/scripts",
        filename: ".helper.mjs",
        substituteSlug: false,
      });
    });
  });

  describe("default path preservation", () => {
    it("keeps unrecognized layouts under repo root", () => {
      expect(routeFile("misc/notes.md", slug)).toEqual({
        subdir: "misc",
        filename: "notes.md",
        substituteSlug: false,
      });
    });

    it("a top-level unrecognized file lands at repo root", () => {
      expect(routeFile("LICENSE", slug)).toEqual({
        subdir: "",
        filename: "LICENSE",
        substituteSlug: false,
      });
    });
  });

  describe("slug parameter", () => {
    it("ignores slug for schemas (output is slug-free)", () => {
      const r = routeFile("schemas/tickets._schema.json", "any-slug-here");
      expect(r?.subdir).toBe("databases/tickets");
    });

    it("ignores slug for agents (output is slug-free)", () => {
      const r = routeFile("agents/triage.template.json", "any-slug-here");
      expect(r?.filename).toBe("triage.json");
    });
  });
});

describe("syncSkillsToDisk — agent write-once gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips writing agents/<name>.json when the file already exists on disk", async () => {
    const writeCalls: Array<Record<string, unknown>> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "skills_fetch_bundled_manifest") {
        return JSON.stringify({
          version: "test-1",
          files: [{ path: "agents/triage.template.json" }],
        }) as never;
      }
      if (cmd === "skills_fetch_bundled_file") {
        return JSON.stringify({ name: "triage" }) as never;
      }
      if (cmd === "fs_read") {
        // Simulate the agent file already existing on disk so the
        // write-once gate fires.
        return "existing user-edited content" as never;
      }
      if (cmd === "entity_write_file") {
        writeCalls.push(args as Record<string, unknown>);
        return undefined as never;
      }
      return undefined as never;
    });

    await syncSkillsToDisk("/repo", null);

    const agentWrites = writeCalls.filter(
      (c) => c.subdir === "agents" && c.filename === "triage.json",
    );
    expect(agentWrites).toEqual([]);
  });

  it("preserves user-edited files inside agents/<folder>/* across plugin bumps", async () => {
    const writeCalls: Array<Record<string, unknown>> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "skills_fetch_bundled_manifest") {
        return JSON.stringify({
          version: "test-2",
          files: [
            { path: "agents/triage/triage.template.json" },
            { path: "agents/triage/common.md" },
            { path: "agents/triage/cloud.md" },
            { path: "agents/triage/local.md" },
          ],
        }) as never;
      }
      if (cmd === "skills_fetch_bundled_file") {
        return "bundled" as never;
      }
      if (cmd === "fs_read") {
        // Every probe finds an existing file → gate fires for all four.
        return "existing" as never;
      }
      if (cmd === "entity_write_file") {
        writeCalls.push(args as Record<string, unknown>);
        return undefined as never;
      }
      return undefined as never;
    });

    await syncSkillsToDisk("/repo", null);

    const triageWrites = writeCalls.filter(
      (c) => typeof c.subdir === "string" && (c.subdir as string).startsWith("agents/"),
    );
    expect(triageWrites).toEqual([]);
  });

  it("writes agents/<name>.json when the file is missing", async () => {
    const writeCalls: Array<Record<string, unknown>> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "skills_fetch_bundled_manifest") {
        return JSON.stringify({
          version: "test-1",
          files: [{ path: "agents/triage.template.json" }],
        }) as never;
      }
      if (cmd === "skills_fetch_bundled_file") {
        return JSON.stringify({ name: "triage" }) as never;
      }
      if (cmd === "fs_read") {
        // File missing → fileExistsOnDisk returns false → write fires.
        throw new Error("ENOENT");
      }
      if (cmd === "entity_write_file") {
        writeCalls.push(args as Record<string, unknown>);
        return undefined as never;
      }
      return undefined as never;
    });

    await syncSkillsToDisk("/repo", null);

    const agentWrites = writeCalls.filter(
      (c) => c.subdir === "agents" && c.filename === "triage.json",
    );
    expect(agentWrites).toHaveLength(1);
  });
});
