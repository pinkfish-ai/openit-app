import { describe, it, expect, beforeEach, vi } from "vitest";
import { filestoreAdapter } from "./filestore";
import * as api from "../api";
import * as syncEngine from "../syncEngine";

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
  }),
  derivedUrls: () => ({
    skillsBaseUrl: "https://test.api",
  }),
}));

describe("filestoreAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should route files to collection-specific folders", async () => {
    // Setup adapter for openit-docs-653713545258
    const adapter = filestoreAdapter({
      creds: {
        orgId: "test-org",
        tokenUrl: "https://test.tokenurl",
      },
      collection: {
        id: "doc-collection-id",
        name: "openit-docs-653713545258",
        description: "Test docs",
      },
    });

    // Mock remote list
    const mockRemoteFile = {
      filename: "_claudesetup.txt",
      signed_url: "https://download.url/file",
      updated_at: "2026-04-29T00:00:00Z",
    };

    vi.mocked(api.kbListRemote).mockResolvedValue([mockRemoteFile]);

    // Call listRemote
    const result = await adapter.listRemote("test-repo");

    // Verify correct routing
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.manifestKey).toBe("_claudesetup.txt");
    expect(item.workingTreePath).toBe("filestores/docs-653713545258/_claudesetup.txt");

    // Test that fetchAndWrite is a function
    expect(typeof item.fetchAndWrite).toBe("function");
  });

  it("should create directory before downloading", async () => {
    const adapter = filestoreAdapter({
      creds: {
        orgId: "test-org",
        tokenUrl: "https://test.tokenurl",
      },
      collection: {
        id: "attach-collection-id",
        name: "openit-attachments",
        description: "Test attachments",
      },
    });

    const mockRemoteFile = {
      filename: "document.pdf",
      signed_url: "https://download.url/document.pdf",
      updated_at: "2026-04-29T00:00:00Z",
    };

    vi.mocked(api.kbListRemote).mockResolvedValue([mockRemoteFile]);

    const result = await adapter.listRemote("test-repo");
    const item = result.items[0];

    // Simulate fetchAndWrite being called
    vi.mocked(api.entityWriteFile).mockResolvedValue(undefined);
    vi.mocked(api.entityDeleteFile).mockResolvedValue(undefined);
    vi.mocked(api.fsStoreDownloadToLocal).mockResolvedValue(undefined);

    // Call fetchAndWrite
    await item.fetchAndWrite("test-repo");

    // Verify directory creation was attempted
    expect(api.entityWriteFile).toHaveBeenCalledWith(
      "test-repo",
      "filestores/attachments",
      ".placeholder",
      ""
    );

    // Verify placeholder was deleted
    expect(api.entityDeleteFile).toHaveBeenCalledWith(
      "test-repo",
      "filestores/attachments",
      ".placeholder"
    );

    // Verify download was called with correct params
    expect(api.fsStoreDownloadToLocal).toHaveBeenCalledWith(
      "test-repo",
      "document.pdf",
      "https://download.url/document.pdf",
      "filestores/attachments"
    );
  });

  it("should handle errors gracefully during directory creation", async () => {
    const adapter = filestoreAdapter({
      creds: {
        orgId: "test-org",
        tokenUrl: "https://test.tokenurl",
      },
      collection: {
        id: "lib-collection-id",
        name: "openit-library",
        description: "Test library",
      },
    });

    const mockRemoteFile = {
      filename: "book.md",
      signed_url: "https://download.url/book.md",
      updated_at: "2026-04-29T00:00:00Z",
    };

    vi.mocked(api.kbListRemote).mockResolvedValue([mockRemoteFile]);

    const result = await adapter.listRemote("test-repo");
    const item = result.items[0];

    // Make directory creation fail
    vi.mocked(api.entityWriteFile).mockRejectedValue(
      new Error("Permission denied")
    );
    vi.mocked(api.fsStoreDownloadToLocal).mockResolvedValue(undefined);

    // fetchAndWrite should continue despite directory creation error
    await expect(item.fetchAndWrite("test-repo")).resolves.not.toThrow();

    // Download should still be attempted
    expect(api.fsStoreDownloadToLocal).toHaveBeenCalled();
  });

  it("should route multiple collections to different folders", async () => {
    // Create adapters for different collections
    const docAdapter = filestoreAdapter({
      creds: {
        orgId: "test-org",
        tokenUrl: "https://test.tokenurl",
      },
      collection: {
        id: "doc-id",
        name: "openit-docs-123",
        description: "Docs",
      },
    });

    const attachAdapter = filestoreAdapter({
      creds: {
        orgId: "test-org",
        tokenUrl: "https://test.tokenurl",
      },
      collection: {
        id: "attach-id",
        name: "openit-attachments",
        description: "Attachments",
      },
    });

    // Mock returns
    vi.mocked(api.kbListRemote)
      .mockResolvedValueOnce([
        {
          filename: "guide.md",
          signed_url: "https://url/guide.md",
          updated_at: "2026-04-29T00:00:00Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          filename: "image.png",
          signed_url: "https://url/image.png",
          updated_at: "2026-04-29T00:00:00Z",
        },
      ]);

    const docResult = await docAdapter.listRemote("test-repo");
    const attachResult = await attachAdapter.listRemote("test-repo");

    // Verify routing
    expect(docResult.items[0].workingTreePath).toBe("filestores/docs-123/guide.md");
    expect(attachResult.items[0].workingTreePath).toBe("filestores/attachments/image.png");
  });
});
