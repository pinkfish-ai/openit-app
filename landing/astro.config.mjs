import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://openit.example.com",
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
});
