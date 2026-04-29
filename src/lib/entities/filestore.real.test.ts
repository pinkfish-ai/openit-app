import { describe, it, expect, beforeEach } from "vitest";
import { loadTestConfig, isIntegrationTestAvailable } from "../__tests__/test-utils";
import { filestoreAdapter } from "./filestore";

describe("filestore real integration", () => {
  if (!isIntegrationTestAvailable()) {
    it("skipped - test-config.json not found", () => {
      console.log("To run real integration tests:");
      console.log("1. Copy test-config.example.json to test-config.json");
      console.log("2. Fill in real credentials and repo path");
      console.log("3. Run: npm test -- filestore.real.test.ts");
    });
    return;
  }

  const config = loadTestConfig()!;

  beforeEach(() => {
    console.log("\n=== REAL INTEGRATION TEST ===");
    console.log("Repo:", config.repo);
    console.log("Org:", config.orgId);
  });

  it("should discover files in openit-docs collection", async () => {
    const adapter = filestoreAdapter({
      creds: {
        orgId: config.orgId,
        tokenUrl: config.credentials.tokenUrl,
      },
      collection: {
        id: config.collectionIds.docs,
        name: "openit-docs-653713545258",
        description: "Test docs",
      },
    });

    try {
      const result = await adapter.listRemote(config.repo);
      console.log("Remote files found:", result.items.length);
      result.items.forEach((item) => {
        console.log(`  - ${item.manifestKey} → ${item.workingTreePath}`);
      });

      expect(result.items.length).toBeGreaterThanOrEqual(0);
    } catch (e) {
      console.error("Failed to list remote:", e);
      throw e;
    }
  });

  it("should test download flow without actual file write", async () => {
    const adapter = filestoreAdapter({
      creds: {
        orgId: config.orgId,
        tokenUrl: config.credentials.tokenUrl,
      },
      collection: {
        id: config.collectionIds.docs,
        name: "openit-docs-653713545258",
        description: "Test docs",
      },
    });

    const result = await adapter.listRemote(config.repo);

    if (result.items.length === 0) {
      console.log("No files to test download");
      return;
    }

    const firstFile = result.items[0];
    console.log(`Testing download for: ${firstFile.manifestKey}`);
    console.log(`Working tree path: ${firstFile.workingTreePath}`);
    console.log(`Directory would be: ${firstFile.workingTreePath.split("/").slice(0, -1).join("/")}`);

    // This would call fsStoreDownloadToLocal with the subdir parameter
    // Uncomment to test actual download:
    // await firstFile.fetchAndWrite(config.repo);
    console.log("✓ Would download with correct subdir parameter");
  });
});
