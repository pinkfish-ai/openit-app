#!/usr/bin/env node
// report-overview.mjs — programmatic helpdesk overview. Reads the
// local ticket / people / conversation files and writes a markdown
// report at reports/<YYYY-MM-DD-HHmm>-overview.md. No LLM, no network
// — pure file I/O so it's instant.
//
// Usage:
//   node .claude/scripts/report-overview.mjs
//
// Output (single JSON line on stdout):
//   { "ok": true, "path": "reports/2026-04-27-1432-overview.md" }
// On failure (single JSON line):
//   { "ok": false, "error": "<message>" }
//
// cwd: the OpenIT project root (`~/OpenIT/<slug>/`).

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TICKETS_DIR = "databases/tickets";
const PEOPLE_DIR = "databases/people";
const CONVERSATIONS_DIR = "databases/conversations";
const REPORTS_DIR = "reports";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/// Format a Date as `YYYY-MM-DD-HHmm` in local time. Used for the
/// filename prefix; reverse-alphabetical sort on filenames lands the
/// newest report at the top of the explorer.
function timestampFilename(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

/// Read every *.json directly inside dir (depth 1, skipping `_schema.json`
/// and conflict-shadow `.server.*` files). Unreadable / unparseable
/// files are skipped silently so one malformed row doesn't fail the
/// whole report. Missing dir → empty array.
async function readJsonRows(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const rows = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".json")) continue;
    if (ent.name === "_schema.json") continue;
    if (ent.name.includes(".server.")) continue;
    try {
      const raw = await readFile(path.join(dir, ent.name), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") rows.push(parsed);
    } catch {
      /* skip unparseable */
    }
  }
  return rows;
}

