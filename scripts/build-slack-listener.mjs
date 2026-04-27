// Build the Slack listener into a self-contained CommonJS bundle.
//
// Why bundle: existing OpenIT plugin scripts (sync-push.mjs etc.)
// are dependency-light and use only Node stdlib + fetch. The Slack
// listener needs `@slack/socket-mode` and `@slack/web-api`, which
// would force a `node_modules` install in every user's project. A
// single-file esbuild bundle inherits the same "drop in and it
// runs" property as the rest of the plugin scripts.
//
// Output goes next to the source so the plugin manifest sync picks
// it up at the same path users expect.

import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const entry = path.join(
  repoRoot,
  "scripts",
  "openit-plugin",
  "scripts",
  "slack-listen.src.mjs",
);
const outfile = path.join(
  repoRoot,
  "scripts",
  "openit-plugin",
  "scripts",
  "slack-listen.bundle.cjs",
);

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Keep an unminified bundle so a curious admin / Claude session
  // can read it on disk and stack traces are useful in the listener
  // log. Size cost is small (~2MB) and the file ships in the .app
  // resources, not over the wire to users.
  minify: false,
  sourcemap: false,
  legalComments: "inline",
  // Slack SDKs occasionally pull in optional native bits (e.g.
  // bufferutil for ws). esbuild marks them external by default
  // when not resolvable; explicit list here documents intent.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});

console.log(`built: ${path.relative(repoRoot, outfile)}`);
