import { useEffect, useMemo, useRef, useState } from "react";
import { fsList, type FileNode } from "../lib/api";

/**
 * Cmd-P file/folder picker — VS Code's "Go to file" without the
 * fuzzy ranking complexity. Loads the project file list once on
 * open, filters case-insensitively as the user types, Enter or
 * click opens the selection in the viewer.
 */
export function FileSearchPalette({
  open,
  repo,
  onClose,
  onOpenPath,
}: {
  open: boolean;
  repo: string | null;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refresh the file list every time the palette opens. fs_list is
  // recursive (depth 6), which covers the typical OpenIT project
  // layout. Cheap enough to re-run on each open vs. cache + invalidate.
  useEffect(() => {
    if (!open || !repo) return;
    let cancelled = false;
    setLoading(true);
    fsList(repo)
      .then((nodes) => {
        if (cancelled) return;
        // Drop noise — dotfiles (.git, .openit, .DS_Store), schema
        // sentinels, and conflict shadow files. The user is looking
        // for THEIR content, not git internals.
        const filtered = nodes.filter((n) => {
          if (n.name.startsWith(".")) return false;
          if (n.name === "_schema.json") return false;
          if (n.name.includes(".server.")) return false;
          return true;
        });
        setItems(filtered);
      })
      .catch((e) => {
        console.warn("[file-search] fsList failed:", e);
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repo]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Per-item search input: rel path lowercased + name lowercased.
  // The query is split into tokens, ALL must appear (anywhere) for
  // the item to match. Keeps it intuitive — typing "ag tri" finds
  // "agents/triage.json" without needing exact prefix.
  const filtered = useMemo(() => {
    if (!repo) return [] as FileNode[];
    const tokens = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return items.slice(0, 50);
    return items
      .filter((n) => {
        const hay = (
          relPath(n.path, repo) +
          " " +
          n.name
        ).toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
      .slice(0, 50);
  }, [items, query, repo]);

  if (!open) return null;

  const runActive = () => {
    const item = filtered[active];
    if (!item) return;
    onClose();
    onOpenPath(item.path);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-search">
          <span className="cmdk-search-icon" aria-hidden>
            ⌘P
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Find a file or folder…"
          />
          <span className="cmdk-esc" onClick={onClose}>
            esc
          </span>
        </div>
        <div className="cmdk-list">
          {!repo ? (
            <div className="cmdk-empty">No project open.</div>
          ) : loading && items.length === 0 ? (
            <div className="cmdk-empty">Indexing…</div>
          ) : filtered.length === 0 ? (
            <div className="cmdk-empty">
              No matches.{" "}
              {query.trim() ? (
                <em>Try fewer or different words.</em>
              ) : (
                <em>Project is empty.</em>
              )}
            </div>
          ) : (
            filtered.map((item, idx) => {
              const rel = relPath(item.path, repo);
              const dir = rel.includes("/")
                ? rel.slice(0, rel.lastIndexOf("/"))
                : "";
              return (
                <button
                  key={item.path}
                  type="button"
                  className={`cmdk-item file-search-item ${
                    idx === active ? "active" : ""
                  }`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => {
                    setActive(idx);
                    runActive();
                  }}
                >
                  <span className="file-search-glyph" aria-hidden>
                    {item.is_dir ? "▸" : "·"}
                  </span>
                  <span className="cmdk-item-label">{item.name}</span>
                  {dir && (
                    <span className="cmdk-item-hint file-search-dir">
                      {dir}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="cmdk-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span className="cmdk-footer-brand">files</span>
        </div>
      </div>
    </div>
  );
}

function relPath(abs: string, repo: string): string {
  const root = repo.endsWith("/") ? repo : repo + "/";
  return abs.startsWith(root) ? abs.slice(root.length) : abs;
}