/// Walk databases/conversations/<ticketId>/msg-*.json and return a
/// map of ticketId → { turnCount, lastTurnAt }. Used so the overview
/// can show "stale" tickets (escalated but no turn in N days).
async function readConversationActivity() {
  let entries;
  try {
    entries = await readdir(CONVERSATIONS_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return new Map();
    throw e;
  }
  const out = new Map();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const ticketId = ent.name;
    const threadDir = path.join(CONVERSATIONS_DIR, ticketId);
    let msgs;
    try {
      msgs = await readdir(threadDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let turnCount = 0;
    let lastTurnAt = "";
    for (const m of msgs) {
      if (!m.isFile()) continue;
      if (!m.name.endsWith(".json")) continue;
      if (m.name.includes(".server.")) continue;
      turnCount += 1;
      try {
        const raw = await readFile(path.join(threadDir, m.name), "utf8");
        const parsed = JSON.parse(raw);
        const ts = parsed && typeof parsed.timestamp === "string" ? parsed.timestamp : "";
        if (ts > lastTurnAt) lastTurnAt = ts;
      } catch {
        /* skip unparseable */
      }
    }
    out.set(ticketId, { turnCount, lastTurnAt });
  }
  return out;
}

/// Days between `iso` and `now`. Returns null on a missing/unparseable
/// timestamp so callers can render "—" instead of NaN.
function ageDays(iso, now) {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = now.getTime() - t;
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

/// Lower-case-trim wrapper used as a defensive guard around free-form
/// asker fields (some rows have email, some have "unknown", some have
/// names with extra whitespace). Empty string / non-string → "unknown"
/// so the top-askers grouping doesn't blow up.
function askerKey(a) {
  if (typeof a !== "string") return "unknown";
  const trimmed = a.trim().toLowerCase();
  return trimmed || "unknown";
}

/// Sum tickets by status. Returns a Map preserving insertion order, so
/// statuses we expect surface in a stable order even if zero. Any
/// unknown status gets appended.
const KNOWN_STATUSES = [
  "incoming",
  "agent-responding",
  "open",
  "escalated",
  "answered",
  "resolved",
  "closed",
];

function countByStatus(tickets) {
  const counts = new Map();
  for (const s of KNOWN_STATUSES) counts.set(s, 0);
  for (const t of tickets) {
    const s = typeof t.status === "string" ? t.status : "unknown";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

function topAskers(tickets, n) {
  const tally = new Map();
  for (const t of tickets) {
    const k = askerKey(t.asker);
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  return Array.from(tally.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/// Bucket tickets into "created in the last N days" / "resolved in the
/// last N days" / "escalated in the last N days". `resolved` and
/// `escalated` use updatedAt as a proxy for the transition time —
/// imperfect (admin could update for unrelated reasons) but the only
/// signal available without a status-history log.
function activityWindow(tickets, days, now) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  let created = 0;
  let resolved = 0;
  let escalated = 0;
  for (const t of tickets) {
    const c = Date.parse(t.createdAt ?? "");
    if (!Number.isNaN(c) && c >= cutoff) created += 1;
    const u = Date.parse(t.updatedAt ?? "");
    if (!Number.isNaN(u) && u >= cutoff) {
      if (t.status === "resolved" || t.status === "answered") resolved += 1;
      if (t.status === "escalated") escalated += 1;
    }
  }
  return { created, resolved, escalated };
}

/// Escape characters that would break a GFM table cell. Pipes are
/// the structural separator and must be backslash-escaped; raw
/// newlines split a row. Matters for free-form ticket fields
/// (subject, asker) that flow straight from user input — a subject
/// like "Outage | P1: VPN down" otherwise produces a row with the
/// wrong column count and a visibly broken table. Backslashes are
/// escaped first so a value already containing a literal `\|` (rare
/// but possible) doesn't become `\\|`, which GFM reads as
/// literal-backslash + structural-pipe and reintroduces the bug.
function escapeTableCell(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function renderTable(headers, rows) {
  const head = `| ${headers.map(escapeTableCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${r.map(escapeTableCell).join(" | ")} |`)
    .join("\n");
  return [head, sep, body].join("\n");
}

function renderReport({ now, tickets, peopleCount, activity }) {
  const lines = [];
  lines.push("# Helpdesk overview");
  lines.push("");
  lines.push(`_Generated ${now.toISOString()} — ${tickets.length} tickets, ${peopleCount} people._`);
  lines.push("");

  // Status breakdown.
  lines.push("## Tickets by status");
  lines.push("");
  const statusCounts = countByStatus(tickets);
  const statusRows = Array.from(statusCounts.entries())
    .filter(([, n]) => n > 0)
    .map(([s, n]) => [s, String(n)]);
  if (statusRows.length === 0) {
    lines.push("_No tickets yet._");
  } else {
    lines.push(renderTable(["Status", "Count"], statusRows));
  }
  lines.push("");

  // Last 7 days.
  lines.push("## Last 7 days");
  lines.push("");
  lines.push(
    renderTable(
      ["Metric", "Count"],
      [
        ["Created", String(activity.created)],
        ["Resolved", String(activity.resolved)],
        ["Escalated", String(activity.escalated)],
      ],
    ),
  );
  lines.push("");

  // Top askers.
  lines.push("## Top askers");
  lines.push("");
  const askers = topAskers(tickets, 5);
  if (askers.length === 0) {
    lines.push("_No askers yet._");
  } else {
    lines.push(
      renderTable(
        ["Asker", "Tickets"],
        askers.map(([a, n]) => [a, String(n)]),
      ),
    );
  }
  lines.push("");

  // Currently escalated.
  lines.push("## Currently escalated");
  lines.push("");
  const escalated = tickets
    .filter((t) => t.status === "escalated")
    .map((t) => {
      const subject = typeof t.subject === "string" ? t.subject : "";
      const asker = typeof t.asker === "string" ? t.asker : "unknown";
      const age = ageDays(t.createdAt, now);
      const ageStr = age == null ? "—" : `${age}d`;
      return [
        subject || "(no subject)",
        asker,
        ageStr,
      ];
    });
  if (escalated.length === 0) {
    lines.push("_None — nothing waiting on the admin._");
  } else {
    lines.push(renderTable(["Subject", "Asker", "Age"], escalated));
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const now = new Date();

  let tickets;
  let peopleCount;
  try {
    tickets = await readJsonRows(TICKETS_DIR);
    const people = await readJsonRows(PEOPLE_DIR);
    peopleCount = people.length;
    // Conversation activity is currently read for a future "stale
    // escalations" section; intentionally not surfaced in V1 output
    // because we lack an admin-acknowledged-at timestamp to anchor
    // staleness against. Keep the read so the file doesn't drift.
    await readConversationActivity();
  } catch (e) {
    emit({ ok: false, error: `read failed: ${e.message}` });
    process.exit(1);
    return;
  }

  const activity = activityWindow(tickets, 7, now);
  const body = renderReport({ now, tickets, peopleCount, activity });

  const fname = `${timestampFilename(now)}-overview.md`;
  const fullPath = path.join(REPORTS_DIR, fname);
  try {
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(fullPath, body, "utf8");
  } catch (e) {
    emit({ ok: false, error: `write failed: ${e.message}` });
    process.exit(1);
    return;
  }

  emit({ ok: true, path: fullPath });
}

main().catch((e) => {
  emit({ ok: false, error: e.stack ?? String(e) });
  process.exit(1);
});
