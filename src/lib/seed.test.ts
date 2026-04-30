/**
 * seedIfEmpty gate logic — Phase 3 of V2 sync (PIN-5793).
 *
 * The cloud-side check + manifest fetch + file fetch are all stubbed via
 * vi.mock so we can isolate the per-target gate logic (folder-empty AND
 * cloud-empty) without spinning up a Tauri runtime.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock factories — vitest hoists vi.mock() to the top of the file,
// so any closed-over variable has to live inside the factory itself.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./api", () => ({
  fsList: vi.fn(),
}));
vi.mock("../api/fetchAdapter", () => ({
  makeSkillsFetch: vi.fn(),
}));
vi.mock("./pinkfishAuth", () => ({
  getToken: vi.fn(),
  derivedUrls: vi.fn(),
}));
vi.mock("./skillsSync", () => ({
  fetchSkillsManifest: vi.fn(),
  fetchSkillFile: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { fsList } from "./api";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { getToken, derivedUrls } from "./pinkfishAuth";
import { fetchSkillsManifest, fetchSkillFile } from "./skillsSync";
import { seedIfEmpty, seedRoute } from "./seed";

const mockInvoke = vi.mocked(invoke);
const mockFsList = vi.mocked(fsList);
const mockMakeSkillsFetch = vi.mocked(makeSkillsFetch);
const mockGetToken = vi.mocked(getToken);
const mockDerivedUrls = vi.mocked(derivedUrls);
const mockFetchSkillsManifest = vi.mocked(fetchSkillsManifest);
const mockFetchSkillFile = vi.mocked(fetchSkillFile);

const FAKE_CREDS = { orgId: "org-1", tokenUrl: "https://app-api.example/oauth/token" } as any;

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
  mockGetToken.mockReturnValue({ accessToken: "tk-abc" } as any);
  mockDerivedUrls.mockReturnValue({
    skillsBaseUrl: "https://skills.example",
    appApiBaseUrl: "https://app-api.example",
  } as any);
  mockFetchSkillsManifest.mockResolvedValue(SAMPLE_MANIFEST as any);
  mockFetchSkillFile.mockResolvedValue("{}");
  mockInvoke.mockResolvedValue(undefined);
});

/** Convenience: stub the cloud-collection list endpoint. */
function stubCloud(datastoreNames: string[], kbNames: string[]): void {
  mockMakeSkillsFetch.mockReturnValue(((url: string) => {
    if (url.includes("type=datastore")) {
      return Promise.resolve({
        ok: true,
        json: async () => datastoreNames.map((name) => ({ name, id: `ds-${name}` })),
      } as any);
    }
    if (url.includes("type=knowledge_base")) {
      return Promise.resolve({
        ok: true,
        json: async () => kbNames.map((name) => ({ name, id: `kb-${name}` })),
      } as any);
    }
    return Promise.resolve({ ok: false, json: async () => null } as any);
  }) as any);
}

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

describe("seedIfEmpty — per-target gate", () => {
  it("seeds every target when local is empty and cloud has no openit-* collections", async () => {
    stubCloud([], []);
    mockFsList.mockResolvedValue([]);

    const res = await seedIfEmpty({ repo: "/repo", creds: FAKE_CREDS });

    expect(res.wrote).toBe(6); // 2 tickets + 1 person + 1 article + 2 conv messages
    const writeInvocations = mockInvoke.mock.calls.filter(([cmd]) => cmd === "entity_write_file");
    expect(writeInvocations).toHaveLength(6);
  });

  it("skips a target when its local folder is non-empty", async () => {
    stubCloud([], []);
    mockFsList.mockImplementation(async (p: string) => {
      if (p.endsWith("databases/tickets")) {
        return [{ name: "user-row.json", path: `${p}/user-row.json`, is_dir: false }];
      }
      return [];
    });

    const res = await seedIfEmpty({ repo: "/repo", creds: FAKE_CREDS });

    expect(res.wrote).toBe(4); // 1 person + 1 article + 2 conv messages (tickets skipped)
  });

  it("skips a target when cloud already has the matching openit-* collection", async () => {
    stubCloud(["openit-tickets"], []);
    mockFsList.mockResolvedValue([]);

    const res = await seedIfEmpty({ repo: "/repo", creds: FAKE_CREDS });

    expect(res.wrote).toBe(4);
  });

  it("treats `_schema.json` and dotfiles as 'empty' for gate purposes", async () => {
    stubCloud([], []);
    mockFsList.mockImplementation(async (p: string) => {
      if (p.endsWith("databases/tickets")) {
        return [
          { name: "_schema.json", path: `${p}/_schema.json`, is_dir: false },
          { name: ".DS_Store", path: `${p}/.DS_Store`, is_dir: false },
        ];
      }
      return [];
    });

    const res = await seedIfEmpty({ repo: "/repo", creds: FAKE_CREDS });

    expect(res.wrote).toBe(6);
  });

  it("treats nested-layout content as non-empty for the conversations target", async () => {
    stubCloud([], []);
    mockFsList.mockImplementation(async (p: string) => {
      if (p.endsWith("databases/conversations")) {
        return [{ name: "T1", path: `${p}/T1`, is_dir: true }];
      }
      if (p.endsWith("databases/conversations/T1")) {
        return [{ name: "msg-existing.json", path: `${p}/msg-existing.json`, is_dir: false }];
      }
      return [];
    });

    const res = await seedIfEmpty({ repo: "/repo", creds: FAKE_CREDS });

    expect(res.wrote).toBe(4); // tickets + person + article (conversations skipped)
  });

  it("skips everything when both local and cloud are populated", async () => {
    stubCloud(["openit-tickets", "openit-people", "openit-conversations"], ["openit-default"]);
    mockFsList.mockResolvedValue([
      { name: "anything.json", path: "/anything.json", is_dir: false },
    ]);

    const res = await seedIfEmpty({ repo: "/repo", creds: FAKE_CREDS });

    expect(res.wrote).toBe(0);
  });
});
