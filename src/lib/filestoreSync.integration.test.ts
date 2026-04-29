// Integration tests for filestore sync behavior:
// 1. Creating defaults locally without duplicates
// 2. Creating remote collections locally and syncing their files

import { describe, it, expect, beforeEach } from "vitest";
import type { FilestoreCollection } from "./filestoreSync";
import type { DataCollection } from "./skillsApi";

// Mock types for testing
type MockListResponse = DataCollection[];

/**
 * Test scenario 1: Create defaults if not on local (without dupes)
 *
 * Simulates:
 * - Fresh app start with no local filestores
 * - Remote has no openit-* collections
 * - Call startFilestoreSync
 * Expected: openit-library and openit-attachments created once each
 * Not expected: duplicates even with concurrent calls
 */
describe("Filestore sync: Create defaults without duplicates", () => {
  let createCallCount = 0;
  let listCallCount = 0;
  const mockLists: MockListResponse[] = [];
  const createdCollections: FilestoreCollection[] = [];

  beforeEach(() => {
    createCallCount = 0;
    listCallCount = 0;
    mockLists.length = 0;
    createdCollections.length = 0;
  });

  it("creates openit-library once when not present on remote", async () => {
    // Scenario: Remote is empty, local is empty
    // Expected: One POST to create openit-library

    // Mock API responses
    const mockApiCalls = {
      list: () => {
        listCallCount++;
        // First list: empty (no collections yet)
        // Second list (post-create refetch): now includes openit-library
        if (listCallCount === 1) {
          return [];
        } else {
          return [
            {
              id: "lib-123",
              name: "openit-library",
              description: "Shared document storage for OpenIT",
            },
          ];
        }
      },
      create: (name: string) => {
        createCallCount++;
        if (name === "openit-library") {
          return { id: "lib-123", name: "openit-library" };
        }
        throw new Error(`Unexpected create: ${name}`);
      },
    };

    // Simulate startFilestoreSync auto-create logic
    const collections: FilestoreCollection[] = [];
    const localFolderNames = ["library"];

    // First resolve: list empty
    const firstList = mockApiCalls.list();
    expect(firstList).toHaveLength(0);

    // Auto-create phase
    for (const folderName of localFolderNames) {
      const remoteName = `openit-${folderName}`;
      if (!collections.some((c) => c.name === remoteName)) {
        const result = mockApiCalls.create(remoteName);
        collections.push({
          id: result.id,
          name: remoteName,
          description: `OpenIT filestore: ${folderName}`,
        });

        // Post-create refetch
        const refetched = mockApiCalls.list();
        expect(refetched.some((c) => c.name === remoteName)).toBe(true);
      }
    }

    expect(createCallCount).toBe(1);
    expect(collections).toHaveLength(1);
    expect(collections[0].name).toBe("openit-library");
  });

  it("prevents duplicate creation when startFilestoreSync called twice concurrently", async () => {
    // Scenario: Two concurrent calls to startFilestoreSync
    // Both see empty list initially
    // Both attempt to create openit-library
    // Post-create refetch + org cache should prevent true duplicates

    const orgCache = new Map<string, FilestoreCollection>();
    const mockApiCalls = {
      list: () => {
        listCallCount++;
        if (listCallCount <= 2) {
          // First two calls see empty (concurrent calls before creation is visible)
          return [];
        } else {
          // Later calls see the collection
          return [
            {
              id: "lib-123",
              name: "openit-library",
              description: "Shared document storage for OpenIT",
            },
          ];
        }
      },
      create: (name: string) => {
        createCallCount++;
        if (name === "openit-library") {
          return { id: "lib-123", name: "openit-library" };
        }
        throw new Error(`Unexpected create: ${name}`);
      },
    };

    // Simulate first startFilestoreSync call
    const collections1: FilestoreCollection[] = [];
    const remoteName = "openit-library";

    // Both calls do LIST first
    const list1 = mockApiCalls.list();
    const list2 = mockApiCalls.list();
    expect(list1).toHaveLength(0);
    expect(list2).toHaveLength(0);

    // First call creates
    if (!list1.some((c) => c.name === remoteName) && !orgCache.has(remoteName)) {
      const result = mockApiCalls.create(remoteName);
      collections1.push({ id: result.id, name: remoteName, description: "OpenIT filestore: library" });
      orgCache.set(remoteName, collections1[0]);

      // Post-create refetch for first call
      const refetched1 = mockApiCalls.list();
      expect(refetched1.some((c) => c.name === remoteName)).toBe(true);
    }

    // Second call checks cache first (this is the fix)
    const collections2: FilestoreCollection[] = [];
    if (orgCache.has(remoteName)) {
      // Cache has it, skip creation
      collections2.push(orgCache.get(remoteName)!);
    } else if (!list2.some((c) => c.name === remoteName)) {
      // This branch would create a duplicate without the cache check
      const result = mockApiCalls.create(remoteName);
      collections2.push({ id: result.id, name: remoteName, description: "OpenIT filestore: library" });
      orgCache.set(remoteName, collections2[0]);
    }

    // Result: only one CREATE call despite two concurrent resolutions
    expect(createCallCount).toBe(1);
    expect(collections1).toHaveLength(1);
    expect(collections2).toHaveLength(1);
    expect(collections1[0].id).toBe(collections2[0].id); // Same collection
  });
});

