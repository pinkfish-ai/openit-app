import { vi } from "vitest";

/**
 * Setup mocks for auth and API calls
 */
export function setupAuthMocks(tokenUrl: string, clientId: string) {
  vi.mock("../../src/lib/pinkfishAuth", () => ({
    getToken: vi.fn(() => ({
      accessToken: "test-token",
    })),
    derivedUrls: vi.fn((url) => ({
      skillsBaseUrl: "https://skills-stage.pinkfish.ai",
    })),
  }));
}

/**
 * Create mock file list responses
 */
export function createMockFileList(files: Array<{ filename: string; url: string; updatedAt: string }>) {
  return files.map((f) => ({
    filename: f.filename,
    signed_url: f.url,
    updated_at: f.updatedAt,
  }));
}
