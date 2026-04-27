// Ticket scanners for the shell's status banners. Two scans, both
// reading `databases/tickets/<row>.json` under the project repo:
//
//   - scanEscalatedTickets — status === "escalated". Drives the
//     EscalatedTicketBanner: agent gave up, admin must handle.
//   - scanAgentRespondingTickets — status === "agent-responding".
//     Drives the AgentActivityBanner: a `claude -p` chat turn is
//     running for this ticket; admin sees activity in real time.
//
// Both are fs-tick driven (rescan on every fs change). Cheap on
// small/medium volumes — a few file reads + JSON parses per scan.

import { fsList, fsRead, type FileNode } from "./api";

export type TicketSummary = {
  // Absolute path to the row file on disk.
  path: string;
  // Path relative to repo root (e.g. "databases/tickets/foo.json").
  relPath: string;
  // Best-effort subject from the row JSON; empty string if missing.
  subject: string;
  // Best-effort asker from the row JSON; empty string if missing.
  asker: string;
};

async function scanByStatus(repo: string, statusFilter: string): Promise<TicketSummary[]> {
  const results: TicketSummary[] = [];
  const ticketsDir = `${repo}/databases/tickets`;
  let rows: FileNode[];
  try {
    rows = await fsList(ticketsDir);
  } catch {
    // databases/tickets/ doesn't exist yet (fresh project).
    return results;
  }

  for (const row of rows) {
    if (row.is_dir) continue;
    if (!row.name.endsWith(".json")) continue;
    if (row.name === "_schema.json") continue;
    if (row.name.endsWith(".server.json")) continue;

    const ticket = await readIfStatus(row.path, repo, statusFilter);
    if (ticket) results.push(ticket);
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/// Tickets the agent gave up on — admin must handle.
export async function scanEscalatedTickets(repo: string): Promise<TicketSummary[]> {
  return scanByStatus(repo, "escalated");
}

/// Tickets currently being processed by a `claude -p` subprocess.
/// Drives the live activity banner.
export async function scanAgentRespondingTickets(repo: string): Promise<TicketSummary[]> {
  return scanByStatus(repo, "agent-responding");
}

async function readIfStatus(
  absPath: string,
  repo: string,
  statusFilter: string,
): Promise<TicketSummary | null> {
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
  if (obj.status !== statusFilter) return null;
  return {
    path: absPath,
    relPath: absPath.startsWith(`${repo}/`) ? absPath.slice(repo.length + 1) : absPath,
    subject: typeof obj.subject === "string" ? obj.subject : "",
    asker: typeof obj.asker === "string" ? obj.asker : "",
  };
}
