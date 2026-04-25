import { useEffect, useMemo, useState } from "react";
import { fsList, type FileNode } from "../lib/api";
import { subscribeSync, type SyncStatus } from "../lib/kbSync";

export function FileExplorer({
  repo,
  onSelect,
}: {
  repo: string | null;
  onSelect: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sync, setSync] = useState<SyncStatus | null>(null);

  useEffect(() => subscribeSync(setSync), []);

  useEffect(() => {
    if (!repo) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    fsList(repo)
      .then((n) => {
        if (!cancelled) {
          setNodes(n);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const visible = useMemo(() => {
    if (!repo) return [];
    const collapsedPaths = collapsed;
    return nodes.filter((n) => {
      // Hide if any ancestor dir is collapsed.
      for (const c of collapsedPaths) {
        if (n.path !== c && n.path.startsWith(c + "/")) return false;
      }
      return true;
    });
  }, [nodes, collapsed, repo]);

  if (!repo) {
    return <div className="explorer empty">No project folder open</div>;
  }
  if (error) {
    return <div className="explorer error">{error}</div>;
  }

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const allDirs = nodes.filter((n) => n.is_dir).map((n) => n.path);
  const allCollapsed = allDirs.length > 0 && allDirs.every((d) => collapsed.has(d));
  const toggleAll = () => {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(allDirs));
  };

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span className="explorer-name">{repo.split("/").pop()}</span>
        <button
          type="button"
          className="explorer-toggle"
          onClick={toggleAll}
          title={allCollapsed ? "Expand all" : "Collapse all"}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
      <ul className="tree">
        {visible.map((n) => {
          const rel = n.path.startsWith(repo + "/") ? n.path.slice(repo.length + 1) : n.name;
          const depth = rel.split("/").length - 1;
          const isCollapsed = collapsed.has(n.path);
          return (
            <li
              key={n.path}
              className={n.is_dir ? "tree-item dir" : "tree-item file"}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => (n.is_dir ? toggle(n.path) : onSelect(n.path))}
              draggable={!n.is_dir}
              onDragStart={(e) => {
                if (n.is_dir) return;
                e.dataTransfer.setData("application/x-openit-path", n.path);
                e.dataTransfer.setData("text/plain", n.path);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              {n.is_dir ? (isCollapsed ? "▸ " : "▾ ") : ""}
              {n.name}
            </li>
          );
        })}
      </ul>
      {sync && sync.conflicts.length > 0 && (
        <div className="kb-conflicts">
          <div className="kb-conflicts-header">⚠ KB conflicts</div>
          <ul>
            {sync.conflicts.map((c) => (
              <li key={c.filename}>
                <code>{c.filename}</code> edited locally and remotely. Rename your local copy to keep it.
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
