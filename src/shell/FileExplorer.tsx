import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import sunburstIcon from "../assets/sunburst.svg";
import {
  fsDelete,
  fsList,
  fsReveal,
  gitStatusShort,
  kbDeleteFile,
  kbWriteFileBytes,
  type FileNode,
  type GitFileStatus,
} from "../lib/api";
import { subscribeSync, type SyncStatus } from "../lib/kbSync";
import { subscribeFilestoreSync, type FilestoreSyncStatus } from "../lib/filestoreSync";
import { subscribeConflicts, type AggregatedConflict } from "../lib/syncEngine";
import { loadCreds } from "../lib/pinkfishAuth";
import { resolveProjectDatastores, fetchDatastoreItems, fetchDatastoreSchema } from "../lib/datastoreSync";
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
  // Agent + workflow files: `agents/<name>.json` → just `<name>`. The
  // .json extension is implementation noise; the user thinks of these
  // as named entities, not files.
  if (rel.match(/^(agents|workflows)\/[^/]+\.json$/)) {
    return name.replace(/\.json$/, "");
  }
  // Row file: databases/<col>/<key>.json. Try a schema-picked display
  // field first (email for people, case number for tickets, etc.); if
  // anything in that lookup fails, fall through to the bare row key
  // (filename without `.json`) — never the raw filename, since `.json`
  // is implementation noise the user doesn't think of as part of the id.
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
    return rowKey;
  }
  // Conversation message: databases/conversations/<ticketId>/msg-*.json.
  // The filename is `msg-<unix-ms>-<rand>.json`; the user thinks of these
  // as messages, not files, so drop the .json. (We keep the msg- prefix
  // and timestamp because they sort the explorer list usefully.)
  if (rel.match(/^databases\/conversations\/[^/]+\/.+\.json$/) && !name.includes(".server.")) {
    return name.replace(/\.json$/, "");
  }
  // Knowledge-base markdown articles — same logic as agents/workflows:
  // the .md is implementation noise; users think of them by title.
  // Matches files under any KB collection: `knowledge-bases/<col>/<name>.md`.
  if (rel.match(/^knowledge-bases\/[^/]+\/[^/]+\.(md|markdown)$/)) {
    return name.replace(/\.(md|markdown)$/, "");
  }
  return name;
}

/// Recover a friendlier filename for a dropped file. Most drops from
/// Finder give us the real filename in `File.name`. Drops from a web
/// app (Slack, Google Drive, etc.) often hand the browser an opaque
/// CDN id instead — `T06KC1QJMSP-U07KXMWSZR7-1a3826e7787f-…` is the
/// pattern Slack uses. When the file's own name looks like one of
/// those opaque ids AND the drag includes a `text/uri-list` (the
/// public link), prefer the URL's basename — that's almost always
/// the real filename. Fall back to the original `File.name` if we
/// can't do better.
function friendlyDroppedFilename(fileName: string, urlHint?: string): string {
  // Detect the Slack-style id (workspace + user + hash) and the
  // generic "long string of hex/uppercase/dashes with no extension"
  // pattern. If the name has a normal extension and isn't pathological,
  // keep it.
  const looksLikeSlackId = /^T[A-Z0-9]+-U[A-Z0-9]+/.test(fileName);
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(fileName);
  const looksOpaque = looksLikeSlackId || (!hasExtension && fileName.length > 32 && /^[A-Za-z0-9_-]+$/.test(fileName));
  if (!looksOpaque) return fileName;

  if (urlHint) {
    try {
      const url = new URL(urlHint);
      const segments = url.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      if (last) {
        const decoded = decodeURIComponent(last);
        // Sanity-check: the URL basename should look like a real
        // filename (have an extension, not be itself opaque).
        if (/\.[A-Za-z0-9]{1,8}$/.test(decoded)) return decoded;
      }
    } catch {
      /* not a parsable URL — fall through */
    }
  }
  return fileName;
}

