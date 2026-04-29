import * as fs from "fs";
import * as path from "path";

export interface IntegrationTestConfig {
  repo: string;
  orgId: string;
  credentials: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
  };
  collections: {
    docs: string;
    attachments: string;
    library: string;
  };
}

/**
 * Load integration test config from test-config.json
 * Returns null if config doesn't exist (tests will be skipped)
 */
export function loadConfig(): IntegrationTestConfig | null {
  const configPath = path.resolve(process.cwd(), "test-config.json");

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content) as IntegrationTestConfig;
  } catch (e) {
    console.error("Failed to parse test-config.json:", e);
    return null;
  }
}

export function requireConfig(): IntegrationTestConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      "test-config.json not found. Copy test-config.example.json to test-config.json and fill in your credentials."
    );
  }
  return config;
}
