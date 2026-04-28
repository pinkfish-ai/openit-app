import { useEffect, useMemo, useState } from "react";
import { fsList } from "../lib/api";
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
};

const STATIONS: Station[] = [
  { id: "inbox", label: "Inbox", glyph: "✉", rel: "databases/conversations" },
  { id: "tickets", label: "Tickets", glyph: "◉", rel: "databases/tickets" },
  { id: "people", label: "People", glyph: "◔", rel: "databases/people" },
  { id: "knowledge", label: "Knowledge", glyph: "❋", rel: "knowledge-bases" },
  { id: "files", label: "Files", glyph: "▤", rel: "filestores" },
  { id: "agents", label: "Agents", glyph: "✦", rel: "agents" },
];

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
  const [filesExpanded, setFilesExpanded] = useState(false);

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
            const items = await fsList(`${repo}/${s.rel}`);
            // Filter out hidden/system files for the count.
            next[s.id] = items.filter((i) => !i.name.startsWith(".")).length;
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
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, fsTick]);

  const queueCount = useMemo(
    () => counts["inbox"] ?? 0,
    [counts],
  );

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
        <div className="workbench-today-hero">
          <span className="workbench-today-number">{queueCount}</span>
          <span className="workbench-today-label">
            {queueCount === 1 ? "thread in your inbox" : "threads in your inbox"}
          </span>
        </div>
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
