// Tests for the V1 push-side surface on the agent adapter — narrow
// canonicalize-for-disk shape and the typed REST wrappers
// (POST/PATCH/DELETE). The 409 mapping to OutOfSync is the load-bearing
// piece; without it the push wrapper can't tell version conflicts from
// generic HTTP failures.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../pinkfishAuth", () => ({
  derivedUrls: () => ({
    appBaseUrl: "https://app-api.example.com",
    skillsBaseUrl: "https://skills.example.com",
  }),
  getToken: () => ({ accessToken: "tkn-123" }),
}));

const fetchSpy = vi.fn();
vi.mock("../../api/fetchAdapter", () => ({
  makeSkillsFetch: (_token: string, _scheme: "bearer" | "cognito") =>
    (...args: unknown[]) =>
      // Forward to the spy so tests can configure responses + assert
      // call shape.
      fetchSpy(...args),
}));

import {
  patchUserAgent,
  postUserAgent,
  getUserAgent,
  deleteUserAgent,
  releaseUserAgent,
  resolveResourceRefs,
  assembleInstructions,
  instructionsHash,
} from "./agent";
import { OutOfSync } from "../syncEngine";

const creds = {
  tokenUrl: "https://stage.pinkfish.ai",
  orgId: "org-test",
} as never;

beforeEach(() => {
  fetchSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("patchUserAgent — body + 409 mapping", () => {
  it("sends exactly {name, description, instructions} — no extras", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "ua_1", name: "openit-triage" }),
    });

    await patchUserAgent(creds, "ua_1", {
      name: "openit-triage",
      description: "first-line responder",
      instructions: "be helpful",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/service/useragents/ua_1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual([
      "description",
      "instructions",
      "name",
    ]);
  });

  it("throws OutOfSync on HTTP 409", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => "versions out of sync",
    });

    await expect(
      patchUserAgent(creds, "ua_1", {
        name: "openit-triage",
        description: "",
        instructions: "",
      }),
    ).rejects.toBeInstanceOf(OutOfSync);
  });

  it("throws plain Error on other non-2xx", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });

    await expect(
      patchUserAgent(creds, "ua_1", {
        name: "openit-triage",
        description: "",
        instructions: "",
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("postUserAgent", () => {
  it("POSTs to the collection URL with exactly the V1 body", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "ua_new",
        name: "openit-triage",
        versionDate: "2026-04-30T00:00:00Z",
      }),
    });

    const out = await postUserAgent(creds, {
      name: "openit-triage",
      description: "d",
      instructions: "i",
    });

    expect(out.id).toBe("ua_new");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://app-api.example.com/service/useragents");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "openit-triage",
      description: "d",
      instructions: "i",
    });
  });
});

describe("assembleInstructions", () => {
  it("joins common + cloud with a single blank line", () => {
    expect(assembleInstructions("alpha", "beta")).toBe("alpha\n\nbeta");
  });

  it("trims leading/trailing whitespace per block to avoid double blanks", () => {
    expect(assembleInstructions("alpha\n", "\n  beta  ")).toBe(
      "alpha\n\nbeta",
    );
  });

  it("drops empty blocks from the join", () => {
    expect(assembleInstructions("alpha", "")).toBe("alpha");
    expect(assembleInstructions("", "beta")).toBe("beta");
    expect(assembleInstructions("   ", "  ")).toBe("");
  });
});

describe("instructionsHash", () => {
  it("returns the same hex digest for equivalent input", async () => {
    const a = await instructionsHash("hello world");
    const b = await instructionsHash("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different digest for different input", async () => {
    const a = await instructionsHash("alpha");
    const b = await instructionsHash("beta");
    expect(a).not.toBe(b);
  });
});

describe("releaseUserAgent", () => {
  it("POSTs to /service/useragents/by-id/{id}/releases with no body", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "",
    });
    await releaseUserAgent(creds, "ua_xyz");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://app-api.example.com/service/useragents/by-id/ua_xyz/releases",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("treats 202 (nothing to release) as success", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => "{}",
    });
    await expect(releaseUserAgent(creds, "ua_x")).resolves.toBeUndefined();
  });

  it("throws on non-2xx", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    await expect(releaseUserAgent(creds, "ua_x")).rejects.toThrow(/HTTP 500/);
  });
});

