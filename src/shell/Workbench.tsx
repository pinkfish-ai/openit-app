import { useEffect, useState, type ReactNode } from "react";
import { fsList, type FileNode } from "../lib/api";
import { scanEscalatedTickets } from "../lib/escalatedTickets";
import { EntityIcons } from "./entityIcons";

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
  // Use the shared EntityIcons map so the station glyphs match the
  // EntityCardGrid icons in the center pane viewer. Upstream renamed
  // this label to "Inbox" — keep that change.
  { id: "inbox", label: "Inbox", glyph: EntityIcons.inbox, rel: "databases/tickets", countMode: "json-rows" },
  { id: "reports", label: "Reports", glyph: EntityIcons.reports, rel: "reports", countMode: "files" },
  { id: "people", label: "People", glyph: EntityIcons.people, rel: "databases/people", countMode: "json-rows" },
  { id: "knowledge", label: "Knowledge", glyph: EntityIcons.knowledge, rel: "knowledge-bases", countMode: "dirs" },
  { id: "files", label: "Files", glyph: EntityIcons.files, rel: "filestores", countMode: "dirs" },
  { id: "agents", label: "Agents", glyph: EntityIcons.agents, rel: "agents", countMode: "json-rows" },
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

  // Today card click → open the Tickets Inbox station so the admin
  // can act on the escalated set immediately.
  const inboxStation = STATIONS.find((s) => s.id === "inbox")!;
  const openInbox = () => {
    if (repo) onOpen(`${repo}/${inboxStation.rel}`);
  };

  return (
    <div className="workbench">
      <button
        type="button"
        className="workbench-today"
        onClick={openInbox}
        disabled={!repo}
        title={
          escalatedCount > 0
            ? "Open the Tickets Inbox"
            : "Open the Tickets Inbox (nothing waiting)"
        }
      >
        <span className="workbench-today-eyebrow">TODAY</span>
        {escalatedCount === 0 ? (
          <span className="workbench-today-hero workbench-today-hero-clean">
            <span className="workbench-today-clean">Clean inbox. Congrats!</span>
          </span>
        ) : (
          <span className="workbench-today-hero">
            <span className="workbench-today-number">{escalatedCount}</span>
            <span className="workbench-today-label">
              unresolved ticket{escalatedCount === 1 ? "" : "s"}
            </span>
          </span>
        )}
      </button>

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
        <span>File explorer</span>
        <span className="workbench-files-hint">advanced</span>
      </button>
    </div>
  );
}
