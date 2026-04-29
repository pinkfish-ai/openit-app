import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "integration",
    include: ["integration_tests/**/*.test.ts"],
    exclude: ["node_modules"],
    globals: true,
    environment: "node",
    testTimeout: 60000, // 60 seconds for real API calls (uploads can be slow)
    hookTimeout: 60000,
    setupFiles: [],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
