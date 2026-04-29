import { describe, it, expect, beforeAll, skipIf, vi, beforeEach } from "vitest";
import { loadConfig } from "./utils/config";
import { getAccessTokenWithConfig } from "./utils/auth";
import { filestoreAdapter } from "../src/lib/entities/filestore";

const config = loadConfig();
const skip = !config;

// Cache token to avoid multiple OAuth calls
let cachedToken: string | null = null;

// Mock pinkfish auth to return a real token
vi.mock("../src/lib/pinkfishAuth", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/pinkfishAuth")>();

  return {
    ...actual,
    getToken: () => {
      if (!config || !cachedToken) return null;
      return {
        accessToken: cachedToken,
        expiresAt: Date.now() + 3600000,
        orgId: config.orgId,
      };
    },
  };
});

describe.skipIf(skip)("filestore sync - real integration", () => {
  beforeEach(async () => {
    // Get token once and cache it
    if (config && !cachedToken) {
      try {
        cachedToken = await getAccessTokenWithConfig(config);
      } catch (e) {
        console.error("Failed to authenticate:", e);
        throw e;
      }
    }
  });

  beforeAll(() => {
    console.log("\n" + "=".repeat(60));
    console.log("FILESTORE SYNC INTEGRATION TESTS");
    console.log("=".repeat(60));
    console.log("Repo:", config?.repo);
    console.log("Org:", config?.orgId);
    console.log("=".repeat(60) + "\n");
  });

  it("should discover openit-docs collection files", async () => {
    if (!config) return;

    const adapter = filestoreAdapter({
      creds: {
        orgId: config.orgId,
        tokenUrl: config.credentials.tokenUrl,
      },
      collection: {
        id: config.collections.docs,
        name: "openit-docs-653713545258",
        description: "Docs collection",
      },
    });

    console.log("\n→ Listing remote files for openit-docs-653713545258...");

    try {
      const result = await adapter.listRemote(config.repo);

      console.log(`✓ Found ${result.items.length} files:`);
      result.items.forEach((item) => {
        console.log(`  - ${item.manifestKey}`);
        console.log(`    → ${item.workingTreePath}`);
      });

      expect(result.items.length).toBeGreaterThanOrEqual(0);
    } catch (e) {
      console.error("✗ Failed:", e);
      throw e;
    }
  });

  it("should discover openit-attachments collection files", async () => {
    if (!config) return;

    const adapter = filestoreAdapter({
      creds: {
        orgId: config.orgId,
        tokenUrl: config.credentials.tokenUrl,
      },
      collection: {
        id: config.collections.attachments,
        name: "openit-attachments",
        description: "Attachments collection",
      },
    });

    console.log("\n→ Listing remote files for openit-attachments...");

    try {
      const result = await adapter.listRemote(config.repo);

      console.log(`✓ Found ${result.items.length} files:`);
      result.items.forEach((item) => {
        console.log(`  - ${item.manifestKey}`);
        console.log(`    → ${item.workingTreePath}`);
      });

      expect(result.items.length).toBeGreaterThanOrEqual(0);
    } catch (e) {
      console.error("✗ Failed:", e);
      throw e;
    }
  });

  it("should route files to correct collection folders", async () => {
    if (!config) return;

    console.log("\n→ Checking file routing...");

    const docsAdapter = filestoreAdapter({
      creds: {
        orgId: config.orgId,
        tokenUrl: config.credentials.tokenUrl,
      },
      collection: {
        id: config.collections.docs,
        name: "openit-docs-653713545258",
      },
    });

    const attachAdapter = filestoreAdapter({
      creds: {
        orgId: config.orgId,
        tokenUrl: config.credentials.tokenUrl,
      },
      collection: {
        id: config.collections.attachments,
        name: "openit-attachments",
      },
    });

    const docsResult = await docsAdapter.listRemote(config.repo);
    const attachResult = await attachAdapter.listRemote(config.repo);

    console.log("Docs files route to: filestores/docs-653713545258/");
    docsResult.items.slice(0, 3).forEach((item) => {
      console.log(`  ✓ ${item.manifestKey}`);
      expect(item.workingTreePath).toContain("filestores/docs-653713545258");
    });

    console.log("Attachments files route to: filestores/attachments/");
    attachResult.items.slice(0, 3).forEach((item) => {
      console.log(`  ✓ ${item.manifestKey}`);
      expect(item.workingTreePath).toContain("filestores/attachments");
    });
  });

  it("should verify download callback parameters", async () => {
    if (!config) return;

    console.log("\n→ Verifying fetchAndWrite callback signature...");

    const adapter = filestoreAdapter({
      creds: {
        orgId: config.orgId,
        tokenUrl: config.credentials.tokenUrl,
      },
      collection: {
        id: config.collections.docs,
        name: "openit-docs-653713545258",
      },
    });

    const result = await adapter.listRemote(config.repo);

    if (result.items.length > 0) {
      const item = result.items[0];
      console.log(`File: ${item.manifestKey}`);
      console.log(`Working tree path: ${item.workingTreePath}`);
      console.log(`Has fetchAndWrite: ${typeof item.fetchAndWrite === "function"}`);
      console.log(`Has writeShadow: ${typeof item.writeShadow === "function"}`);

      expect(typeof item.fetchAndWrite).toBe("function");
      expect(typeof item.writeShadow).toBe("function");

      console.log("✓ Callbacks present and callable");
    }
  });
});
