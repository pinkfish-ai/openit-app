import * as fs from "fs";
import * as path from "path";

export interface TestConfig {
  repo: string;
  orgId: string;
  credentials: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
  };
  collectionIds: {
    docs: string;
    attachments: string;
    library: string;
  };
}

export function loadTestConfig(): TestConfig | null {
  const configPath = path.join(process.cwd(), "test-config.json");

  if (!fs.existsSync(configPath)) {
    console.warn(`Test config not found at ${configPath}`);
    console.warn("Copy test-config.example.json to test-config.json and fill in real credentials");
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.error("Failed to load test config:", e);
    return null;
  }
}

export function isIntegrationTestAvailable(): boolean {
  return loadTestConfig() !== null;
}
