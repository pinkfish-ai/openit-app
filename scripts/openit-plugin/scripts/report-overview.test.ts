// Smoke tests for the report-overview.mjs script. Spawns the script
// via `node` against a tempdir seeded with tickets / people /
// conversations and asserts the JSON line + the markdown report
// content. Lives next to the script so it travels with it when the
// script eventually moves to /web.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "report-overview.mjs");

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "openit-report-test-"));
  await mkdir(path.join(tmpDir, "databases", "tickets"), { recursive: true });
  await mkdir(path.join(tmpDir, "databases", "people"), { recursive: true });
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function runScript() {
  return execFileAsync("node", [SCRIPT], { cwd: tmpDir });
}

async function writeTicket(id: string, fields: Record<string, unknown>) {
  await writeFile(
    path.join(tmpDir, "databases", "tickets", `${id}.json`),
    JSON.stringify({ id, ...fields }),
  );
}

async function writePerson(slug: string, email: string) {
  await writeFile(
    path.join(tmpDir, "databases", "people", `${slug}.json`),
    JSON.stringify({ email }),
  );
}

async function readReportFromResult(stdout: string): Promise<string> {
  const result = JSON.parse(stdout.trim());
  expect(result.ok).toBe(true);
  return readFile(path.join(tmpDir, result.path), "utf8");
}

