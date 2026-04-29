import { useEffect, useState } from "react";
import { fsList, type FileNode } from "../lib/api";
import { scanEscalatedTickets } from "../lib/escalatedTickets";
import { listInstalled as listInstalledTools } from "../lib/toolsInstall";
import { ENTITY_META, type EntityKind } from "./entityIcons";

type Station = {
  id: string;
  /** Which entry in ENTITY_META drives the icon, tone, and label. */
  kind: EntityKind;
  /** Path relative to repo root. */
  rel: string;
  /** If set, opens this child path on click instead of `rel`. */
  openRel?: string;
  /** What to count among direct children. */
  countMode: "dirs" | "json-rows" | "files";
  /** When set, the station only renders if `visibleIf(state)` returns
   *  true. Used by the `databases` station to appear only when the
   *  user has custom (non-default) datastores. */
  visibleIf?: (counts: Record<string, number>) => boolean;
};

/// Local-only system folders under `databases/` that don't count as
/// "custom datastores" for the visibility predicate. Mirrors the same
/// list in datastoreSync.ts.
const DATABASES_SYSTEM_FOLDERS = new Set(["conversations"]);
const DATABASES_DEFAULT_FOLDERS = new Set(["tickets", "people"]);

// Each station's icon, tone, and label come from ENTITY_META — same
// source the EntityCardGrid cards and Viewer headers consume, so
// "Tickets" is "Tickets" everywhere with one icon and one color.
const STATIONS: Station[] = [
  { id: "inbox",     kind: "inbox",     rel: "databases/tickets", countMode: "json-rows" },
  { id: "reports",   kind: "reports",   rel: "reports",           countMode: "files" },
  { id: "people",    kind: "people",    rel: "databases/people",  countMode: "json-rows" },
  // Phase 3: appears only when the user has at least one custom
  // (non-default) datastore — i.e. anything under `databases/` other
  // than `tickets`, `people`, or system folders like `conversations`.
  // Click opens the `databases/` parent dir; FileExplorer renders the
  // existing tree view of all subfolders.
  { id: "databases", kind: "databases", rel: "databases",         countMode: "dirs",
    visibleIf: (c) => (c.databases ?? 0) > 0 },
  { id: "knowledge", kind: "knowledge", rel: "knowledge-bases",   countMode: "dirs" },
  { id: "files",     kind: "files",     rel: "filestores",        countMode: "dirs" },
  { id: "agents",    kind: "agents",    rel: "agents",            countMode: "json-rows" },
  // Tools is synthetic — no on-disk directory at all (so it doesn't
  // appear in the file explorer; only reachable via this station).
  // Count comes from `which`-detected tools.
  { id: "tools",     kind: "tools",     rel: "tools",             countMode: "files" },
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
  /** Switch the parent's left pane into the file-tree view. The
   *  Explorer is no longer a top-tab, so this is the only path to
   *  the raw file tree from Overview. Keep this. */
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
          // Tools is a synthetic station — counted from `which`
          // detection per catalog entry, not from a real directory.
          if (s.id === "tools") {
            try {
              const ids = await listInstalledTools();
              next[s.id] = ids.size;
            } catch {
              next[s.id] = 0;
            }
            return;
          }
          try {
            const rootAbs = `${repo}/${s.rel}`;
            const items = await fsList(rootAbs);
            const direct = directChildren(items, rootAbs);
            let count = countWithMode(direct, s.countMode);
            // The `databases` station counts only CUSTOM datastores —
            // anything other than the two defaults (`tickets`, `people`)
            // and system folders (`conversations`). Visibility hinges on
            // count > 0, so excluding those here flips the tile off
            // whenever the user only has defaults.
            if (s.id === "databases") {
              count = direct.filter(
                (n) =>
                  n.is_dir &&
                  !n.name.startsWith(".") &&
                  !DATABASES_DEFAULT_FOLDERS.has(n.name) &&
                  !DATABASES_SYSTEM_FOLDERS.has(n.name),
              ).length;
            }
            next[s.id] = count;
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
        {STATIONS.filter((s) => !s.visibleIf || s.visibleIf(counts)).map((s) => {
          const meta = ENTITY_META[s.kind];
          return (
            <button
              key={s.id}
              type="button"
              className={`station entity-tone-${meta.tone}`}
              onClick={() => repo && onOpen(`${repo}/${s.openRel ?? s.rel}`)}
              title={meta.label}
            >
              <span className="station-glyph" aria-hidden>
                {meta.icon}
              </span>
              <span className="station-body">
                <span className="station-label">{meta.label}</span>
                <span className="station-count">{counts[s.id] ?? "·"}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/*
       * File-tree entry point — DO NOT REMOVE.
       *
       * This link is the ONLY user-facing path to the raw file
       * explorer. The Explorer left-tab was removed deliberately;
       * the Overview pane (Workbench + station cards) is the
       * canonical surface, and admins who need the file tree drop
       * into it via this "advanced" affordance.
       *
       * Past cleanup passes have removed this link assuming the
       * Explorer top-tab is the canonical entry — it is not. If
       * you're tempted to delete this, restore the Explorer
       * top-tab in Shell.tsx FIRST. Without one of the two,
       * `.openit/agent-traces/`, `.claude/`, and arbitrary
       * project files become unreachable.
       */}
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
