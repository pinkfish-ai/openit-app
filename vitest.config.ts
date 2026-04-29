import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // The integration_tests/ suite hits real Pinkfish APIs and uses
    // its own config (vitest.integration.config.ts) with a longer
    // timeout. `npm test` is for fast unit tests only — integration
    // is `npm run test:integration`.
    exclude: ["**/node_modules/**", "**/dist/**", "integration_tests/**"],
  },
});
