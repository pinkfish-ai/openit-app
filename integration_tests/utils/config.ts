import * as fs from "fs";
import * as path from "path";

export interface IntegrationTestConfig {
  repo: string;
  orgId: string;
  credentials: {
    /// Full OAuth token URL including /oauth/token path
    /// e.g., https://app-api.dev20.pinkfish.dev/oauth/token
    tokenUrl: string;
    /// Web app URL for the environment
    /// e.g., https://dev20.pinkfish.dev
    webUrl: string;
    clientId: string;
    clientSecret: string;
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
      "test-config.json not found. Copy test-config.example.json to test-config.json and fill in your credentials.",
    );
  }
  return config;
}

/**
 * Derive the skills base URL from the token URL.
 * Mirrors the logic in src/lib/pinkfishAuth.ts derivedUrls()
 */
export function deriveSkillsBaseUrl(tokenUrl: string): string {
  let host: string;
  try {
    host = new URL(tokenUrl).host;
  } catch {
    host = "app-api.app.pinkfish.ai";
  }
  const isDev = host.endsWith(".pinkfish.dev") || /\.dev\d/i.test(host);
  const skillsHost = isDev ? "skills-stage.pinkfish.ai" : "skills.pinkfish.ai";
  return `https://${skillsHost}`;
}
