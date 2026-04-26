import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fsDelete,
  fsList,
  fsReveal,
  gitAddAndCommit,
  gitStatusShort,
  kbDeleteFile,
  kbWriteFileBytes,
  type FileNode,
  type GitFileStatus,
} from "../lib/api";
import { subscribeSync, type SyncStatus } from "../lib/kbSync";
import { subscribeFilestoreSync, type FilestoreSyncStatus } from "../lib/filestoreSync";
import { loadCreds } from "../lib/pinkfishAuth";
import { resolveProjectDatastores, fetchDatastoreItems, fetchDatastoreSchema } from "../lib/datastoreSync";
import { resolveProjectAgents, type Agent } from "../lib/agentSync";
import { resolveProjectWorkflows, type Workflow } from "../lib/workflowSync";
import { syncSkillsToDisk } from "../lib/skillsSync";
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

/**
 * Display-only name transform. The actual on-disk folder name is the
 * collection's full Pinkfish name (e.g. `openit-people-653713545258`),
 * but in the tree we strip the `openit-` prefix and the trailing
 * `-<orgId>` so users see just `people` / `tickets`. Only applies to
 * top-level `databases/openit-*` directories — leaves filenames inside
 * them untouched.
 */
/// Pick the field whose value is the human-meaningful label for a row.
/// Priority: case-number-like → email → name/title/subject → first string
/// field. Returns the field id (e.g. "f_2") or null if no string fields.
function pickDisplayFieldId(
  schema: { fields?: Array<{ id?: string; label?: string; type?: string }> } | undefined,
): string | null {
  const fields = schema?.fields;
  if (!fields || fields.length === 0) return null;
  const matchers: RegExp[] = [
    /case\s*number|ticket\s*id|^id$|^number$/i,
    /email/i,
    /^name$|title|subject/i,
  ];
  for (const re of matchers) {
    const m = fields.find(
      (f) =>
        typeof f.label === "string" &&
        re.test(f.label) &&
        (f.type === "string" || f.type === undefined) &&
        f.id,
    );
    if (m?.id) return m.id;
  }
  // Fall back to first string field with an id.
  const first = fields.find((f) => f.id && (f.type === "string" || f.type === undefined));
  return first?.id ?? null;
}

const ROW_LABEL_MAX = 40;

function truncate(s: string): string {
  if (s.length <= ROW_LABEL_MAX) return s;
  return s.slice(0, ROW_LABEL_MAX - 1) + "…";
}

