// Escalated-ticket detection. Walks `databases/openit-tickets-*/` row
// files on demand and classifies any with status indicating "needs
// human" (open / escalated / pending). Drives the
// EscalatedTicketBanner — same subscribe pattern as the engine's
// conflict aggregate.
//
// Phase B of the helpdesk vision (auto-dev/plans/2026-04-26-helpdesk-vision.md).
//
// We're deliberately schema-aware-but-flexible: read `_schema.json`
// for each tickets collection if present, look for a field labelled
// "status" (or one of a small allowlist), and check its value. If the
// schema doesn't help, fall back to scanning the row's JSON for
// `"status"` matching one of the open-shaped values. That way the
// helper still works for orgs whose tickets datastore was created
// from a non-default template, or when the schema file hasn't synced
// yet.

import { fsList, fsRead } from "./api";

export type EscalatedTicket = {
  /// Repo-relative path to the ticket JSON, e.g.
  /// `databases/openit-tickets-XXX/row-1234.json`.
  workingTreePath: string;
  /// Collection directory name, useful for grouping in UI.
  collection: string;
  /// Filename without extension — also the manifestKey segment after
  /// the collection prefix.
  rowKey: string;
};

const subscribers = new Set<(tickets: EscalatedTicket[]) => void>();
let lastSnapshot: EscalatedTicket[] = [];

export function subscribeEscalatedTickets(
  fn: (tickets: EscalatedTicket[]) => void,
): () => void {
  subscribers.add(fn);
  fn(lastSnapshot);
  return () => {
    subscribers.delete(fn);
  };
}

function emit(tickets: EscalatedTicket[]) {
  lastSnapshot = tickets;
  for (const fn of subscribers) {
    try {
      fn(tickets);
    } catch (e) {
      console.error("[ticketStatus] subscriber threw:", e);
    }
  }
}

/// Re-classify all tickets under `<repo>/databases/openit-tickets-*`.
/// Cheap to call on every fs-tick; only emits to subscribers when the
/// snapshot actually changes (by-path identity, not deep compare).
export async function refreshEscalatedTickets(repo: string): Promise<void> {
  if (!repo) {
    if (lastSnapshot.length > 0) emit([]);
    return;
  }
  let tickets: EscalatedTicket[] = [];
  try {
    tickets = await scanEscalated(repo);
  } catch (e) {
    console.error("[ticketStatus] scan failed:", e);
    tickets = [];
  }
  if (snapshotsEqual(tickets, lastSnapshot)) return;
  emit(tickets);
}

/// Sub-bullet of `refreshEscalatedTickets` exposed for unit tests; do
/// the actual classification work without touching the subscriber set.
export async function scanEscalated(repo: string): Promise<EscalatedTicket[]> {
  const databasesDir = `${repo}/databases`;
  let dirs: { path: string; name: string }[] = [];
  try {
    const nodes = await fsList(databasesDir);
    dirs = nodes
      .filter((n) => n.is_dir && n.name.startsWith("openit-tickets"))
      .map((n) => ({ path: n.path, name: n.name }));
  } catch {
    // databases/ doesn't exist yet (fresh project pre-bootstrap) → no
    // tickets to scan.
    return [];
  }

  const out: EscalatedTicket[] = [];
  for (const dir of dirs) {
    const schema = await loadSchemaSafe(dir.path);
    let files: { name: string; path: string }[] = [];
    try {
      const nodes = await fsList(dir.path);
      files = nodes
        .filter(
          (n) =>
            !n.is_dir &&
            n.name.endsWith(".json") &&
            n.name !== "_schema.json" &&
            !n.name.includes(".server."),
        )
        .map((n) => ({ name: n.name, path: n.path }));
    } catch {
      continue;
    }
    for (const f of files) {
      let row: unknown;
      try {
        row = JSON.parse(await fsRead(f.path));
      } catch {
        continue;
      }
      if (!isEscalated(row, schema)) continue;
      out.push({
        workingTreePath: `databases/${dir.name}/${f.name}`,
        collection: dir.name,
        rowKey: f.name.replace(/\.json$/, ""),
      });
    }
  }
  return out;
}

type SchemaShape = {
  /// Map of field id (e.g. `f_5`) → human label (e.g. `status`),
  /// lowercased. Only the fields we care about (status / state) are
  /// populated; other fields don't need to land here.
  statusFieldIds: string[];
};

