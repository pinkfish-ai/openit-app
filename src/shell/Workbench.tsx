import { useEffect, useState, type ReactNode } from "react";
import { fsList, type FileNode } from "../lib/api";
import { scanEscalatedTickets } from "../lib/escalatedTickets";

/// Inline SVGs for each station glyph. Replaces the previous unicode
/// characters (✉ ▦ ❋ ▤ ✦) which rendered too heavy / placeholder-ish
/// on the cream pane. Each icon is monochrome via `currentColor` so
/// it inherits the station-glyph color; 1.6px stroke gives a clean
/// line-icon feel that matches the rest of the cream-on-cream
/// identity.

const InboxIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 7l9 6.5L21 7" />
  </svg>
);

const ReportsIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <line x1="6" y1="20" x2="6" y2="14" />
    <line x1="12" y1="20" x2="12" y2="9" />
    <line x1="18" y1="20" x2="18" y2="4" />
  </svg>
);

const PersonIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 21c0-4.0 3.1-7 7-7s7 3.0 7 7v1H5z" />
  </svg>
);

const KnowledgeIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 4a2 2 0 0 1 2-2h12v20H7a2 2 0 0 1-2-2z" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="9" y1="12" x2="15" y2="12" />
  </svg>
);

const FilesIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const AgentsIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l1.8 5.4L19.5 10l-5.7 1.6L12 17l-1.8-5.4L4.5 10l5.7-1.6z" />
  </svg>
);

type Station = {
  id: string;
  label: string;
  /// Either a single text glyph or a ReactNode (inline SVG). Most
  /// stations use a unicode character for consistency; People is
  /// SVG because no plain-text option reads as "person" cleanly.
  glyph: ReactNode;
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
  { id: "inbox", label: "Tickets Inbox", glyph: InboxIcon, rel: "databases/tickets", countMode: "json-rows" },
  { id: "reports", label: "Reports", glyph: ReportsIcon, rel: "reports", countMode: "files" },
  { id: "people", label: "People", glyph: PersonIcon, rel: "databases/people", countMode: "json-rows" },
  { id: "knowledge", label: "Knowledge", glyph: KnowledgeIcon, rel: "knowledge-bases", countMode: "dirs" },
  { id: "files", label: "Files", glyph: FilesIcon, rel: "filestores", countMode: "dirs" },
  { id: "agents", label: "Agents", glyph: AgentsIcon, rel: "agents", countMode: "json-rows" },
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
  onShowFiles,
}: {
  repo: string | null;
  fsTick: number;
  onOpen: (path: string) => void;
  /** Switch the parent to the Explorer (file tree) tab. */
  onShowFiles: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [escalatedCount, setEscalatedCount] = useState(0);

  useEffect(() => {
    if (!repo) {
      setCounts({});
      setEscalatedCount(0);
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
      // "Unresolved" === escalated for today-hero purposes. Open
      // tickets are still being worked by the agent, resolved /
      // closed are done; only escalated demands the admin's
      // attention, so that's what the hero counts.
      try {
        const esc = await scanEscalatedTickets(repo);
        if (!cancelled) setEscalatedCount(esc.length);
      } catch {
        if (!cancelled) setEscalatedCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, fsTick]);

  return (
    <div className="workbench">
      <div className="workbench-today">
        <div className="workbench-today-eyebrow">TODAY</div>
        {escalatedCount === 0 ? (
          <div className="workbench-today-hero workbench-today-hero-clean">
            <span className="workbench-today-clean">Clean inbox. Congrats!</span>
          </div>
        ) : (
          <div className="workbench-today-hero">
            <span className="workbench-today-number">{escalatedCount}</span>
            <span className="workbench-today-label">
              unresolved ticket{escalatedCount === 1 ? "" : "s"}
            </span>
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
        className="workbench-files-toggle"
        onClick={onShowFiles}
      >
        <span className="workbench-files-caret">▸</span>
        <span>Browse files</span>
        <span className="workbench-files-hint">advanced</span>
      </button>
    </div>
  );
}
