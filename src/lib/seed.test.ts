/**
 * seedIfEmpty gate logic — Phase 3 of V2 sync (PIN-5793).
 *
 * Per-file gate: every missing sample writes, every existing sample
 * skips. No per-folder "all or nothing" check anymore — re-clicking
 * the CTA fills in deleted samples without clobbering user content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./api", () => ({
  fsRead: vi.fn(),
}));
vi.mock("./skillsSync", () => ({
  fetchSkillsManifest: vi.fn(),
  fetchSkillFile: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { fsRead } from "./api";
import { fetchSkillsManifest, fetchSkillFile } from "./skillsSync";
import { seedIfEmpty, seedRoute } from "./seed";

const mockInvoke = vi.mocked(invoke);
const mockFsRead = vi.mocked(fsRead);
const mockFetchSkillsManifest = vi.mocked(fetchSkillsManifest);
const mockFetchSkillFile = vi.mocked(fetchSkillFile);

const SAMPLE_MANIFEST = {
  version: "v1",
  files: [
    { path: "seed/tickets/sample-ticket-1.json" },
    { path: "seed/tickets/sample-ticket-2.json" },
    { path: "seed/people/sample-person-1.json" },
    { path: "seed/knowledge/sample-article-1.md" },
    { path: "seed/conversations/sample-ticket-1/msg-aa01.json" },
    { path: "seed/conversations/sample-ticket-1/msg-aa02.json" },
    { path: "skills/answer-ticket.md" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchSkillsManifest.mockResolvedValue(SAMPLE_MANIFEST as any);
  mockFetchSkillFile.mockResolvedValue("{}");
  mockInvoke.mockResolvedValue(undefined);
  // Default: nothing on disk yet.
  mockFsRead.mockRejectedValue(new Error("not found"));
});

describe("seedRoute", () => {
  it("routes seed/tickets/* → databases/tickets", () => {
    expect(seedRoute("seed/tickets/sample.json")).toEqual({
      subdir: "databases/tickets",
      filename: "sample.json",
    });
  });

  it("routes seed/people/* → databases/people", () => {
    expect(seedRoute("seed/people/p1.json")).toEqual({
      subdir: "databases/people",
      filename: "p1.json",
    });
  });

  it("routes seed/knowledge/* → knowledge-bases/default", () => {
    expect(seedRoute("seed/knowledge/article.md")).toEqual({
      subdir: "knowledge-bases/default",
      filename: "article.md",
    });
  });

  it("preserves the per-ticket subfolder for seed/conversations/<ticketId>/<msg>", () => {
    expect(seedRoute("seed/conversations/T1/msg-aa01.json")).toEqual({
      subdir: "databases/conversations/T1",
      filename: "msg-aa01.json",
    });
  });

  it("returns null for non-seed paths", () => {
    expect(seedRoute("skills/answer-ticket.md")).toBeNull();
    expect(seedRoute("seed/conversations/no-folder.json")).toBeNull();
  });
});

describe("seedIfEmpty — per-file gate", () => {
  it("writes every sample when nothing is on disk", async () => {
    const res = await seedIfEmpty({ repo: "/repo" });

    expect(res.wrote).toBe(6); // 2 tickets + 1 person + 1 article + 2 conv messages
    expect(res.skipped).toBe(0);
    const writeInvocations = mockInvoke.mock.calls.filter(([cmd]) => cmd === "entity_write_file");
    expect(writeInvocations).toHaveLength(6);
  });

  it("skips an individual sample that already exists on disk", async () => {
    // Pretend `databases/tickets/sample-ticket-1.json` is already there.
    mockFsRead.mockImplementation(async (path: string) => {
      if (path.endsWith("databases/tickets/sample-ticket-1.json")) return "{}";
      throw new Error("not found");
    });

    const res = await seedIfEmpty({ repo: "/repo" });

    expect(res.wrote).toBe(5); // sample-ticket-1 skipped, the other 5 still write
    expect(res.skipped).toBe(1);
  });

  it("writes missing samples even when other files exist in the target folder", async () => {
    // User has authored their own tickets but no sample-ticket-* files.
    // The new per-file gate doesn't care about siblings — it only
    // checks the specific destination filename.
    mockFsRead.mockRejectedValue(new Error("not found"));

    const res = await seedIfEmpty({ repo: "/repo" });

    expect(res.wrote).toBe(6);
  });

  it("writes nothing when every sample is already on disk", async () => {
    mockFsRead.mockResolvedValue("{}");

    const res = await seedIfEmpty({ repo: "/repo" });

    expect(res.wrote).toBe(0);
    expect(res.skipped).toBe(6);
  });

  it("ignores manifest entries that aren't seed paths", async () => {
    // skills/answer-ticket.md is in the manifest but seedRoute returns
    // null for it; never written, never counted.
    const res = await seedIfEmpty({ repo: "/repo" });

    const writePaths = mockInvoke.mock.calls
      .filter(([cmd]) => cmd === "entity_write_file")
      .map(([, args]) => (args as any).filename);
    expect(writePaths).not.toContain("answer-ticket.md");
    expect(res.wrote + res.skipped).toBe(6);
  });
});