function fileColorClass(
  n: FileNode,
  repo: string,
  gitRows: GitFileStatus[],
  conflictPaths: Set<string>,
): string {
  if (n.is_dir) return "";
  const rel = relPath(repo, n.path);
  // Engine-tracked conflict on the canonical path beats git's view.
  if (conflictPaths.has(rel)) return "file-color-conflict";
  const st = gitStatusForPath(rel, gitRows);
  if (!st) return "";
  if (st.status === "UU") return "file-color-conflict";
  if (st.status === "?") return "file-color-untracked";
  if (st.status === "M") return "file-color-modified";
  if (st.status === "A") return "file-color-added";
  if (st.status === "D") return "file-color-deleted";
  return "";
}

function fileStatusBadge(
  n: FileNode,
  repo: string,
  gitRows: GitFileStatus[],
  conflictPaths: Set<string>,
): string | null {
  if (n.is_dir) return null;
  const rel = relPath(repo, n.path);
  // Conflict marker takes priority over git status — the user needs to
  // resolve the conflict before the modified/untracked state matters.
  if (conflictPaths.has(rel)) return "⚠";
  const st = gitStatusForPath(rel, gitRows);
  if (!st) return null;
  if (st.status === "UU") return "⚠";
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
  // System-file visibility toggle: CLAUDE.md and `_*` files are
  // scaffolding the user usually doesn't want to see. Default off;
  // toolbar icon toggles.
  const [showSystemFiles, setShowSystemFiles] = useState(false);

  // Virtual resource state
  const [datastores, setDatastores] = useState<DataCollection[]>([]);
  const [datastoreItems, setDatastoreItems] = useState<
    Record<string, { items: MemoryItem[]; hasMore: boolean; schema?: any }>
  >({});
  // (agents/workflows in-memory state was only used by the drag-emit
  // entity blob, which is now path-only. The engine's start*Sync calls
  // in App.tsx own the actual sync; FileExplorer reads them off disk
  // via fsList for tree rendering.)
  // (loadingResources removed — initial load is fast enough)

  const [fsSync, setFsSync] = useState<FilestoreSyncStatus | null>(null);

  // Engine conflict aggregate — drives the per-file conflict marker
  // (⚠) on canonicals so the user can see at a glance which files
  // need resolution. The shadow files themselves are hidden from the
  // tree (see `visible` below).
  const [engineConflicts, setEngineConflicts] = useState<AggregatedConflict[]>([]);
  useEffect(() => subscribeConflicts(setEngineConflicts), []);
  const conflictPaths = useMemo(
    () => new Set(engineConflicts.map((c) => c.workingTreePath)),
    [engineConflicts],
  );
  
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
        const ds = await resolveProjectDatastores(creds).catch(
          () => [] as DataCollection[],
        );
        if (cancelled) return;
        setDatastores(ds);

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

        // Disk-writing + auto-committing for all five entities runs
        // through the engine-driven start*Sync calls (App.tsx + modal).
        // The engine commits ONLY the paths it just pulled, scoped via
        // gitCommitPaths. FileExplorer used to do a broad
        // gitAddAndCommit(... "sync: update from Pinkfish") here, which
        // swept up the user's pending edits (including Claude's merge
        // result) under a misleading message — leaving "no changes" in
        // the Sync tab. Removed.
        if (repo) reload();
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
        const ds = await resolveProjectDatastores(creds).catch(
          () => [] as DataCollection[],
        );
        if (cancelled) return;
        setDatastores(ds);
      } catch { /* silent */ }
    }

    loadOnce();
    const interval = setInterval(pollSilently, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // System / scaffolding entries hidden by default. The toggle in
  // the toolbar exposes them when the user wants to inspect:
  //   - `CLAUDE.md` — the agent instructions doc at repo root
  //   - `_*` files (`_schema.json`, etc.) at any depth
  //   - `.claude/` directory and everything under it (skills source)
  //   - `.openit/agent-traces/` (per-turn trace JSON; clickable)
  // Other `.openit/` siblings (plugin-version, skill-state,
  // slack-*.json, chat sessions) are pure engine state with no
  // viewer affordance and would just add noise to the tree.
  const isSystemEntry = (n: FileNode): boolean => {
    if (!repo) return false;
    const rel = n.path.startsWith(repo + "/") ? n.path.slice(repo.length + 1) : n.path;
    if (rel === "CLAUDE.md") return true;
    if (rel === ".claude" || rel.startsWith(".claude/")) return true;
    if (
      rel === ".openit" ||
      rel === ".openit/agent-traces" ||
      rel.startsWith(".openit/agent-traces/")
    ) {
      return true;
    }
    if (n.name.startsWith("_")) return true;
    return false;
  };

  // Always-hidden entries inside `.openit/` that the toggle should
  // NOT reveal. Anything under .openit that isn't agent-traces is
  // pure engine state and shouldn't surface even in advanced view.
  const isOpenitNoise = (n: FileNode): boolean => {
    if (!repo) return false;
    const rel = n.path.startsWith(repo + "/") ? n.path.slice(repo.length + 1) : n.path;
    if (!rel.startsWith(".openit/")) return false;
    if (rel === ".openit/agent-traces" || rel.startsWith(".openit/agent-traces/")) {
      return false;
    }
    return true;
  };

  const visible = useMemo(() => {
    if (!repo) return [];
    return nodes.filter((n) => {
      // Hide conflict shadows from the tree — they're a local-only
      // implementation detail of the merge flow. The user sees a ⚠
      // marker on the canonical instead (via fileStatusBadge +
      // conflictPaths). Shadows reappear if the user wants to inspect
      // via Reveal in Finder.
      if (!n.is_dir && n.name.includes(".server.")) return false;
      if (isOpenitNoise(n)) return false;
      if (!showSystemFiles && isSystemEntry(n)) return false;
      // Hide `databases/conversations/` and everything under it.
      // Conversations are a per-ticket implementation detail (the
      // raw msg-*.json turns); the ticket-list overview is the
      // user-facing surface, and clicking a ticket card opens the
      // thread directly. Showing both `tickets` and `conversations`
      // in the explorer was confusing — same data, two entry points.
      // The "show system files" toggle re-reveals them for admins
      // who want to inspect the underlying msg-*.json data.
      const rel = n.path.startsWith(repo + "/") ? n.path.slice(repo.length + 1) : "";
      if (
        !showSystemFiles &&
        (rel === "databases/conversations" || rel.startsWith("databases/conversations/"))
      ) {
        return false;
      }
      for (const c of collapsed) {
        if (n.path !== c && n.path.startsWith(c + "/")) return false;
      }
      return true;
    });
  }, [nodes, collapsed, repo, showSystemFiles]);

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const targetPath = dropTargetPath;
    setDropTargetPath(null);
    setRejectedFiles([]);
    if (!repo) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;

    // Pull URL-list out of the drag payload so we can recover original
    // filenames for web-app drags (Slack / Drive / etc.) where the
    // browser-exposed `File.name` is an opaque CDN id like
    // `T06KC1QJMSP-U07KXMWSZR7-1a3826e7787f-…`. The url-list typically
    // carries the public link whose path basename is the human name.
    const dragUrls: string[] = [];
    const uriList = e.dataTransfer.getData("text/uri-list");
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) dragUrls.push(trimmed);
      }
    }
    if (dragUrls.length === 0) {
      const text = e.dataTransfer.getData("text/plain");
      if (text && /^https?:\/\//.test(text.trim())) dragUrls.push(text.trim());
    }

    // Determine which directory was the drop target
    const targetRel = targetPath ? relPath(repo, targetPath) : null;
    // Resolve the target's specific filestore subdirectory.
    // - `filestores/library`        → write to library/
    // - `filestores/docs-123`       → write to docs-123/
    // - `filestores/<any>`          → write to that collection's folder
    // - `filestores/`               → fall through to library as the
    //                                 canonical "curated" default
    // - `filestore` (legacy)        → fall through to library
    // We deliberately do NOT route drops on `filestores/attachments` or
    // its per-ticket subfolders here: that surface is server-managed
    // chat-intake uploads, not a curated drop target.
    let filestoreSubdir: string | null = null;
    if (targetRel) {
      const collectionMatch = targetRel.match(/^filestores\/([^/]+)/);
      if (collectionMatch) {
        const collection = collectionMatch[1];
        // Block drops on attachments — it's a server-managed surface.
        // Library and any other openit-* collection are valid targets.
        if (collection !== "attachments") {
          filestoreSubdir = `filestores/${collection}`;
        }
      } else if (targetRel === "filestores" || targetRel === "filestore") {
        filestoreSubdir = "filestores/library";
      }
    }

    if (filestoreSubdir) {
      // Drop into the resolved collection subdir — no file type
      // restriction. Each collection writes only to its own folder, so
      // the per-collection sync engine pushes only what was actually
      // dropped there. Pre-fix: every drop went to filestores/library/
      // and the push iterated every collection from the same dir,
      // replicating the file across every openit-* collection.
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const filename = friendlyDroppedFilename(f.name, dragUrls[i]);
        try {
          const buf = await f.arrayBuffer();
          const { fsStoreWriteFileBytes } = await import("../lib/api");
          await fsStoreWriteFileBytes(repo, filename, buf, filestoreSubdir);
        } catch (err) {
          console.error(
            `failed to import ${filename} to ${filestoreSubdir}:`,
            err,
          );
        }
      }
      reload();
      return;
    }

    // Default: drop into the default knowledge base
    // (`knowledge-bases/default/`) with file type filtering. Resolve
    // a friendly name first so the kb-supported check sees the real
    // extension (a Slack-id-shaped name has no extension and would
    // be rejected as unsupported).
    const acceptedRecords: { file: File; filename: string }[] = [];
    const rejected: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const filename = friendlyDroppedFilename(f.name, dragUrls[i]);
      if (isKbSupported(filename)) {
        acceptedRecords.push({ file: f, filename });
      } else {
        rejected.push(filename);
      }
    }
    if (rejected.length > 0) setRejectedFiles(rejected);

    for (const { file: f, filename } of acceptedRecords) {
      try {
        const buf = await f.arrayBuffer();
        await kbWriteFileBytes(repo, filename, buf);
      } catch (err) {
        console.error(`failed to import ${filename}:`, err);
      }
    }
    if (acceptedRecords.length > 0) reload();
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

  // 2026-04-27 plural rename: KB articles live in
  // `knowledge-bases/default/`. The delete affordance still scopes to
  // the default collection (cloud-sync target); custom KBs are
  // off-limits via this path until V1 wires their per-collection
  // delete pipeline.
  const KB_PREFIX = "knowledge-bases/default/";
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
  // Split dirs by depth so the toggle can cycle through three states
  // (all-collapsed → top-level-only → fully-expanded → all-collapsed).
  // Top-level = repo-relative path has no '/' separator.
  const repoPrefix = repo ? `${repo}/` : "";
  const topLevelDirs = repo
    ? allDirs.filter((p) => p.startsWith(repoPrefix) && !p.slice(repoPrefix.length).includes("/"))
    : [];
  const deeperDirs = allDirs.filter((p) => !topLevelDirs.includes(p));
  const allCollapsed = allDirs.length > 0 && allDirs.every((d) => collapsed.has(d));
  const allExpanded = allDirs.length > 0 && collapsed.size === 0;
  const topLevelOnly =
    topLevelDirs.length > 0 &&
    topLevelDirs.every((d) => !collapsed.has(d)) &&
    deeperDirs.every((d) => collapsed.has(d));

  // Cycle: all-collapsed → top-level-only → fully-expanded → back.
  // From any other intermediate state we collapse to baseline so the
  // user has a predictable next click.
  const toggleAll = () => {
    if (allCollapsed) {
      // Open top-level dirs but keep deeper folders collapsed so the
      // user sees the immediate structure without flooding the tree.
      setCollapsed(new Set(deeperDirs));
    } else if (topLevelOnly) {
      // Drill all the way in.
      setCollapsed(new Set());
    } else {
      // Either fully-expanded or some intermediate state → collapse
      // everything to start the cycle over.
      setCollapsed(new Set(allDirs));
    }
  };
  // Title hint reflects what the NEXT click will do.
  const toggleTitle = allCollapsed
    ? "Open top-level folders"
    : topLevelOnly
      ? "Expand all"
      : "Collapse all";
  const toggleGlyph = allCollapsed
    ? "⊞"  // empty box → next click adds visible content
    : allExpanded
      ? "⊟"  // filled box → next click clears
      : "⊡"; // half-state → next click pushes deeper or collapses

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
        <button type="button" className="explorer-icon-btn" onClick={toggleAll} title={toggleTitle}>
          {toggleGlyph}
        </button>
        <button
          type="button"
          className={`explorer-icon-btn explorer-system-toggle ${showSystemFiles ? "active" : ""}`}
          onClick={() => setShowSystemFiles((v) => !v)}
          title={
            showSystemFiles
              ? "Hide system files (CLAUDE.md, _schema.json, .claude/)"
              : "Show system files (CLAUDE.md, _schema.json, .claude/)"
          }
          aria-pressed={showSystemFiles}
        >
          <img src={sunburstIcon} alt="" className="explorer-system-icon" />
        </button>
      </div>

      <ul className="tree">
        {/* Real file tree */}
        {visible.map((n) => {
          const rel = n.path.startsWith(repo + "/") ? n.path.slice(repo.length + 1) : n.name;
          const depth = rel.split("/").length - 1;
          const isCollapsedRow = collapsed.has(n.path);
          const colorClass = repo ? fileColorClass(n, repo, gitRows, conflictPaths) : "";
          const badge = repo ? fileStatusBadge(n, repo, gitRows, conflictPaths) : null;
          return (
            <li
              key={n.path}
              className={`tree-item ${n.is_dir ? "dir" : "file"} ${colorClass}${dropTargetPath === n.path ? " drop-target" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onContextMenu={(e) => {
                e.preventDefault();
                // Reset delete-arm whenever the menu retargets — without this,
                // arming Delete on file A and right-clicking file B preselects
                // "Click again to confirm" on B, and the next click wipes B.
                setDeleteArmed(false);
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
                  // Open viewer for:
                  //   - top-level `databases/` parent → databases-list
                  //     (collections overview with empty state)
                  //   - top-level datastore dirs (databases/<col>/) → table
                  //   - conversation thread subfolders
                  //     (databases/conversations/<ticketId>/) → chat thread
                  //   - top-level entity dirs (agents, workflows,
                  //     knowledge-base, filestore) → entity-folder view
                  //     so empty folders show a friendly notice instead
                  //     of nothing.
                  if (
                    rel === "databases" ||
                    rel.match(/^databases\/[^/]+$/) ||
                    rel.match(/^databases\/conversations\/[^/]+$/) ||
                    rel === "agents" ||
                    rel === "workflows" ||
                    // 2026-04-27 plural rename: knowledge-bases/<col>/
                    // replaces the legacy flat knowledge-base/.
                    //   - `knowledge-bases/`         → cards (default + custom)
                    //   - `knowledge-bases/<name>/`  → entity-folder file list
                    rel === "knowledge-bases" ||
                    rel.match(/^knowledge-bases\/[^/]+$/) ||
                    // 2026-04-27 filestore split:
                    //   - `filestores/`             → two-card overview
                    //   - `filestores/attachments/` → welcome stub +
                    //                                 per-ticket subfolders
                    //   - `filestores/library/`     → curated entity-folder
                    rel === "filestores" ||
                    rel === "filestores/attachments" ||
                    rel.match(/^filestores\/attachments\/[^/]+$/) ||
                    // Any direct child of filestores/ (library, docs-*, or
                    // any user-created collection) renders as an
                    // entity-folder file list. Without this, dynamic openit-*
                    // collections (e.g., filestores/docs-653713545258/)
                    // would just toggle expansion without opening the viewer.
                    rel.match(/^filestores\/[^/]+$/) ||
                    // On-demand markdown reports — sorted newest-first
                    // in the entity-folder view via filename prefix.
                    rel === "reports" ||
                    // Per-ticket agent-traces folder → agent-trace-list
                    // view (every turn stacked with separators).
                    rel.match(/^\.openit\/agent-traces\/[^/]+$/)
                  ) {
                    onSelect(n.path);
                  }
                  return;
                }
                onSelect(n.path);
              }}
              draggable={
                !n.is_dir ||
                rel.match(/^databases\/[^/]+$/) !== null ||
                rel.match(/^databases\/conversations\/[^/]+$/) !== null
              }
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
                    // 2026-04-27 plural rename: KB conflicts surface
                    // for the cloud-synced default collection.
                    onSelect(`${repo}/knowledge-bases/default/${c.filename}`)
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
