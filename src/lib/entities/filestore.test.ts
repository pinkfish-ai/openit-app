import { describe, it, expect, beforeEach, vi } from "vitest";
import { filestoreAdapter } from "./filestore";
import * as api from "../api";

// Mock the API module
vi.mock("../api", () => ({
  entityDeleteFile: vi.fn(),
  fsStoreDownloadToLocal: vi.fn(),
  fsStoreListLocal: vi.fn(),
  entityListLocal: vi.fn().mockResolvedValue([]),
  kbListRemote: vi.fn(),
  entityWriteFile: vi.fn(),
}));

// Mock pinkfish auth
vi.mock("../pinkfishAuth", () => ({
  getToken: () => ({
    accessToken: "test-token",
    expiresAt: Date.now() + 3600000,
    orgId: "test-org",
  }),
  derivedUrls: () => ({
    skillsBaseUrl: "https://test.api",
  }),
}));

const TEST_CREDS = {
  orgId: "test-org",
  tokenUrl: "https://test.tokenurl",
  clientId: "test-client",
  clientSecret: "test-secret",
};

function makeRemoteFile(overrides: Partial<{
  filename: string;
  signed_url: string;
  updated_at: string;
}>): api.KbRemoteFile {
  return {
    id: "test-id",
    filename: overrides.filename ?? "test.txt",
    signed_url: overrides.signed_url ?? "https://test.url",
    updated_at: overrides.updated_at ?? "2026-04-29T00:00:00Z",
    file_size: 100,
    mime_type: "text/plain",
  } as api.KbRemoteFile;
}

describe("filestoreAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should route files to collection-specific folders", async () => {
    const adapter = filestoreAdapter({
      creds: TEST_CREDS,
      collection: {
        id: "doc-collection-id",
        name: "openit-docs-653713545258",
        description: "Test docs",
      },
    });

    vi.mocked(api.kbListRemote).mockResolvedValue([
      makeRemoteFile({ filename: "_claudesetup.txt" }),
    ]);

    const result = await adapter.listRemote("test-repo");

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.manifestKey).toBe("_claudesetup.txt");
    expect(item.workingTreePath).toBe(
      "filestores/docs-653713545258/_claudesetup.txt",
    );
    expect(typeof item.fetchAndWrite).toBe("function");
  });

  it("should create directory before downloading", async () => {
    const adapter = filestoreAdapter({
      creds: TEST_CREDS,
      collection: {
        id: "attach-collection-id",
        name: "openit-attachments",
        description: "Test attachments",
      },
    });

    vi.mocked(api.kbListRemote).mockResolvedValue([
      makeRemoteFile({
        filename: "document.pdf",
        signed_url: "https://download.url/document.pdf",
      }),
    ]);

    const result = await adapter.listRemote("test-repo");
    const item = result.items[0];

    vi.mocked(api.entityWriteFile).mockResolvedValue(undefined);
    vi.mocked(api.entityDeleteFile).mockResolvedValue(undefined);
    vi.mocked(api.fsStoreDownloadToLocal).mockResolvedValue(undefined);

    await item.fetchAndWrite("test-repo");

    // Directory creation: write placeholder then delete it.
    expect(api.entityWriteFile).toHaveBeenCalledWith(
      "test-repo",
      "filestores/attachments",
      ".placeholder",
      "",
    );
    expect(api.entityDeleteFile).toHaveBeenCalledWith(
      "test-repo",
      "filestores/attachments",
      ".placeholder",
    );

    // Download with subdir parameter so backend writes to the right folder.
    expect(api.fsStoreDownloadToLocal).toHaveBeenCalledWith(
      "test-repo",
      "document.pdf",
      "https://download.url/document.pdf",
      "filestores/attachments",
    );
  });

  it("should still attempt download if directory creation fails", async () => {
    const adapter = filestoreAdapter({
      creds: TEST_CREDS,
      collection: {
        id: "lib-collection-id",
        name: "openit-library",
        description: "Test library",
      },
    });

    vi.mocked(api.kbListRemote).mockResolvedValue([
      makeRemoteFile({ filename: "book.md" }),
    ]);

    const result = await adapter.listRemote("test-repo");
    const item = result.items[0];

    vi.mocked(api.entityWriteFile).mockRejectedValue(
      new Error("Permission denied"),
    );
    vi.mocked(api.fsStoreDownloadToLocal).mockResolvedValue(undefined);

    await expect(item.fetchAndWrite("test-repo")).resolves.not.toThrow();
    expect(api.fsStoreDownloadToLocal).toHaveBeenCalled();
  });

  it("should route multiple collections to different folders", async () => {
    const docAdapter = filestoreAdapter({
      creds: TEST_CREDS,
      collection: { id: "doc-id", name: "openit-docs-123" },
    });
    const attachAdapter = filestoreAdapter({
      creds: TEST_CREDS,
      collection: { id: "attach-id", name: "openit-attachments" },
    });

    vi.mocked(api.kbListRemote)
      .mockResolvedValueOnce([makeRemoteFile({ filename: "guide.md" })])
      .mockResolvedValueOnce([makeRemoteFile({ filename: "image.png" })]);

    const docsResult = await docAdapter.listRemote("test-repo");
    const attachResult = await attachAdapter.listRemote("test-repo");

    expect(docsResult.items[0].workingTreePath).toBe(
      "filestores/docs-123/guide.md",
    );
    expect(attachResult.items[0].workingTreePath).toBe(
      "filestores/attachments/image.png",
    );
  });

  it("should list local files from the collection's own subdir", async () => {
    const adapter = filestoreAdapter({
      creds: TEST_CREDS,
      collection: { id: "docs-id", name: "openit-docs-456" },
    });

    vi.mocked(api.entityListLocal).mockResolvedValue([
      { filename: "file1.txt", mtime_ms: 1000, size: 10 },
      { filename: "file2.txt", mtime_ms: 2000, size: 20 },
    ]);

    const local = await adapter.listLocal("test-repo");

    // Critical: list with the collection's actual subdir, not the
    // hardcoded library dir. Pre-fix, every collection saw library
    // files and the engine thought files were already on disk.
    expect(api.entityListLocal).toHaveBeenCalledWith(
      "test-repo",
      "filestores/docs-456",
    );
    expect(local).toHaveLength(2);
    expect(local[0].workingTreePath).toBe("filestores/docs-456/file1.txt");
    expect(local[1].workingTreePath).toBe("filestores/docs-456/file2.txt");
  });
});