describe("resolveResourceRefs", () => {
  // Per-type GETs hit the skills base URL; proxy GET hits the app
  // base URL. fetchSpy is shared by both branches.
  function setupFetches(opts: {
    kbCollections: Array<{ id: string; name: string; description?: string }>;
    dsCollections: Array<{ id: string; name: string; isStructured?: boolean }>;
    fsCollections: Array<{ id: string; name: string }>;
    proxies: Array<{ id: string; resourceId: string }>;
  }): void {
    fetchSpy.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/datacollection/") {
        const t = u.searchParams.get("type");
        if (t === "knowledge_base") {
          return {
            ok: true,
            status: 200,
            json: async () => opts.kbCollections,
          };
        }
        if (t === "datastore") {
          return { ok: true, status: 200, json: async () => opts.dsCollections };
        }
        if (t === "filestorage") {
          return { ok: true, status: 200, json: async () => opts.fsCollections };
        }
      }
      if (u.pathname === "/service/proxy-endpoints") {
        return { ok: true, status: 200, json: async () => opts.proxies };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    });
  }

  it("returns empty when local has no resources", async () => {
    const out = await resolveResourceRefs(creds, undefined);
    expect(out).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("joins collection + proxy by resourceId; emits wire shape with id + proxyEndpointId", async () => {
    setupFetches({
      kbCollections: [
        { id: "col-kb-1", name: "openit-default", description: "default kb" },
      ],
      dsCollections: [
        { id: "col-ds-1", name: "openit-tickets", isStructured: true },
      ],
      fsCollections: [],
      proxies: [
        { id: "proxy-kb-1", resourceId: "col-kb-1" },
        { id: "proxy-ds-1", resourceId: "col-ds-1" },
      ],
    });

    const out = await resolveResourceRefs(creds, {
      knowledgeBases: [
        { name: "default", canRead: true, canWrite: false, canDelete: false },
      ],
      datastores: [
        { name: "tickets", canRead: true, canWrite: true, canDelete: false },
      ],
    });

    expect(out.knowledgeBases).toEqual([
      {
        id: "col-kb-1",
        name: "openit-default",
        canRead: true,
        canWrite: false,
        canDelete: false,
        proxyEndpointId: "proxy-kb-1",
        description: "default kb",
      },
    ]);
    expect(out.datastores).toEqual([
      {
        id: "col-ds-1",
        name: "openit-tickets",
        canRead: true,
        canWrite: true,
        canDelete: false,
        proxyEndpointId: "proxy-ds-1",
        isStructured: true,
      },
    ]);
  });

  it("skips refs that don't resolve and warns the caller", async () => {
    setupFetches({
      kbCollections: [{ id: "col-kb-1", name: "openit-default" }],
      dsCollections: [],
      fsCollections: [],
      proxies: [{ id: "proxy-kb-1", resourceId: "col-kb-1" }],
    });
    const warnings: string[] = [];

    const out = await resolveResourceRefs(
      creds,
      {
        knowledgeBases: [{ name: "default", canRead: true }],
        datastores: [{ name: "people", canRead: true }],
      },
      (line) => warnings.push(line),
    );

    expect(out.knowledgeBases).toHaveLength(1);
    expect(out.datastores).toEqual([]);
    expect(warnings.some((w) => /datastore.*"people".*not found/.test(w))).toBe(
      true,
    );
  });

  it("skips refs whose collection resolves but no proxy exists", async () => {
    setupFetches({
      kbCollections: [],
      dsCollections: [{ id: "col-ds-1", name: "openit-tickets" }],
      fsCollections: [],
      proxies: [], // no proxy for col-ds-1
    });
    const warnings: string[] = [];

    const out = await resolveResourceRefs(
      creds,
      { datastores: [{ name: "tickets", canRead: true }] },
      (line) => warnings.push(line),
    );

    expect(out.datastores).toEqual([]);
    expect(
      warnings.some((w) => /no proxy endpoint/.test(w)),
    ).toBe(true);
  });

  it("skips refs with no permissions set", async () => {
    setupFetches({
      kbCollections: [{ id: "col-kb-1", name: "openit-default" }],
      dsCollections: [],
      fsCollections: [],
      proxies: [{ id: "proxy-kb-1", resourceId: "col-kb-1" }],
    });
    const warnings: string[] = [];

    const out = await resolveResourceRefs(
      creds,
      {
        knowledgeBases: [
          { name: "default", canRead: false, canWrite: false, canDelete: false },
        ],
      },
      (line) => warnings.push(line),
    );

    expect(out.knowledgeBases).toEqual([]);
    expect(warnings.some((w) => /no permission/.test(w))).toBe(true);
  });
});

describe("getUserAgent / deleteUserAgent", () => {
  it("getUserAgent issues a GET to the item URL", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "ua_1", name: "openit-triage" }),
    });
    const out = await getUserAgent(creds, "ua_1");
    expect(out.id).toBe("ua_1");
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/service/useragents/ua_1");
  });

  it("deleteUserAgent treats 404 as success (idempotent)", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    });
    await expect(deleteUserAgent(creds, "ua_1")).resolves.toBeUndefined();
  });

  it("deleteUserAgent throws on other failures", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    await expect(deleteUserAgent(creds, "ua_1")).rejects.toThrow(/HTTP 500/);
  });
});
