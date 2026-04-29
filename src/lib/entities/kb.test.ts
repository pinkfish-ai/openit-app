// KB adapter unit tests — Phase 2 of V2 sync (PIN-5775). Mirror of
// entities/filestore.test.ts, scoped to the per-collection routing the
// new KB adapter performs (display-name → `knowledge-bases/<name>/`).

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { kbAdapter, kbAggregatePrefix } from "./kb";

vi.mock("../api", () => ({
  entityDeleteFile: vi.fn(),
  entityListLocal: vi.fn().mockResolvedValue([]),
  entityWriteFile: vi.fn(),
  kbDownloadToLocal: vi.fn(),
  kbListRemote: vi.fn(),
  fsStoreStateLoad: vi.fn().mockResolvedValue({
    collection_id: "",
    collection_name: "",
    files: {},
  }),
  fsStoreStateSave: vi.fn(),
  kbStateLoad: vi.fn().mockResolvedValue({
    collection_id: "",
    collection_name: "",
    files: {},
  }),
  kbStateSave: vi.fn(),
}));

vi.mock("../pinkfishAuth", () => ({
  getToken: () => ({
    accessToken: "test-token",
    expiresAt: Date.now() + 3_600_000,
    orgId: "test-org",
  }),
  derivedUrls: () => ({
    skillsBaseUrl: "https://test.api",
  }),
}));

const CREDS = {
  orgId: "test-org",
  tokenUrl: "https://test.tokenurl",
  clientId: "test-client",
  clientSecret: "test-secret",
};

function remoteFile(filename: string, url = "https://download.url"): api.KbRemoteFile {
  return {
    id: "f-id",
    filename,
    signed_url: url,
    updated_at: "2026-04-29T00:00:00Z",
    file_size: 100,
    mime_type: "text/plain",
  } as api.KbRemoteFile;
}

describe("kbAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes remote items into the collection's display-name subfolder", async () => {
    const adapter = kbAdapter({
      creds: CREDS,
      collection: { id: "kb-default-id", name: "openit-default" },
    });
    vi.mocked(api.kbListRemote).mockResolvedValue([remoteFile("readme.md")]);

    const result = await adapter.listRemote("test-repo");

    expect(result.items).toHaveLength(1);
    expect(result.items[0].manifestKey).toBe("readme.md");
    expect(result.items[0].workingTreePath).toBe(
      "knowledge-bases/default/readme.md",
    );
  });

  it("routes a custom-named collection into its own subfolder", async () => {
    const adapter = kbAdapter({
      creds: CREDS,
      collection: { id: "kb-runbooks-id", name: "openit-runbooks" },
    });
    vi.mocked(api.kbListRemote).mockResolvedValue([remoteFile("vpn-reset.md")]);

    const result = await adapter.listRemote("test-repo");

    expect(result.items[0].workingTreePath).toBe(
      "knowledge-bases/runbooks/vpn-reset.md",
    );
  });

  it("uses a per-collection prefix so the conflict bus never aggregates across collections", () => {
    const a = kbAdapter({
      creds: CREDS,
      collection: { id: "kb-1", name: "openit-default" },
    });
    const b = kbAdapter({
      creds: CREDS,
      collection: { id: "kb-2", name: "openit-runbooks" },
    });
    expect(a.prefix).toBe("knowledge-bases/default");
    expect(b.prefix).toBe("knowledge-bases/runbooks");
    expect(kbAggregatePrefix({ id: "kb-1", name: "openit-default" })).toBe(
      "knowledge-bases/default",
    );
  });

  it("download passes the collection's subdir so kb_download_to_local writes to the right folder", async () => {
    const adapter = kbAdapter({
      creds: CREDS,
      collection: { id: "kb-faqs-id", name: "openit-faqs" },
    });
    vi.mocked(api.kbListRemote).mockResolvedValue([remoteFile("how-to.md")]);

    const result = await adapter.listRemote("test-repo");
    await result.items[0].fetchAndWrite("test-repo");

    expect(api.kbDownloadToLocal).toHaveBeenCalledWith(
      "test-repo",
      "how-to.md",
      "https://download.url",
      "knowledge-bases/faqs",
    );
  });

  it("server-shadow write also routes through the collection subdir", async () => {
    const adapter = kbAdapter({
      creds: CREDS,
      collection: { id: "kb-default-id", name: "openit-default" },
    });
    vi.mocked(api.kbListRemote).mockResolvedValue([remoteFile("conflict.md")]);

    const result = await adapter.listRemote("test-repo");
    await result.items[0].writeShadow("test-repo");

    expect(api.kbDownloadToLocal).toHaveBeenCalledWith(
      "test-repo",
      "conflict.server.md",
      "https://download.url",
      "knowledge-bases/default",
    );
  });

  it("listLocal reads the collection-specific subdir", async () => {
    const adapter = kbAdapter({
      creds: CREDS,
      collection: { id: "kb-runbooks-id", name: "openit-runbooks" },
    });
    vi.mocked(api.entityListLocal).mockResolvedValue([
      { filename: "x.md", mtime_ms: 1, size: 10 },
    ]);

    const local = await adapter.listLocal("test-repo");

    expect(api.entityListLocal).toHaveBeenCalledWith(
      "test-repo",
      "knowledge-bases/runbooks",
    );
    expect(local[0].workingTreePath).toBe("knowledge-bases/runbooks/x.md");
  });
});
