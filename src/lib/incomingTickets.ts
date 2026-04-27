// Local-mode incoming-ticket detection. Walks `databases/tickets/<row>.json`
// under the project repo and returns rows with `status === "incoming"`.
// Used by the shell's IncomingTicketBanner to surface tickets the admin
// should run through triage.
//
// "incoming" is the status assigned to rows that arrived via a path
// other than the admin typing in chat: the localhost intake form
// (Phase 5), channel ingest (cloud), or a cold-write by some other
// process. The triage skill's job is to move them to "open" /
// "answered" once a human (or Claude) has handled them.
//
// Scanning is fs-tick driven, not engine-driven — incoming rows can
// land independently of any sync (a coworker submits the form while
// offline). We rescan on every fs change. The work is bounded: only
// `databases/tickets/`, only JSON files, and we stop reading a file
// as soon as we see a non-incoming status.

import { fsList, fsRead, type FileNode } from "./api";

export type IncomingTicket = {
  // Absolute path to the row file on disk.
  path: string;
  // Path relative to repo root (e.g. "databases/tickets/foo.json").
  relPath: string;
  // Best-effort subject from the row JSON; empty string if missing.
  subject: string;
  // Best-effort asker from the row JSON; empty string if missing.
  asker: string;
};

/// Scan a project repo for tickets with status `incoming`. Returns the
/// list sorted by file path so the order is stable across calls.
///
/// Cheap on small/medium volumes (one open + parse per row file). For
/// orgs with thousands of tickets this could be optimized with a
/// single-pass index, but until that's a real complaint we keep it
/// simple — files are the source of truth.
export async function scanIncomingTickets(repo: string): Promise<IncomingTicket[]> {
  const results: IncomingTicket[] = [];
  const ticketsDir = `${repo}/databases/tickets`;
  let rows: FileNode[];
  try {
    rows = await fsList(ticketsDir);
  } catch {
    // databases/tickets/ doesn't exist yet (fresh project, no bundled
    // schema written, or pre-rename layout).
    return results;
  }

  for (const row of rows) {
    if (row.is_dir) continue;
    if (!row.name.endsWith(".json")) continue;
    // Skip schema + state-shadow files — only ticket rows have a status.
    if (row.name === "_schema.json") continue;
    if (row.name.endsWith(".server.json")) continue;

    const ticket = await readIfIncoming(row.path, repo);
    if (ticket) results.push(ticket);
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

async function readIfIncoming(absPath: string, repo: string): Promise<IncomingTicket | null> {
  let raw: string;
  try {
    raw = await fsRead(absPath);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.status !== "incoming") return null;
  return {
    path: absPath,
    relPath: absPath.startsWith(`${repo}/`) ? absPath.slice(repo.length + 1) : absPath,
    subject: typeof obj.subject === "string" ? obj.subject : "",
    asker: typeof obj.asker === "string" ? obj.asker : "",
  };
}