/// Display name for a tree node. Defaults to the filename, but rewrites:
///   - collection dirs `databases/openit-foo-12345/` → `foo`
///   - row files inside those `<key>.json` → label from a schema-picked
///     field (email for people, case number for tickets, etc.). Falls
///     back to the filename when content / schema isn't available.
function prettyName(
  name: string,
  rel: string,
  datastores: DataCollection[] = [],
  datastoreItems: Record<string, { items: MemoryItem[]; hasMore: boolean }> = {},
): string {
  if (rel.match(/^databases\/openit-[^/]+$/)) {
    const stripped = name.replace(/^openit-/, "").replace(/-\d+$/, "");
    if (stripped) return stripped;
  }
  // Row file: databases/<col>/<key>.json
  const rowMatch = rel.match(/^databases\/([^/]+)\/([^/]+)\.json$/);
  if (rowMatch && rowMatch[2] !== "_schema" && !name.includes(".server.")) {
    const colName = rowMatch[1];
    const rowKey = rowMatch[2];
    const col = datastores.find((d) => d.name === colName);
    if (col) {
      const fieldId = pickDisplayFieldId(col.schema);
      if (fieldId) {
        const item = datastoreItems[col.id]?.items.find(
          (i) => (i.key || i.id) === rowKey,
        );
        const content = item?.content;
        if (content && typeof content === "object") {
          const value = (content as Record<string, unknown>)[fieldId];
          if (typeof value === "string" && value.trim()) {
            return truncate(value.trim());
          }
        }
      }
    }
  }
  return name;
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

function isKbSupported(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return KB_SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * COLLECTION LOADING & SYNC PROCESS
 * 
 * 1. ON FIRST CONNECT (user enters Pinkfish credentials):
 *    - loadOnce() fires in background (does NOT block UI)
 *    - Resolves collections: fetches /datacollection/all, creates defaults if missing
 *    - Collections with eventual consistency: 2-sec delay before re-fetching to confirm
 *    - Fetches items and full schema for each collection in parallel
 *    - Enriches collections with schema for disk persistence
 *    - Writes to disk: databases/{name}/_schema.json + *.json for each item
 *    - UI updates progressively as data arrives (not blocked)
 * 
 * 2. EVERY 60 SECONDS (background polling):
 *    - pollSilently() runs in background
 *    - Re-resolves collections (creates if still missing due to API lag)
 *    - 10-second cooldown prevents duplicate creation attempts
 *    - Updates UI state if collections changed (no disk writes on poll)
 * 
 * 3. DUPLICATE PREVENTION:
 *    - In-memory cache tracks recently created collections
 *    - If collections not in API yet (eventual consistency), returns cached copy
 *    - 10-second cooldown before re-attempting creation
 *    - Avoids creating duplicates when API has lag
 * 
 * KEY: Collections are created via REST API POST /datacollection/
 * (NOT MCP tools). Schema comes from GET /datacollection/{id}.
 * Items fetched from /memory/bquery with includeSchema=true.
 */
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  // Two-click delete confirm — `window.confirm` is blocked by Tauri
  // permissions; this is the inline alternative. Click "Delete" once →
  // button changes to "Click again to confirm" → second click inside the
  // open menu actually deletes. Closing the menu (overlay click,
  // selecting another item) resets it.
  const [deleteArmed, setDeleteArmed] = useState(false);

  // Virtual resource state
  const [datastores, setDatastores] = useState<DataCollection[]>([]);
  const [datastoreItems, setDatastoreItems] = useState<
    Record<string, { items: MemoryItem[]; hasMore: boolean; schema?: any }>
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


  useEffect(() => {
    reload();
  }, [reload, fsTick]);

  useEffect(() => {
    if (sync?.phase === "ready") reload();
  }, [sync?.phase, sync?.lastPullAt, reload]);

  useEffect(() => {
    if (fsSync?.phase === "ready") reload();
  }, [fsSync?.phase, fsSync?.lastPullAt, reload]);

  // Git status — refreshes on fs watcher events (fsTick) instead of polling
  useEffect(() => {
    if (!repo) {
      setGitRows([]);
      return;
    }
    gitStatusShort(repo)
      .then(setGitRows)
      .catch(() => setGitRows([]));
  }, [repo, fsTick]);

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

        const itemsMap: Record<string, { items: MemoryItem[]; hasMore: boolean; schema?: any }> = {};
        await Promise.all(
          ds.map(async (col) => {
            try {
              console.log(`[FileExplorer] fetching items for datastore: ${col.name}`);
              const [resp, schema] = await Promise.all([
                fetchDatastoreItems(creds, col.id, 100, 0),
                fetchDatastoreSchema(creds, col.id).catch(() => undefined),
              ]);
              itemsMap[col.id] = { 
                items: resp.items, 
                hasMore: resp.pagination.hasNextPage, 
                schema: schema || resp.schema 
              };
              // Add schema to collection for writing to disk
              if (schema || resp.schema) {
                col.schema = schema || resp.schema;
              }
              console.log(`[FileExplorer] fetched ${resp.items.length} items for ${col.name}`);
            } catch (e) {
              console.warn(`[FileExplorer] failed to fetch items for ${col.name}:`, e);
              itemsMap[col.id] = { items: [], hasMore: false };
            }
          }),
        );
        if (cancelled) return;
        setDatastoreItems(itemsMap);

        // Disk-writing for all five entities now runs through their
        // engine-driven start*Sync calls (App.tsx + modal). FileExplorer
        // only keeps in-memory state for rendering the tree.
        if (repo) {
          await gitAddAndCommit(repo, "sync: update from Pinkfish").catch(() => {});
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
                setContextMenu({ x: e.clientX, y: e.clientY, path: n.path, isDir: n.is_dir });
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
                // Drop the file (or collection-directory) path as the
                // reference. Previously we built rich `[Pinkfish ...]`
                // blobs with id + content inline, but those clutter the
                // chat and Claude can read the path itself when it
                // needs the content.
                e.dataTransfer.setData("application/x-openit-path", n.path);
                e.dataTransfer.setData("text/plain", n.path);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              {n.is_dir ? (isCollapsedRow ? "▸ " : "▾ ") : ""}
              <span className="tree-item-name">{prettyName(n.name, rel, datastores, datastoreItems)}</span>
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
            onClick={() => {
              setContextMenu(null);
              setDeleteArmed(false);
            }}
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
                setDeleteArmed(false);
              }}
            >
              Reveal in Finder
            </button>
            {!contextMenu.isDir && (
              <button
                className="context-menu-item context-menu-item-danger"
                onClick={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true);
                    return;
                  }
                  const path = contextMenu.path;
                  setContextMenu(null);
                  setDeleteArmed(false);
                  fsDelete(path)
                    .then(() => reload())
                    .catch((e) => {
                      console.error("delete failed:", e);
                    });
                }}
              >
                {deleteArmed ? "Click again to confirm" : "Delete"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
