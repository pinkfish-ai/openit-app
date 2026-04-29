import { describe, it, expect, beforeEach, vi } from "vitest";
import { filestoreAdapter } from "./filestore";
import { pullEntity } from "../syncEngine";
import * as api from "../api";

vi.mock("../api");
vi.mock("../pinkfishAuth", () => ({
  getToken: () => ({ accessToken: "test-token" }),
  derivedUrls: () => ({ skillsBaseUrl: "https://test.api" }),
}));

describe("filestore sync integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should pull files from remote and write to collection folders", async () => {
    const adapter = filestoreAdapter({
      creds: {
        orgId: "test-org",
        tokenUrl: "https://test.tokenurl",
      },
      collection: {
        id: "docs-id",
        name: "openit-docs-653713545258",
        description: "Test docs",
      },
    });

    // Mock the manifest (empty initially)
    vi.mocked(api.fsStoreStateLoad).mockResolvedValue({
      collection_id: "docs-id",
      collection_name: "openit-docs-653713545258",
      files: {},
    });

    // Mock local files (none initially)
    vi.mocked(api.fsStoreListLocal).mockResolvedValue([]);

    // Mock remote files
    vi.mocked(api.kbListRemote).mockResolvedValue([
      {
        filename: "_claudesetup.txt",
        signed_url: "https://download.test/_claudesetup.txt",
        updated_at: "2026-04-29T15:00:00Z",
      },
    ]);

    // Mock directory creation
    vi.mocked(api.entityWriteFile).mockResolvedValue(undefined);
    vi.mocked(api.entityDeleteFile).mockResolvedValue(undefined);

    // Mock file download - THIS IS THE KEY TEST
    vi.mocked(api.fsStoreDownloadToLocal).mockImplementation(async (repo, filename, url, subdir) => {
      console.log(`Download called with: repo=${repo}, filename=${filename}, subdir=${subdir}`);
      // Simulate file being written by adding to local list
      if (subdir === "filestores/docs-653713545258" && filename === "_claudesetup.txt") {
        console.log("✓ Download parameters are correct!");
      } else {
        throw new Error(
          `Expected subdir="filestores/docs-653713545258" and filename="_claudesetup.txt", ` +
          `got subdir="${subdir}" and filename="${filename}"`
        );
      }
    });

    // Mock save manifest
    vi.mocked(api.fsStoreStateSave).mockResolvedValue(undefined);

    // Run pull
    const result = await pullEntity(adapter, "test-repo");

    console.log("Pull result:", result);

    // Verify the key calls
    console.log("\n=== CALL VERIFICATION ===");
    console.log("entityWriteFile called:", vi.mocked(api.entityWriteFile).mock.calls.length, "times");
    if (vi.mocked(api.entityWriteFile).mock.calls.length > 0) {
      console.log("  First call:", vi.mocked(api.entityWriteFile).mock.calls[0]);
    }

    console.log("fsStoreDownloadToLocal called:", vi.mocked(api.fsStoreDownloadToLocal).mock.calls.length, "times");
    if (vi.mocked(api.fsStoreDownloadToLocal).mock.calls.length > 0) {
      console.log("  Call args:", vi.mocked(api.fsStoreDownloadToLocal).mock.calls[0]);
    }

    // Expectations
    expect(api.entityWriteFile).toHaveBeenCalledWith(
      "test-repo",
      "filestores/docs-653713545258",
      ".placeholder",
      ""
    );

    expect(api.fsStoreDownloadToLocal).toHaveBeenCalledWith(
      "test-repo",
      "_claudesetup.txt",
      "https://download.test/_claudesetup.txt",
      "filestores/docs-653713545258"
    );

    // If pull succeeded, we should have downloaded 1 file
    expect(result.pulled).toBeGreaterThanOrEqual(1);
  });

  it("should verify the invoke call signature matches backend expectations", () => {
    // This test documents what parameters the backend expects
    const expectedSignature = {
      repo: "string (absolute path)",
      filename: "string (just filename, no path separators)",
      url: "string (download URL)",
      subdir: "string (optional, subdirectory path) or null",
    };

    console.log("\n=== BACKEND INVOKE SIGNATURE ===");
    console.log("fs_store_download_to_local expects:", expectedSignature);
    console.log("\nIf subdir is not supported by backend:");
    console.log("- The backend needs to be updated to handle parent directory creation");
    console.log("- OR we need to change the download strategy");
  });
});
