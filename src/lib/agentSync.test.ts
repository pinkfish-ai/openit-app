// Triage-agent bootstrap tests. Mocks the underlying REST helpers so
// we can assert the create-when-missing / no-op-when-present
// semantics without spinning up auth or a real Pinkfish backend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./entities/agent", () => ({
  resolveProjectAgents: vi.fn(),
  agentAdapter: vi.fn(),
}));

vi.mock("./pinkfishAuth", () => ({
  derivedUrls: vi.fn(() => ({
    appBaseUrl: "https://app-api.dev20.pinkfish.dev",
    skillsBaseUrl: "https://skills-stage.pinkfish.ai",
    mcpBaseUrl: "https://mcp.dev20.pinkfish.dev",
    accountUrl: "https://mcp.dev20.pinkfish.dev/pf-account",
    connectionsUrl: "https://proxy-stage.pinkfish.ai/manage/user-connections?format=light",
    tokenUrl: "https://app-api.dev20.pinkfish.dev/oauth/token",
  })),
  getToken: vi.fn(() => ({ accessToken: "fake-token", expiresAt: Date.now() + 60_000, orgId: "ORG" })),
}));

const fetchMock = vi.fn();
vi.mock("../api/fetchAdapter", () => ({
  makeSkillsFetch: vi.fn(() => fetchMock),
}));

import { resolveProjectAgents } from "./entities/agent";
import {
  _resetTriageEnsuredForTesting,
  resolveOrCreateTriageAgent,
} from "./agentSync";

const CREDS = {
  clientId: "client",
  clientSecret: "secret",
  orgId: "ORG",
  tokenUrl: "https://app-api.dev20.pinkfish.dev/oauth/token",
};

beforeEach(() => {
  _resetTriageEnsuredForTesting();
  vi.mocked(resolveProjectAgents).mockReset();
  fetchMock.mockReset();
});

afterEach(() => {
  _resetTriageEnsuredForTesting();
});

describe("resolveOrCreateTriageAgent", () => {
  it("creates the triage agent when none exists", async () => {
    vi.mocked(resolveProjectAgents).mockResolvedValueOnce([]); // empty — no triage
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "agent-123",
        name: "openit-triage-ORG",
        description: "Triage IT tickets",
        selectedModel: "sonnet",
        updatedAt: "2026-04-26T10:00:00Z",
      }),
    });

    const onLog = vi.fn();
    const row = await resolveOrCreateTriageAgent(CREDS, onLog);

    expect(row?.id).toBe("agent-123");
    expect(row?.name).toBe("openit-triage-ORG");
    expect(fetchMock).toHaveBeenCalledOnce();

    // POST went to /service/useragents with the triage payload.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://app-api.dev20.pinkfish.dev/service/useragents");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.name).toBe("openit-triage-ORG");
    expect(body.description).toContain("Triage IT tickets");
    expect(body.instructions).toContain("openit-triage");
    expect(body.instructions).toContain("openit-tickets-ORG");
    expect(body.instructions).toContain("knowledge-base_ask");
    expect(body.selectedModel).toBe("sonnet");
    expect(body.isShared).toBe(false);
    expect(body.servers).toEqual([]);
    expect(body.knowledgeBases).toEqual([]);

    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining("created triage agent openit-triage-ORG"),
    );
  });

  it("is a no-op when the triage agent already exists", async () => {
    vi.mocked(resolveProjectAgents).mockResolvedValueOnce([
      {
        id: "existing-id",
        name: "openit-triage-ORG",
        description: "Triage IT tickets",
        selectedModel: "sonnet",
      },
    ]);

    const row = await resolveOrCreateTriageAgent(CREDS);

    expect(row?.id).toBe("existing-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is idempotent across repeat calls (cached after first success)", async () => {
    vi.mocked(resolveProjectAgents).mockResolvedValueOnce([]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ id: "agent-1", name: "openit-triage-ORG" }),
    });

    await resolveOrCreateTriageAgent(CREDS);
    // Second call should NOT re-list, NOT re-POST.
    await resolveOrCreateTriageAgent(CREDS);
    await resolveOrCreateTriageAgent(CREDS);

    expect(resolveProjectAgents).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("dedupes concurrent calls — both await the same in-flight POST", async () => {
    vi.mocked(resolveProjectAgents).mockResolvedValueOnce([]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({ id: "agent-1", name: "openit-triage-ORG" }),
    });

    const [a, b] = await Promise.all([
      resolveOrCreateTriageAgent(CREDS),
      resolveOrCreateTriageAgent(CREDS),
    ]);
    expect(a?.id).toBe("agent-1");
    expect(b?.id).toBe("agent-1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("logs and returns null when the create fails (doesn't throw)", async () => {
    vi.mocked(resolveProjectAgents).mockResolvedValueOnce([]);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "internal error",
      json: async () => ({}),
    });

    const onLog = vi.fn();
    const row = await resolveOrCreateTriageAgent(CREDS, onLog);

    expect(row).toBeNull();
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining("triage agent create failed"),
    );
  });

  it("logs and returns null when listing fails (graceful)", async () => {
    vi.mocked(resolveProjectAgents).mockRejectedValueOnce(new Error("network"));

    const onLog = vi.fn();
    const row = await resolveOrCreateTriageAgent(CREDS, onLog);

    expect(row).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining("triage agent: list failed"),
    );
  });
});
