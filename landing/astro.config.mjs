import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://pinkfish-ai.github.io",
  base: "/openit-app",
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
  integrations: [
    tailwind({
      // The Lovable index.css owns the @tailwind directives + design tokens.
      applyBaseStyles: false,
    }),
  ],
});