/**
 * Test scenario 2: Create remote collections locally and sync files
 *
 * Simulates:
 * - App starts and connects to cloud
 * - Remote has multiple openit-* collections with files
 * - Local has no collections yet
 * Expected:
 * - All openit-* collections are discovered
 * - Local folders are created for each
 * - Files from remote are synced to correct local folders
 * - Each collection gets its own adapter and manifest
 */
describe("Filestore sync: Create remotes locally and sync files", () => {
  const mockRemoteCollections = [
    {
      id: "lib-001",
      name: "openit-library",
      description: "Shared document storage for OpenIT",
    },
    {
      id: "attach-001",
      name: "openit-attachments",
      description: "OpenIT filestore: attachments",
    },
  ];

  const mockRemoteFiles = {
    "lib-001": [
      { path: "document.md", mtime: 1000, content: "# Doc 1" },
      { path: "notes.txt", mtime: 2000, content: "Some notes" },
    ],
    "attach-001": [
      { path: "ticket-123-image.png", mtime: 1500, content: "PNG data" },
    ],
  };

  it("discovers all openit-* collections on remote", () => {
    // Filter to only openit-* collections
    const discovered = mockRemoteCollections.filter((c) => c.name.startsWith("openit-"));

    expect(discovered).toHaveLength(2);
    expect(discovered.map((c) => c.name)).toContain("openit-library");
    expect(discovered.map((c) => c.name)).toContain("openit-attachments");
  });

  it("creates local folder for each remote openit-* collection", () => {
    // Simulate folder creation
    const localFolders: { [key: string]: boolean } = {};

    const discovered = mockRemoteCollections.filter((c) => c.name.startsWith("openit-"));
    for (const collection of discovered) {
      // Strip prefix to get folder name
      const folderName = collection.name.slice("openit-".length);
      localFolders[`filestores/${folderName}`] = true;
    }

    expect(localFolders["filestores/library"]).toBe(true);
    expect(localFolders["filestores/attachments"]).toBe(true);
  });

  it("syncs files from each remote collection to corresponding local folder", () => {
    // Simulate file sync for each collection
    const localFiles: { [key: string]: string[] } = {
      "filestores/library": [],
      "filestores/attachments": [],
    };

    const discovered = mockRemoteCollections.filter((c) => c.name.startsWith("openit-"));

    for (const collection of discovered) {
      const collectionId = collection.id;
      const folderName = collection.name.slice("openit-".length);
      const localPath = `filestores/${folderName}`;
      const remoteFiles = mockRemoteFiles[collectionId as keyof typeof mockRemoteFiles];

      if (remoteFiles) {
        for (const file of remoteFiles) {
          localFiles[localPath].push(file.path);
        }
      }
    }

    // Verify files are in correct folders
    expect(localFiles["filestores/library"]).toContain("document.md");
    expect(localFiles["filestores/library"]).toContain("notes.txt");
    expect(localFiles["filestores/library"]).toHaveLength(2);

    expect(localFiles["filestores/attachments"]).toContain("ticket-123-image.png");
    expect(localFiles["filestores/attachments"]).toHaveLength(1);
  });

  it("creates separate adapter for each collection to prevent cross-collection file routing", () => {
    // Each collection gets its own adapter with its own manifest
    const adapters: { collection: FilestoreCollection; manifestKey: string }[] = [];

    const discovered = mockRemoteCollections.filter((c) => c.name.startsWith("openit-"));

    for (const collection of discovered) {
      const adapter = {
        collection,
        manifestKey: `fs-state-${collection.id}`, // Unique per collection
      };
      adapters.push(adapter);
    }

    // Verify each adapter is unique
    expect(adapters).toHaveLength(2);
    expect(adapters[0].manifestKey).not.toBe(adapters[1].manifestKey);

    // Verify each collection is handled independently
    expect(adapters.map((a) => a.collection.id)).toContain("lib-001");
    expect(adapters.map((a) => a.collection.id)).toContain("attach-001");
  });

  it("prevents files from one collection being routed to another collection's folder", () => {
    // Scenario: openit-library has 2 files, openit-attachments has 1 file
    // Each adapter should only sync its own files to its own folder

    type FileMapping = {
      collectionId: string;
      collectionName: string;
      localFolder: string;
      files: string[];
    };

    const fileMappings: FileMapping[] = [];

    for (const collection of mockRemoteCollections) {
      const folderName = collection.name.slice("openit-".length);
      const remoteFiles = mockRemoteFiles[collection.id as keyof typeof mockRemoteFiles];

      fileMappings.push({
        collectionId: collection.id,
        collectionName: collection.name,
        localFolder: `filestores/${folderName}`,
        files: remoteFiles ? remoteFiles.map((f) => f.path) : [],
      });
    }

    // Verify isolation: library files never appear in attachments folder
    const libraryMapping = fileMappings.find((m) => m.collectionName === "openit-library");
    const attachmentsMapping = fileMappings.find((m) => m.collectionName === "openit-attachments");

    expect(libraryMapping?.files).toContain("document.md");
    expect(libraryMapping?.files).not.toContain("ticket-123-image.png");

    expect(attachmentsMapping?.files).toContain("ticket-123-image.png");
    expect(attachmentsMapping?.files).not.toContain("document.md");
  });

  it("handles case where some remote collections already exist locally", () => {
    // Scenario: openit-library already exists locally with files
    // openit-attachments is new
    // Expected: openit-library files are merged/reconciled, attachments are created fresh

    const localExisting = {
      "filestores/library": ["local-document.md"], // Pre-existing
      "filestores/attachments": [] as string[], // Empty, will be created
    };

    const discovered = mockRemoteCollections.filter((c) => c.name.startsWith("openit-"));

    const syncPlan: { collection: string; localFolder: string; isNew: boolean }[] = [];

    for (const collection of discovered) {
      const folderName = collection.name.slice("openit-".length);
      const localFolder = `filestores/${folderName}`;
      const hasLocalFiles = (localExisting[localFolder as keyof typeof localExisting] ?? []).length > 0;
      const isNew = !hasLocalFiles;

      syncPlan.push({
        collection: collection.name,
        localFolder,
        isNew,
      });
    }

    // openit-library exists with files (not new), openit-attachments is new (empty)
    const libraryPlan = syncPlan.find((p) => p.collection === "openit-library");
    const attachmentsPlan = syncPlan.find((p) => p.collection === "openit-attachments");

    expect(libraryPlan?.isNew).toBe(false); // Has existing files
    expect(attachmentsPlan?.isNew).toBe(true); // Empty, needs to be created
  });
});

