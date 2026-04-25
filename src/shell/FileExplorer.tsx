import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fsList,
  gitStatusShort,
  kbDeleteFile,
  kbWriteFileBytes,
  type FileNode,
  type GitFileStatus,
} from "../lib/api";
import { refreshFromServer, subscribeSync, type SyncStatus } from "../lib/kbSync";

function relPath(repo: string, absPath: string): string {
  const prefix = `${repo}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function gitStatusForPath(rel: string, rows: GitFileStatus[]): GitFileStatus | undefined {
  const direct = rows.find((r) => r.path === rel);
  if (direct) return direct;
  return rows.find((r) => rel.startsWith(`${r.path}/`));
}

function fileColorClass(n: FileNode, repo: string, gitRows: GitFileStatus[]): string {
  if (n.is_dir) return "";
  const rel = relPath(repo, n.path);
  if (rel.includes(".server.")) return "file-color-conflict";
  const st = gitStatusForPath(rel, gitRows);
  if (!st) return "";
  if (st.status === "UU") return "file-color-conflict";
  if (st.status === "?") return "file-color-untracked";
  if (st.status === "M") return "file-color-modified";
  if (st.status === "A") return "file-color-added";
  if (st.status === "D") return "file-color-deleted";
  return "";
}

function fileStatusBadge(n: FileNode, repo: string, gitRows: GitFileStatus[]): string | null {
  if (n.is_dir) return null;
  const rel = relPath(repo, n.path);
  if (rel.includes(".server.")) return "C";
  const st = gitStatusForPath(rel, gitRows);
  if (!st) return null;
  if (st.status === "UU") return "C";
  if (st.status === "?") return "U";
  if (st.status === "M") return "M";
  if (st.status === "A") return "A";
  if (st.status === "D") return "D";
  return null;
}

export function FileExplorer({
  repo,
  onSelect,
  fsTick,
  onFsChange,
}: {
  repo: string | null;
  onSelect: (path: string) => void;
  fsTick?: number;
  onFsChange?: () => void;
}) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [gitRows, setGitRows] = useState<GitFileStatus[]>([]);

  useEffect(() => subscribeSync(setSync), []);

  const reload = useCallback(() => {
    if (!repo) {
      setNodes([]);
      return;
    }
    fsList(repo)
      .then((n) => {
        setNodes(n);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [repo]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshFromServer();
    } finally {
      reload();
      onFsChange?.();
      setRefreshing(false);
    }
  }, [reload, onFsChange]);

  useEffect(() => {
    reload();
  }, [reload, fsTick]);

  useEffect(() => {
    if (sync?.phase === "ready") reload();
  }, [sync?.phase, sync?.lastPullAt, reload]);

  useEffect(() => {
    if (!repo) {
      setGitRows([]);
      return;
    }
    const tick = () => {
      gitStatusShort(repo)
        .then(setGitRows)
        .catch(() => setGitRows([]));
      reload();
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, [repo, reload]);

  const visible = useMemo(() => {
    if (!repo) return [];
    return nodes.filter((n) => {
      for (const c of collapsed) {
        if (n.path !== c && n.path.startsWith(c + "/")) return false;
      }
      return true;
    });
  }, [nodes, collapsed, repo]);

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (!repo) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        await kbWriteFileBytes(repo, f.name, buf);
      } catch (err) {
        console.error(`failed to import ${f.name}:`, err);
      }
    }
    reload();
  };

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

  const handleDelete = async (node: FileNode) => {
    if (node.is_dir || !repo) return;
    const rel = relPath(repo, node.path);
    const kbPrefix = "knowledge-base/";
    if (rel.startsWith(kbPrefix)) {
      const filename = rel.slice(kbPrefix.length);
      await kbDeleteFile(repo, filename);
    }
    reload();
    onFsChange?.();
  };

  const allDirs = nodes.filter((n) => n.is_dir).map((n) => n.path);
  const allCollapsed = allDirs.length > 0 && allDirs.every((d) => collapsed.has(d));
  const toggleAll = () => {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(allDirs));
  };

  return (
    <div
      className={`explorer ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="explorer-toolbar">
        <button type="button" className="explorer-icon-btn" onClick={handleRefresh} disabled={refreshing} title="Sync from Pinkfish &amp; refresh">{refreshing ? "⟳" : "↻"}</button>
        <button type="button" className="explorer-icon-btn" onClick={toggleAll} title={allCollapsed ? "Expand all" : "Collapse all"}>
          {allCollapsed ? "⊞" : "⊟"}
        </button>
      </div>
      <ul className="tree">
        {visible.map((n) => {
          const rel = n.path.startsWith(repo + "/") ? n.path.slice(repo.length + 1) : n.name;
          const depth = rel.split("/").length - 1;
          const isCollapsedRow = collapsed.has(n.path);
          const colorClass = repo ? fileColorClass(n, repo, gitRows) : "";
          const badge = repo ? fileStatusBadge(n, repo, gitRows) : null;
          return (
            <li
              key={n.path}
              className={`tree-item ${n.is_dir ? "dir" : "file"} ${colorClass}`}
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
              {n.is_dir ? (isCollapsedRow ? "▸ " : "▾ ") : ""}
              <span className="tree-item-name">{n.name}</span>
              {badge && <span className={`tree-badge ${colorClass}`}>{badge}</span>}
              {!n.is_dir && (
                <button
                  type="button"
                  className="tree-delete-btn"
                  title={`Delete ${n.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(n);
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {sync && sync.conflicts.length > 0 && (
        <div className="kb-conflicts">
          <div className="kb-conflicts-header">Merge conflicts</div>
          <p className="kb-conflicts-hint">
            Server copies saved as <code>*.server.*</code> next to yours. Use the{" "}
            <strong>Resolve merge conflicts</strong> prompt below Claude, then delete the shadow
            files when done.
          </p>
          <ul>
            {sync.conflicts.map((c) => (
              <li key={c.filename}>
                <button
                  type="button"
                  className="kb-conflict-link"
                  onClick={() =>
                    onSelect(`${repo}/knowledge-base/${c.filename}`)
                  }
                >
                  <code>{c.filename}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
