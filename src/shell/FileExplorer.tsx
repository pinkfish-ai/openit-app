import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fsList,
  fsReveal,
  gitStatusShort,
  kbDeleteFile,
  kbWriteFileBytes,
  type FileNode,
  type GitFileStatus,
} from "../lib/api";
import { refreshFromServer, subscribeSync, type SyncStatus } from "../lib/kbSync";
import { subscribeFilestoreSync, type FilestoreSyncStatus } from "../lib/filestoreSync";
import { loadCreds } from "../lib/pinkfishAuth";
import { resolveProjectDatastores, fetchDatastoreItems, syncDatastoresToDisk } from "../lib/datastoreSync";
import { resolveProjectAgents, syncAgentsToDisk, type Agent } from "../lib/agentSync";
import { resolveProjectWorkflows, syncWorkflowsToDisk, type Workflow } from "../lib/workflowSync";
import type { DataCollection, MemoryItem } from "../lib/skillsApi";

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

const KB_SUPPORTED_EXTENSIONS = new Set([
  "pdf", "txt", "md", "markdown", "json", "csv",
  "docx", "xlsx", "pptx",
  "jpg", "jpeg", "png", "gif", "webp",
]);

function setEntityDrag(e: React.DragEvent, ref: string) {
  e.dataTransfer.setData("application/x-openit-ref", ref);
  e.dataTransfer.setData("text/plain", ref);
  e.dataTransfer.effectAllowed = "copy";
}