describe("report-overview.mjs", () => {
  it("writes a markdown report and prints the path", async () => {
    await writeTicket("t-1", {
      subject: "VPN broken",
      asker: "alice@example.com",
      status: "escalated",
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writePerson("alice", "alice@example.com");

    const { stdout } = await runScript();
    const result = JSON.parse(stdout.trim());
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/^reports\/\d{4}-\d{2}-\d{2}-\d{4}-overview\.md$/);

    const md = await readFile(path.join(tmpDir, result.path), "utf8");
    expect(md).toContain("# Helpdesk overview");
    expect(md).toContain("1 tickets, 1 people");
    // Status table shows escalated row.
    expect(md).toMatch(/\|\s*escalated\s*\|\s*1\s*\|/);
    // Top-askers shows alice.
    expect(md).toContain("alice@example.com");
    // Currently-escalated table shows the subject + age.
    expect(md).toContain("VPN broken");
    expect(md).toMatch(/2d/);
  });

  it("counts tickets across multiple statuses", async () => {
    await writeTicket("t-1", { subject: "a", asker: "x", status: "open" });
    await writeTicket("t-2", { subject: "b", asker: "y", status: "open" });
    await writeTicket("t-3", { subject: "c", asker: "z", status: "resolved" });

    const md = await readReportFromResult((await runScript()).stdout);
    expect(md).toMatch(/\|\s*open\s*\|\s*2\s*\|/);
    expect(md).toMatch(/\|\s*resolved\s*\|\s*1\s*\|/);
    expect(md).not.toMatch(/\|\s*escalated\s*\|/); // zero-count rows hidden
  });

  it("counts last-7-days activity using updatedAt", async () => {
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

    await writeTicket("recent-resolved", {
      subject: "r",
      asker: "x",
      status: "resolved",
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });
    await writeTicket("old-resolved", {
      subject: "r",
      asker: "x",
      status: "resolved",
      createdAt: tenDaysAgo,
      updatedAt: tenDaysAgo,
    });
    await writeTicket("recent-escalated", {
      subject: "e",
      asker: "x",
      status: "escalated",
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });

    const md = await readReportFromResult((await runScript()).stdout);
    // 2 created in window (recent-resolved + recent-escalated), 1 resolved,
    // 1 escalated.
    expect(md).toMatch(/\|\s*Created\s*\|\s*2\s*\|/);
    expect(md).toMatch(/\|\s*Resolved\s*\|\s*1\s*\|/);
    expect(md).toMatch(/\|\s*Escalated\s*\|\s*1\s*\|/);
  });

  it("renders empty-state notes when there are no tickets", async () => {
    const md = await readReportFromResult((await runScript()).stdout);
    expect(md).toContain("0 tickets, 0 people");
    expect(md).toContain("_No tickets yet._");
    expect(md).toContain("_No askers yet._");
    expect(md).toContain("_None — nothing waiting on the admin._");
  });

  it("skips malformed ticket files without failing the run", async () => {
    await writeTicket("good", {
      subject: "ok",
      asker: "alice",
      status: "escalated",
      createdAt: new Date().toISOString(),
    });
    // A garbage file in the same directory.
    await writeFile(
      path.join(tmpDir, "databases", "tickets", "bad.json"),
      "{ not valid json",
    );
    // A non-JSON file should be ignored too.
    await writeFile(
      path.join(tmpDir, "databases", "tickets", "_schema.json"),
      JSON.stringify({ name: "tickets", type: "datastore" }),
    );

    const md = await readReportFromResult((await runScript()).stdout);
    expect(md).toContain("1 tickets");
    expect(md).toContain("ok");
  });

  it("treats missing databases/ as empty rather than failing", async () => {
    // Re-init tmpDir without the seeded subfolders.
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openit-report-empty-"));

    const { stdout } = await runScript();
    const result = JSON.parse(stdout.trim());
    expect(result.ok).toBe(true);
    const md = await readFile(path.join(tmpDir, result.path), "utf8");
    expect(md).toContain("0 tickets, 0 people");
  });

  it("walks conversation threads without errors", async () => {
    await writeTicket("t-1", { subject: "x", asker: "a", status: "open" });
    const threadDir = path.join(tmpDir, "databases", "conversations", "t-1");
    await mkdir(threadDir, { recursive: true });
    await writeFile(
      path.join(threadDir, "msg-1700000000000-aaa.json"),
      JSON.stringify({ id: "m1", role: "asker", timestamp: "2026-04-25T00:00:00Z", body: "hi" }),
    );
    await writeFile(
      path.join(threadDir, "msg-1700000001000-bbb.json"),
      JSON.stringify({ id: "m2", role: "agent", timestamp: "2026-04-25T00:01:00Z", body: "hello" }),
    );

    const md = await readReportFromResult((await runScript()).stdout);
    expect(md).toContain("# Helpdesk overview");
  });

  it("creates reports/ directory if it doesn't exist", async () => {
    await runScript();
    const entries = await readdir(path.join(tmpDir, "reports"));
    expect(entries.some((e) => e.endsWith("-overview.md"))).toBe(true);
  });

  it("escapes backslash before pipe so pre-escaped pipes survive", async () => {
    // A value already containing the literal sequence `\|` would
    // become `\\|` if we only escaped pipes — GFM reads that as
    // literal-backslash + structural-pipe and the row breaks anyway.
    // Escaping `\` first turns each backslash into `\\`, so the
    // subsequent `|` → `\|` pass leaves the structure intact.
    await writeTicket("t-bs", {
      subject: "backup\\|restore",
      asker: "alice",
      status: "escalated",
      createdAt: new Date().toISOString(),
    });

    const md = await readReportFromResult((await runScript()).stdout);
    // Each `\` → `\\`, each `|` → `\|`. Source is `backup\|restore`
    // (8 chars), so the cell renders as `backup\\\|restore` (10 chars:
    // 6 letters + `\` `\` `\` `|` + 7 more letters = b a c k u p \ \ \ | r e s t o r e).
    expect(md).toContain("backup\\\\\\|restore");
    const escalatedRow = md
      .split("\n")
      .find((l) => l.includes("backup"));
    expect(escalatedRow).toBeDefined();
    // Strip every escape sequence (`\\` and `\|`) before counting
    // the remaining structural pipes — should still be exactly 4.
    const stripped = (escalatedRow ?? "")
      .replace(/\\\\/g, "")
      .replace(/\\\|/g, "");
    const structuralPipes = stripped.match(/\|/g) ?? [];
    expect(structuralPipes.length).toBe(4);
  });

  it("escapes pipe characters in free-form ticket fields", async () => {
    await writeTicket("t-1", {
      // Subject and asker both carry literal pipes that would
      // otherwise break the markdown table column count.
      subject: "Outage | P1: VPN down",
      asker: "alice|bob@example.com",
      status: "escalated",
      createdAt: new Date().toISOString(),
    });

    const md = await readReportFromResult((await runScript()).stdout);
    expect(md).toContain("Outage \\| P1: VPN down");
    expect(md).toContain("alice\\|bob@example.com");
    // The "Currently escalated" row should have exactly the expected
    // column count — three pipes as separators plus the leading and
    // trailing pipes for four total.
    const escalatedRow = md
      .split("\n")
      .find((l) => l.includes("Outage"));
    expect(escalatedRow).toBeDefined();
    const unescapedPipes = (escalatedRow ?? "").replace(/\\\|/g, "").match(/\|/g) ?? [];
    expect(unescapedPipes.length).toBe(4);
  });
});
