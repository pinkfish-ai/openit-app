import { useEffect, useState } from "react";
import { fsList, fsRead, type FileNode } from "../lib/api";
import { scanEscalatedTickets } from "../lib/escalatedTickets";

type Station = {
  id: string;
  label: string;
  glyph: string;
  /** Path relative to repo root. */
  rel: string;
  /** If set, opens this child path on click instead of `rel` (used to
   *  jump into the canonical sub-folder when an entity has just one). */
  openRel?: string;
  /** What to count among direct children. `dirs` = subdir count
   *  (e.g. KB collections, filestore collections); `json-rows` =
   *  direct `.json` files excluding schema + conflict shadows;
   *  `files` = any non-dir, non-dotfile, non-conflict-shadow file
   *  (reports / library entries — typically `.md`). */
  countMode: "dirs" | "json-rows" | "files";
};

const STATIONS: Station[] = [
  // "Tickets Inbox" reads from databases/tickets/ rather than
  // databases/conversations/, so the count matches the ticket-list
  // view (one card per ticket, regardless of how many turns each has).
  // Click still opens databases/tickets which is wired to the
  // conversations-list-style overview.
  { id: "inbox", label: "Tickets Inbox", glyph: "✉", rel: "databases/tickets", countMode: "json-rows" },
  { id: "reports", label: "Reports", glyph: "▦", rel: "reports", countMode: "files" },
  { id: "people", label: "People", glyph: "◔", rel: "databases/people", countMode: "json-rows" },
  { id: "knowledge", label: "Knowledge", glyph: "❋", rel: "knowledge-bases", countMode: "dirs" },
  { id: "files", label: "Files", glyph: "▤", rel: "filestores", countMode: "dirs" },
  { id: "agents", label: "Agents", glyph: "✦", rel: "agents", countMode: "json-rows" },
];

/** fs_list walks recursively (depth 6), so a naive `.length` over its
 *  result over-counts every station that has nested data — most
 *  egregiously inbox, where it returns Σ(msg-*.json across all
 *  threads) instead of one per thread. Restrict to the direct
 *  children of `rootRel`. */
function directChildren(items: FileNode[], rootAbs: string): FileNode[] {
  const prefix = `${rootAbs}/`;
  return items.filter((n) => {
    if (!n.path.startsWith(prefix)) return false;
    const tail = n.path.slice(prefix.length);
    return tail.length > 0 && !tail.includes("/");
  });
}

/// Count tickets whose `status` isn't a terminal state. Anything
/// other than `resolved` / `closed` (or a missing status) is
/// considered unresolved — that includes `open`, `escalated`, and
/// the transient `agent-responding` value.
async function countUnresolved(repo: string): Promise<number> {
  const ticketsDir = `${repo}/databases/tickets`;
  let rows: FileNode[];
  try {
    rows = await fsList(ticketsDir);
  } catch {
    return 0;
  }
  const ticketsPrefix = `${ticketsDir}/`;
  let count = 0;
  await Promise.all(
    rows.map(async (n) => {
      if (n.is_dir) return;
      const tail = n.path.startsWith(ticketsPrefix)
        ? n.path.slice(ticketsPrefix.length)
        : "";
      if (!tail || tail.includes("/")) return;
      if (!n.name.endsWith(".json")) return;
      if (n.name === "_schema.json") return;
      if (n.name.includes(".server.")) return;
      try {
        const raw = await fsRead(n.path);
        const parsed = JSON.parse(raw) as { status?: unknown };
        const status = typeof parsed.status === "string" ? parsed.status : "";
        if (status !== "resolved" && status !== "closed") {
          count += 1;
        }
      } catch {
        // unreadable / unparseable → count it as unresolved so the
        // hero doesn't undercount during a transient race.
        count += 1;
      }
    }),
  );
  return count;
}

function countWithMode(items: FileNode[], mode: Station["countMode"]): number {
  return items.filter((n) => {
    if (n.name.startsWith(".") || n.name === "_schema.json") return false;
    if (n.name.includes(".server.")) return false;
    if (mode === "dirs") return n.is_dir;
    if (mode === "json-rows") return !n.is_dir && n.name.endsWith(".json");
    // "files": any non-dir direct child (reports = `.md`, library =
    // mixed). Excludes the system files filtered above.
    return !n.is_dir;
  }).length;
}