const STATUS_LABEL_MATCH = /(^|\s|-|_)(status|state|ticket[_\s-]?status)(\s|$|-|_)/i;

const ESCALATED_VALUES = new Set([
  "open",
  "escalated",
  "needs-human",
  "needs_human",
  "pending",
  "new",
]);

const ANSWERED_VALUES = new Set([
  "answered",
  "resolved",
  "closed",
  "done",
]);

async function loadSchemaSafe(collectionDir: string): Promise<SchemaShape> {
  const empty: SchemaShape = { statusFieldIds: [] };
  try {
    const raw = await fsRead(`${collectionDir}/_schema.json`);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // The case-management template's schema shape isn't strictly
    // documented here, so we accept several plausible shapes:
    //   - { fields: [{ id, label, ... }] }
    //   - { properties: { f_1: { label } } }
    //   - { f_1: "Status" }  (label-only flat shape)
    const ids: string[] = [];
    if (Array.isArray((parsed as { fields?: unknown }).fields)) {
      for (const f of (parsed as { fields: Record<string, unknown>[] }).fields) {
        const id = typeof f.id === "string" ? f.id : null;
        const label =
          typeof f.label === "string"
            ? f.label
            : typeof f.name === "string"
            ? f.name
            : "";
        if (id && STATUS_LABEL_MATCH.test(label)) ids.push(id);
      }
    } else if (
      typeof (parsed as { properties?: unknown }).properties === "object" &&
      (parsed as { properties: unknown }).properties != null
    ) {
      const props = (parsed as { properties: Record<string, unknown> }).properties;
      for (const [id, def] of Object.entries(props)) {
        const label =
          typeof (def as { label?: unknown })?.label === "string"
            ? ((def as { label: string }).label)
            : "";
        if (STATUS_LABEL_MATCH.test(label)) ids.push(id);
      }
    } else {
      for (const [id, val] of Object.entries(parsed)) {
        if (typeof val === "string" && STATUS_LABEL_MATCH.test(val)) ids.push(id);
      }
    }
    return { statusFieldIds: ids };
  } catch {
    return empty;
  }
}

function isEscalated(row: unknown, schema: SchemaShape): boolean {
  if (!row || typeof row !== "object") return false;
  const obj = row as Record<string, unknown>;

  // 1. Schema-aware: any of the status field IDs holds an escalated value.
  for (const id of schema.statusFieldIds) {
    const v = obj[id];
    if (typeof v === "string" && ESCALATED_VALUES.has(v.toLowerCase())) {
      return true;
    }
  }
  // If schema named status fields and they're all answered, the row
  // is explicitly resolved — don't fall through to fuzzy matching.
  if (schema.statusFieldIds.length > 0) {
    for (const id of schema.statusFieldIds) {
      const v = obj[id];
      if (typeof v === "string" && ANSWERED_VALUES.has(v.toLowerCase())) {
        return false;
      }
    }
  }

  // 2. Fallback: scan top-level string fields for an escalated value
  //    when paired with a key that looks like a status field. Only
  //    fires when the schema didn't pin status fields.
  if (schema.statusFieldIds.length === 0) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string") continue;
      const lower = v.toLowerCase();
      if (!ESCALATED_VALUES.has(lower)) continue;
      // Only treat the value as a status if its key looks like one,
      // OR the key is a generic field id (`f_*`) — random strings
      // happening to equal "open" elsewhere in the row shouldn't
      // raise the banner.
      if (STATUS_LABEL_MATCH.test(k) || /^f_\d+$/.test(k)) {
        return true;
      }
    }
  }

  // 3. Boolean escalation flag: any field whose label/key contains
  //    "escalat" set to true.
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "boolean" || v !== true) continue;
    if (/escalat/i.test(k)) return true;
  }

  return false;
}

function snapshotsEqual(a: EscalatedTicket[], b: EscalatedTicket[]): boolean {
  if (a.length !== b.length) return false;
  const aKeys = a.map((t) => t.workingTreePath).sort();
  const bKeys = b.map((t) => t.workingTreePath).sort();
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  return true;
}

/// Test-only: drop the cached snapshot + subscribers so a unit test
/// can drive a clean state.
export function _resetForTesting(): void {
  subscribers.clear();
  lastSnapshot = [];
}
