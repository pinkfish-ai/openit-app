import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://pinkfish-ai.github.io",
  base: "/openit-app",
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
});