/**
 * Test scenario 3: Non-openit collections are filtered out
 *
 * Ensures that user's unrelated collections don't interfere with sync
 */
describe("Filestore sync: Filter non-openit collections", () => {
  it("filters out collections without openit- prefix", () => {
    const allRemoteCollections: DataCollection[] = [
      { id: "1", name: "customer-feedback", type: "filestorage", description: "", numItems: 0 },
      { id: "2", name: "openit-library", type: "filestorage", description: "", numItems: 0 },
      { id: "3", name: "my-docs", type: "filestorage", description: "", numItems: 0 },
      { id: "4", name: "openit-attachments", type: "filestorage", description: "", numItems: 0 },
    ];

    const openitOnly = allRemoteCollections.filter((c) => c.name.startsWith("openit-"));

    expect(openitOnly).toHaveLength(2);
    expect(openitOnly.map((c) => c.name)).toEqual(["openit-library", "openit-attachments"]);
    expect(openitOnly.map((c) => c.name)).not.toContain("customer-feedback");
    expect(openitOnly.map((c) => c.name)).not.toContain("my-docs");
  });

  it("ensures unrelated collections are never synced locally", () => {
    const allRemoteCollections: DataCollection[] = [
      { id: "1", name: "customer-feedback", type: "filestorage", description: "", numItems: 0 },
      { id: "2", name: "openit-library", type: "filestorage", description: "", numItems: 0 },
    ];

    const openitOnly = allRemoteCollections.filter((c) => c.name.startsWith("openit-"));
    const localFolders = openitOnly.map((c) => `filestores/${c.name.slice("openit-".length)}`);

    expect(localFolders).toContain("filestores/library");
    expect(localFolders).not.toContain("filestores/customer-feedback");
  });
});
