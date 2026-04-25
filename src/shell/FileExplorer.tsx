import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fsList,
  kbStateLoad,
  kbWriteFileBytes,
  type FileNode,
  type KbStatePersisted,
} from "../lib/api";
import { subscribeSync, type SyncStatus } from "../lib/kbSync";

const KB_DIRNAME = "knowledge-base";

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
  const [kbState, setKbState] = useState<KbStatePersisted | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => subscribeSync(setSync), []);

  const reload = useCallback(() => {
    if (!repo) {
      setNodes([]);
      setKbState(null);
      return;
    }
    fsList(repo)
      .then((n) => {
        setNodes(n);
        setError(null);
      })
      .catch((e) => setError(String(e)));
    kbStateLoad(repo).then(setKbState).catch(() => setKbState(null));
  }, [repo]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (sync?.phase === "ready") reload();
  }, [sync?.phase, sync?.lastPullAt, reload]);

  const visible = useMemo(() => {
    if (!repo) return [];
    return nodes.filter((n) => {
      for (const c of collapsed) {
        if (n.path !== c && n.path.startsWith(c + "/")) return false;
      }
      return true;
    });
  }, [nodes, collapsed, repo]);

  /// True when this node is a file under knowledge-base/ that hasn't been
  /// pushed yet (not in manifest) or has been edited since last sync (local
  /// mtime > pulled_at_mtime_ms).
  const isUnsynced = useCallback(
    (n: FileNode): boolean => {
      if (!repo || n.is_dir) return false;
      const kbPrefix = repo + "/" + KB_DIRNAME + "/";
      if (!n.path.startsWith(kbPrefix)) return false;
      if (!kbState) return true; // no manifest yet → treat as unsynced
      const filename = n.path.slice(kbPrefix.length);
      const tracked = kbState.files?.[filename];
      if (!tracked) return true; // never pushed/pulled
      // We don't have local mtime in FileNode (Rust fs_list doesn't return it).
      // For now: presence in manifest = synced. Modifications detect on next
      // poll/push when local mtime is read.
      return false;
    },
    [kbState, repo],
  );

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
      <div className="explorer-header">
        <span className="explorer-name">{repo.split("/").pop()}</span>
        <button
          type="button"
          className="explorer-toggle"
          onClick={reload}
          title="Refresh tree"
        >
          Refresh
        </button>
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
          const isCollapsedRow = collapsed.has(n.path);
          const unsynced = isUnsynced(n);
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
              {n.is_dir ? (isCollapsedRow ? "▸ " : "▾ ") : ""}
              {n.name}
              {unsynced && <span className="unsynced-dot" title="Not yet synced" />}
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