function isKbSupported(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return KB_SUPPORTED_EXTENSIONS.has(ext);
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
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [rejectedFiles, setRejectedFiles] = useState<string[]>([]);
  const [gitRows, setGitRows] = useState<GitFileStatus[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // Virtual resource state
  const [datastores, setDatastores] = useState<DataCollection[]>([]);
  const [datastoreItems, setDatastoreItems] = useState<
    Record<string, { items: MemoryItem[]; hasMore: boolean }>
  >({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  // (loadingResources removed — initial load is fast enough)

  const [fsSync, setFsSync] = useState<FilestoreSyncStatus | null>(null);
  useEffect(() => subscribeSync(setSync), []);
  useEffect(() => subscribeFilestoreSync(setFsSync), []);

  const reload = useCallback(() => {
    if (!repo) {
      setNodes([]);
      return;
    }
    fsList(repo)
      .then((n) => {
        setNodes(n);
        setError(null);
        // Collapse all dirs on first load only
        if (!hasCollapsedOnceRef.current && n.length > 0) {
          hasCollapsedOnceRef.current = true;
          setCollapsed(new Set(n.filter((nd) => nd.is_dir).map((nd) => nd.path)));
        }
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
    if (fsSync?.phase === "ready") reload();
  }, [fsSync?.phase, fsSync?.lastPullAt, reload]);

  // Git status polling
  useEffect(() => {
    if (!repo) {
      setGitRows([]);
      return;
    }
    const tick = () => {
      gitStatusShort(repo)
        .then(setGitRows)
        .catch(() => setGitRows([]));
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, [repo]);

  const initialLoadDoneRef = useRef(false);
  const hasCollapsedOnceRef = useRef(false);

  // Load resources once on mount, write to disk, then set up silent background polling
  useEffect(() => {
    let cancelled = false;

    async function loadOnce() {
      const creds = await loadCreds();
      if (!creds || cancelled) return;

      try {
        const [ds, ag, wf] = await Promise.all([
          resolveProjectDatastores(creds).catch(() => [] as DataCollection[]),
          resolveProjectAgents(creds).catch(() => [] as Agent[]),
          resolveProjectWorkflows(creds).catch(() => [] as Workflow[]),
        ]);
        if (cancelled) return;
        setDatastores(ds);
        setAgents(ag);
        setWorkflows(wf);

        const itemsMap: Record<string, { items: MemoryItem[]; hasMore: boolean }> = {};
        await Promise.all(
          ds.map(async (col) => {
            try {
              const resp = await fetchDatastoreItems(creds, col.id, 100, 0);
              itemsMap[col.id] = { items: resp.items, hasMore: resp.pagination.hasNextPage };
            } catch {
              itemsMap[col.id] = { items: [], hasMore: false };
            }
          }),
        );
        if (cancelled) return;
        setDatastoreItems(itemsMap);

        // Write to disk on initial load only
        if (repo) {
          await Promise.all([
            syncDatastoresToDisk(repo, ds, itemsMap).catch(() => {}),
            syncAgentsToDisk(repo, ag).catch(() => {}),
            syncWorkflowsToDisk(repo, wf).catch(() => {}),
          ]);
          reload();
        }
        initialLoadDoneRef.current = true;
      } catch (e) {
        console.warn("[FileExplorer] loadOnce failed:", e);
      }
    }

    // Background poll — update state silently, no disk writes, no reload
    async function pollSilently() {
      if (!initialLoadDoneRef.current) return;
      const creds = await loadCreds();
      if (!creds || cancelled) return;
      try {
        const [ds, ag, wf] = await Promise.all([
          resolveProjectDatastores(creds).catch(() => [] as DataCollection[]),
          resolveProjectAgents(creds).catch(() => [] as Agent[]),
          resolveProjectWorkflows(creds).catch(() => [] as Workflow[]),
        ]);
        if (cancelled) return;
        setDatastores(ds);
        setAgents(ag);
        setWorkflows(wf);
      } catch { /* silent */ }
    }

    loadOnce();
    const interval = setInterval(pollSilently, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

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
    const targetPath = dropTargetPath;
    setDropTargetPath(null);
    setRejectedFiles([]);
    if (!repo) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;

    // Determine which directory was the drop target
    const targetRel = targetPath ? relPath(repo, targetPath) : null;
    const isFilestoreTarget = targetRel?.startsWith("filestore") ?? false;

    if (isFilestoreTarget) {
      // Drop into filestore — no file type restriction
      for (const f of files) {
        try {
          const buf = await f.arrayBuffer();
          const { fsStoreWriteFileBytes } = await import("../lib/api");
          await fsStoreWriteFileBytes(repo, f.name, buf);
        } catch (err) {
          console.error(`failed to import ${f.name} to filestore:`, err);
        }
      }
      reload();
      return;
    }

    // Default: drop into knowledge-base with file type filtering
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (isKbSupported(f.name)) {
        accepted.push(f);
      } else {
        rejected.push(f.name);
      }
    }
    if (rejected.length > 0) setRejectedFiles(rejected);

    for (const f of accepted) {
      try {
        const buf = await f.arrayBuffer();
        await kbWriteFileBytes(repo, f.name, buf);
      } catch (err) {
        console.error(`failed to import ${f.name}:`, err);
      }
    }
    if (accepted.length > 0) reload();
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

  const KB_PREFIX = "knowledge-base/";
  const isDeletable = (node: FileNode) => {
    if (node.is_dir || !repo) return false;
    return relPath(repo, node.path).startsWith(KB_PREFIX);
  };

  const handleDelete = async (node: FileNode) => {
    if (!isDeletable(node) || !repo) return;
    const filename = relPath(repo, node.path).slice(KB_PREFIX.length);
    await kbDeleteFile(repo, filename);
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
        {/* Real file tree */}
        {visible.map((n) => {
          const rel = n.path.startsWith(repo + "/") ? n.path.slice(repo.length + 1) : n.name;
          const depth = rel.split("/").length - 1;
          const isCollapsedRow = collapsed.has(n.path);
          const colorClass = repo ? fileColorClass(n, repo, gitRows) : "";
          const badge = repo ? fileStatusBadge(n, repo, gitRows) : null;
          return (
            <li
              key={n.path}
              className={`tree-item ${n.is_dir ? "dir" : "file"} ${colorClass}${dropTargetPath === n.path ? " drop-target" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, path: n.path });
              }}
              onDragOver={(e) => {
                if (n.is_dir && e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "copy";
                  setDropTargetPath(n.path);
                }
              }}
              onDragLeave={() => {
                if (dropTargetPath === n.path) setDropTargetPath(null);
              }}
              onClick={() => {
                if (n.is_dir) {
                  toggle(n.path);
                  // Also open table view for database collection directories
                  if (rel.match(/^databases\/[^/]+$/)) {
                    onSelect(n.path);
                  }
                  return;
                }
                onSelect(n.path);
              }}
              draggable={!n.is_dir || rel.match(/^databases\/[^/]+$/) !== null}
              onDragStart={(e) => {
                // Database collection directory drag
                if (n.is_dir) {
                  const dbMatch = rel.match(/^databases\/([^/]+)$/);
                  if (dbMatch) {
                    const col = datastores.find((d) => d.name === dbMatch[1]);
                    if (col) {
                      setEntityDrag(e, `[Pinkfish Datastore: ${col.name} (id: ${col.id}, type: structured datastore, fields: ${col.schema?.fields.map((f) => f.label).join(", ") ?? "unknown"})]`);
                    }
                  }
                  return;
                }
                // Entity-aware drag references
                if (rel.startsWith("agents/") && rel.endsWith(".json")) {
                  const agent = agents.find((a) => rel === `agents/${a.name.replace(/[/\\:*?"<>|]/g, "_")}.json`);
                  if (agent) { setEntityDrag(e, `[Pinkfish Agent: ${agent.name} (id: ${agent.id}${agent.description ? `, description: ${agent.description}` : ""})]`); return; }
                }
                if (rel.startsWith("workflows/") && rel.endsWith(".json")) {
                  const wf = workflows.find((w) => rel === `workflows/${w.name.replace(/[/\\:*?"<>|]/g, "_")}.json`);
                  if (wf) { setEntityDrag(e, `[Pinkfish Workflow: ${wf.name} (id: ${wf.id}${wf.description ? `, description: ${wf.description}` : ""})]`); return; }
                }
                if (rel.match(/^databases\/[^/]+\/[^/]+\.json$/)) {
                  const parts = rel.split("/");
                  const col = datastores.find((d) => d.name === parts[1]);
                  if (col) {
                    const rowKey = parts[2].replace(/\.json$/, "");
                    const item = datastoreItems[col.id]?.items.find((i) => (i.key || i.id) === rowKey);
                    if (item) { setEntityDrag(e, `[Pinkfish Datastore Row: ${col.name}/${rowKey} (datastore: ${col.name}, id: ${item.id}, content: ${JSON.stringify(typeof item.content === "object" ? item.content : item.content)})]`); return; }
                  }
                }
                // Default: file path
                e.dataTransfer.setData("application/x-openit-path", n.path);
                e.dataTransfer.setData("text/plain", n.path);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              {n.is_dir ? (isCollapsedRow ? "▸ " : "▾ ") : ""}
              <span className="tree-item-name">{n.name}</span>
              {badge && <span className={`tree-badge ${colorClass}`}>{badge}</span>}
              {isDeletable(n) && (
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

        {/* No virtual sections — entities are written to disk and appear in the real tree */}
      </ul>

      {/* Rejected files message */}
      {rejectedFiles.length > 0 && (
        <div className="kb-conflicts">
          <div className="kb-conflicts-header">Unsupported files skipped</div>
          <ul>
            {rejectedFiles.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="explorer-toggle"
            onClick={() => setRejectedFiles([])}
            style={{ marginTop: 4 }}
          >
            Dismiss
          </button>
        </div>
      )}

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
      {contextMenu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              className="context-menu-item"
              onClick={() => {
                fsReveal(contextMenu.path).catch(console.error);
                setContextMenu(null);
              }}
            >
              Reveal in Finder
            </button>
          </div>
        </>
      )}
    </div>
  );
}
