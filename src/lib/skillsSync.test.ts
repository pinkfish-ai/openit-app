// Tests for the manifest-file routing table. routeFile is a pure
// function that maps a manifest entry's logical path to a concrete
// (subdir, filename) on disk, with optional {{slug}} substitution
// inside the file body. Getting any of these mappings wrong silently
// corrupts user folders (rows in the wrong dir, agents with literal
// "{{slug}}" placeholders, schemas missing), so each rule is locked
// down with an explicit case.

import { describe, expect, it } from "vitest";
import { routeFile } from "./skillsSync";

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
      expect(routeFile("skills/triage.md", slug)).toEqual({
        subdir: ".claude/skills/triage",
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