/**
 * Workbench — the curated front door to the project. Sits above the
 * raw file tree in the left pane. Big "Today" card on top, grid of
 * stations below. Each station resolves to a real folder on disk so
 * clicks reuse the existing entity-folder routing.
 */
export function Workbench({
  repo,
  fsTick,
  onOpen,
}: {
  repo: string | null;
  fsTick: number;
  onOpen: (path: string) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [escalatedCount, setEscalatedCount] = useState(0);
  const [unresolvedCount, setUnresolvedCount] = useState(0);
  const [filesExpanded, setFilesExpanded] = useState(false);

  useEffect(() => {
    if (!repo) {
      setCounts({});
      setEscalatedCount(0);
      setUnresolvedCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      const next: Record<string, number> = {};
      await Promise.all(
        STATIONS.map(async (s) => {
          try {
            const rootAbs = `${repo}/${s.rel}`;
            const items = await fsList(rootAbs);
            const direct = directChildren(items, rootAbs);
            next[s.id] = countWithMode(direct, s.countMode);
          } catch {
            next[s.id] = 0;
          }
        }),
      );
      if (!cancelled) setCounts(next);
      try {
        const esc = await scanEscalatedTickets(repo);
        if (!cancelled) setEscalatedCount(esc.length);
      } catch {
        if (!cancelled) setEscalatedCount(0);
      }
      // "Unresolved" = anything that isn't terminal. The today-hero
      // counts these so a clean queue (everything resolved/closed)
      // can read as "Clean inbox. Congrats!" rather than echoing the
      // raw ticket file count, which doesn't drop as work gets done.
      try {
        const unresolved = await countUnresolved(repo);
        if (!cancelled) setUnresolvedCount(unresolved);
      } catch {
        if (!cancelled) setUnresolvedCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, fsTick]);

  // Emit a custom event that Shell.tsx listens for to swap the left
  // tab to the raw file tree (mounted as a sibling, hidden by default).
  const showFiles = () => {
    setFilesExpanded((v) => !v);
    window.dispatchEvent(
      new CustomEvent("openit:workbench-toggle-files", {
        detail: { expanded: !filesExpanded },
      }),
    );
  };

  return (
    <div className="workbench">
      <div className="workbench-today">
        <div className="workbench-today-eyebrow">TODAY</div>
        {unresolvedCount === 0 ? (
          <div className="workbench-today-hero workbench-today-hero-clean">
            <span className="workbench-today-clean">Clean inbox. Congrats!</span>
          </div>
        ) : (
          <div className="workbench-today-hero">
            <span className="workbench-today-number">{unresolvedCount}</span>
            <span className="workbench-today-label">
              unresolved ticket{unresolvedCount === 1 ? "" : "s"}
            </span>
          </div>
        )}
        {escalatedCount > 0 && (
          <div className="workbench-today-meta">
            <span className="workbench-today-pip" />
            {escalatedCount} need{escalatedCount === 1 ? "s" : ""} your reply
          </div>
        )}
      </div>

      <div className="workbench-section-label">Stations</div>
      <div className="workbench-stations">
        {STATIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="station"
            onClick={() => repo && onOpen(`${repo}/${s.openRel ?? s.rel}`)}
            title={s.label}
          >
            <span className="station-glyph" aria-hidden>
              {s.glyph}
            </span>
            <span className="station-body">
              <span className="station-label">{s.label}</span>
              <span className="station-count">{counts[s.id] ?? "·"}</span>
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`workbench-files-toggle ${filesExpanded ? "open" : ""}`}
        onClick={showFiles}
      >
        <span className="workbench-files-caret">{filesExpanded ? "▾" : "▸"}</span>
        <span>Files</span>
        <span className="workbench-files-hint">
          {filesExpanded ? "raw tree" : "advanced"}
        </span>
      </button>
    </div>
  );
}
