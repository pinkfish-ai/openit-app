// Tiny helper: write `.openit/flash.json` so the OpenIT app's
// fs-watcher picks it up and shows a toast. Best-effort — never
// throws to the caller. Scripts are run from cwd = project dir.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function flash(message) {
  try {
    const dir = resolve(process.cwd(), ".openit");
    await mkdir(dir, { recursive: true });
    const body = JSON.stringify({ message, ts: Date.now() });
    await writeFile(resolve(dir, "flash.json"), body, "utf8");
  } catch {
    // Toast is a "nice to have" — never crash the script over it.
  }
}
