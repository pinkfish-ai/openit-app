import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Dev escape hatch: if test-config.json is present (gitignored), feed its
// creds into the VITE_DEV_* env vars that pinkfishAuth.loadCreds() honors.
// Lets dev runs skip the keychain entirely so we don't get re-prompted on
// every rebuild. Production builds never read this file.
function loadDevCredsFromTestConfig() {
  // @ts-expect-error process is a nodejs global
  const env = process.env as Record<string, string | undefined>;
  // If any explicit VITE_DEV_* override is already set, respect it.
  if (env.VITE_DEV_CLIENT_ID) return;
  try {
    const path = resolve(__dirname, "test-config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      orgId?: string;
      credentials?: {
        clientId?: string;
        clientSecret?: string;
        tokenUrl?: string;
      };
    };
    const c = cfg.credentials;
    if (cfg.orgId && c?.clientId && c.clientSecret) {
      env.VITE_DEV_CLIENT_ID = c.clientId;
      env.VITE_DEV_CLIENT_SECRET = c.clientSecret;
      env.VITE_DEV_ORG_ID = cfg.orgId;
      if (c.tokenUrl) env.VITE_DEV_TOKEN_URL = c.tokenUrl;
      // eslint-disable-next-line no-console
      console.log("[vite] dev creds loaded from test-config.json — skipping keychain");
    }
  } catch {
    // No test-config.json — fall through to normal keychain flow.
  }
}
loadDevCredsFromTestConfig();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
