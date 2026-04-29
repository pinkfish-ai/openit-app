import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "integration",
    include: ["integration_tests/**/*.test.ts"],
    exclude: ["node_modules"],
    globals: true,
    environment: "node",
    testTimeout: 30000, // 30 seconds for real API calls
    hookTimeout: 30000,
    setupFiles: [],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
