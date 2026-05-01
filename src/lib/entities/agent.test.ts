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
  derivedUrls: () => ({ appBaseUrl: "https://app-api.example.com" }),
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
