#!/usr/bin/env node
// hello-world.mjs — sample script (PIN-5829 seed dataset).
//
// What this does:
//   - Reads the project's tickets/ and conversations/ folders.
//   - Counts open / resolved / escalated tickets.
//   - Prints a single-line summary.
//
// Inputs: none. Reads from CWD assuming it's an OpenIT project root.
// Side effects: prints to stdout. No writes.
//
// This is a sample shipped via "Create sample dataset" on the
// getting-started page. It demonstrates the shape
// `/conversation-to-automation` produces when it captures a
// deterministic admin CLI sequence as a runnable script. Delete or
// rewrite as you see fit.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const TICKETS_DIR = join(ROOT, "databases", "tickets");

async function main() {
  let entries;
  try {
    entries = await readdir(TICKETS_DIR);
  } catch (err) {
    console.error(`No tickets dir at ${TICKETS_DIR}. Run from an OpenIT project root.`);
    process.exit(1);
  }

  const VALID_STATUSES = new Set(["open", "resolved", "escalated"]);
  const counts = { open: 0, resolved: 0, escalated: 0, other: 0 };
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith(".json") || name === "_schema.json") continue;
    total += 1;
    try {
      const raw = await readFile(join(TICKETS_DIR, name), "utf8");
      const t = JSON.parse(raw);
      const status = typeof t?.status === "string" ? t.status : "other";
      if (VALID_STATUSES.has(status)) counts[status] += 1;
      else counts.other += 1;
    } catch {
      counts.other += 1;
    }
  }

  console.log(
    `Hello! Project has ${total} ticket(s): ${counts.open} open, ` +
      `${counts.resolved} resolved, ${counts.escalated} escalated, ${counts.other} other.`,
  );
}

main().catch((err) => {
  console.error("hello-world failed:", err);
  process.exit(1);
});
