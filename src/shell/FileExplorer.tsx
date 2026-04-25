import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fsList,
  kbStateLoad,
  kbWriteFileBytes,
  type FileNode,
  type KbStatePersisted,
} from "../lib/api";
import { subscribeSync, type SyncStatus } from "../lib/kbSync";
import { subscribeFilestoreSync, type FilestoreSyncStatus } from "../lib/filestoreSync";
import { loadCreds } from "../lib/pinkfishAuth";
import { resolveProjectDatastores, fetchDatastoreItems, syncDatastoresToDisk } from "../lib/datastoreSync";
import { resolveProjectAgents, syncAgentsToDisk, type Agent } from "../lib/agentSync";
import { resolveProjectWorkflows, syncWorkflowsToDisk, type Workflow } from "../lib/workflowSync";
import type { DataCollection, MemoryItem } from "../lib/skillsApi";
import type { ViewerSource } from "./types";

const KB_DIRNAME = "knowledge-base";

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
}: {
  repo: string | null;
  onSelect: (source: ViewerSource) => void;
}) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [kbState, setKbState] = useState<KbStatePersisted | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [rejectedFiles, setRejectedFiles] = useState<string[]>([]);

  // Virtual resource state
  const [datastores, setDatastores] = useState<DataCollection[]>([]);
  const [datastoreItems, setDatastoreItems] = useState<
    Record<string, { items: MemoryItem[]; hasMore: boolean }>
  >({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [, setLoadingResources] = useState(false);

  // (virtual section state removed — entities are real files now)

  const [fsSync, setFsSync] = useState<FilestoreSyncStatus | null>(null);
  useEffect(() => subscribeSync(setSync), []);
  useEffect(() => subscribeFilestoreSync(setFsSync), []);

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
        // Collapse all dirs on first load
        if (collapsed.size === 0 && n.length > 0) {
          setCollapsed(new Set(n.filter((nd) => nd.is_dir).map((nd) => nd.path)));
        }
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

  useEffect(() => {
    if (fsSync?.phase === "ready") reload();
  }, [fsSync?.phase, fsSync?.lastPullAt, reload]);

  const [initialLoadDone, setInitialLoadDone] = useState(false);

  // Shared loader for virtual resources — called on mount, periodically, and on entity click
  const loadResources = useCallback(async () => {
    const creds = await loadCreds();
    if (!creds) return;

    // Only show loading indicator on first load, not on background polls
    if (!initialLoadDone) setLoadingResources(true);
    try {
      const [ds, ag, wf] = await Promise.all([
        resolveProjectDatastores(creds).catch((e) => {
          console.warn("[FileExplorer] failed to load datastores:", e);
          return [] as DataCollection[];
        }),
        resolveProjectAgents(creds).catch((e) => {
          console.warn("[FileExplorer] failed to load agents:", e);
          return [] as Agent[];
        }),
        resolveProjectWorkflows(creds).catch((e) => {
          console.warn("[FileExplorer] failed to load workflows:", e);
          return [] as Workflow[];
        }),
      ]);

      setDatastores(ds);
      setAgents(ag);
      setWorkflows(wf);

      // Load first 100 items for each datastore
      const itemsMap: Record<string, { items: MemoryItem[]; hasMore: boolean }> = {};
      await Promise.all(
        ds.map(async (col) => {
          try {
            const resp = await fetchDatastoreItems(creds, col.id, 100, 0);
            itemsMap[col.id] = {
              items: resp.items,
              hasMore: resp.pagination.hasNextPage,
            };
          } catch (e) {
            console.warn(`[FileExplorer] failed to load items for ${col.name}:`, e);
            itemsMap[col.id] = { items: [], hasMore: false };
          }
        }),
      );

      setDatastoreItems(itemsMap);

      // Write entities to disk so Claude Code can read them as files
      if (repo) {
        syncDatastoresToDisk(repo, ds, itemsMap).catch((e) =>
          console.warn("[FileExplorer] failed to sync datastores to disk:", e));
        syncAgentsToDisk(repo, ag).catch((e) =>
          console.warn("[FileExplorer] failed to sync agents to disk:", e));
        syncWorkflowsToDisk(repo, wf).catch((e) =>
          console.warn("[FileExplorer] failed to sync workflows to disk:", e));
        // Refresh the file tree to show the new files
        reload();
      }
    } finally {
      setLoadingResources(false);
      setInitialLoadDone(true);
    }
  }, [initialLoadDone, repo, reload]);

  // Load on mount + poll every 60s
  useEffect(() => {
    loadResources();
    const interval = setInterval(loadResources, 60_000);
    return () => clearInterval(interval);
  }, [loadResources]);

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
      if (!kbState) return true; // no manifest yet -> treat as unsynced
      const filename = n.path.slice(kbPrefix.length);
      const tracked = kbState.files?.[filename];
      if (!tracked) return true; // never pushed/pulled
      return false;
    },
    [kbState, repo],
  );

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    setRejectedFiles([]);
    if (!repo) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;

    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (isKbSupported(f.name)) {
        accepted.push(f);
      } else {
        rejected.push(f.name);
      }
    }

    if (rejected.length > 0) {
      setRejectedFiles(rejected);
    }

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
        {/* Real file tree */}
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
              onClick={() => {
                if (n.is_dir) {
                  toggle(n.path);
                  // If clicking a databases/<collection> dir, show the table view
                  const dbMatch = rel.match(/^databases\/([^/]+)$/);
                  if (dbMatch) {
                    const col = datastores.find((d) => d.name === dbMatch[1]);
                    if (col) {
                      onSelect({
                        kind: "datastore-table",
                        collection: col,
                        items: datastoreItems[col.id]?.items,
                        hasMore: datastoreItems[col.id]?.hasMore,
                      });
                    }
                  }
                  return;
                }
                // Rich view for entities in special directories
                if (rel.startsWith("agents/") && rel.endsWith(".json")) {
                  const agent = agents.find((a) => {
                    const safeName = a.name.replace(/[/\\:*?"<>|]/g, "_");
                    return rel === `agents/${safeName}.json`;
                  });
                  if (agent) { onSelect({ kind: "agent", agent }); return; }
                }
                if (rel.startsWith("workflows/") && rel.endsWith(".json")) {
                  const wf = workflows.find((w) => {
                    const safeName = w.name.replace(/[/\\:*?"<>|]/g, "_");
                    return rel === `workflows/${safeName}.json`;
                  });
                  if (wf) { onSelect({ kind: "workflow", workflow: wf }); return; }
                }
                if (rel.match(/^databases\/[^/]+\/[^/]+\.json$/) && !rel.endsWith("_schema.json")) {
                  const parts = rel.split("/");
                  const colName = parts[1];
                  const col = datastores.find((d) => d.name === colName);
                  if (col) {
                    const rowKey = parts[2].replace(/\.json$/, "");
                    const item = datastoreItems[col.id]?.items.find((i) => (i.key || i.id) === rowKey);
                    if (item) { onSelect({ kind: "datastore-row", collection: col, item }); return; }
                  }
                }
                if (rel.match(/^databases\/[^/]+\/_schema\.json$/)) {
                  const colName = rel.split("/")[1];
                  const col = datastores.find((d) => d.name === colName);
                  if (col) { onSelect({ kind: "datastore-schema", collection: col }); return; }
                }
                onSelect({ kind: "file", path: n.path });
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
              {n.name}
              {unsynced && <span className="unsynced-dot" title="Not yet synced" />}
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
          <div className="kb-conflicts-header">Warning: KB conflicts</div>
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
