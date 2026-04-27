import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fsRead, fsReadBytes, fsList, reportOverviewRun } from "../lib/api";
import { loadCreds } from "../lib/pinkfishAuth";
import { fetchDatastoreItems } from "../lib/datastoreSync";
import type { MemoryItem } from "../lib/skillsApi";
import { DataTable } from "./DataTable";
import { RowEditForm } from "./RowEditForm";
import { AttachmentList } from "./AttachmentList";
import { ImageViewer } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { SpreadsheetViewer } from "./viewers/SpreadsheetViewer";
import { OfficeViewer } from "./viewers/OfficeViewer";
import { writeToActiveSession } from "./activeSession";

/// Pasting a slash command into the active Claude PTY uses bracketed-
/// paste sequences so the terminal treats it as a single atomic input,
/// not as the user typing key-by-key. Same pattern as the
/// EscalatedTicketBanner.
const BRACKETED_PASTE_OPEN = "\x1b[200~";
const BRACKETED_PASTE_CLOSE = "\x1b[201~";
import type { ViewerSource } from "./types";

export type { ViewerSource };

/// Title labels for the entity-folder view. Capital case for the title
/// bar; the explorer rows use the lowercase folder names directly.
const ENTITY_FOLDER_LABELS: Record<
  "agents" | "workflows" | "knowledge-base" | "library" | "reports",
  string
> = {
  agents: "Agents",
  workflows: "Workflows",
  "knowledge-base": "Knowledge base",
  library: "Library",
  reports: "Reports",
};

/// Singular noun for the count pill in the title — "3 agents", "1 file".
const ENTITY_FOLDER_NOUN: Record<
  "agents" | "workflows" | "knowledge-base" | "library" | "reports",
  string
> = {
  agents: "agent",
  workflows: "workflow",
  "knowledge-base": "article",
  library: "file",
  reports: "report",
};

/// Friendly empty-state copy per top-level entity folder, mirroring the
/// conversations-list notice. Each message says what lives here, why it
/// is empty, and the natural way to populate it.
const ENTITY_FOLDER_EMPTY_COPY: Record<
  "agents" | "workflows" | "knowledge-base" | "library" | "reports",
  string
> = {
  agents:
    "No agents yet. Agents are reusable Claude prompts (triage, onboarding, audits) that drive the workflows in this project. Ask Claude in the chat — \"draft an agent that triages tickets by urgency\" — and it will scaffold one here.",
  workflows:
    "No workflows yet. Workflows orchestrate agents and connections to automate IT work end-to-end. Ask Claude — \"build a workflow that escalates SLA breaches\" — and it will land a workflow file here.",
  "knowledge-base":
    "No knowledge-base articles yet. This is where runbooks and reference docs live — Claude reads them when answering tickets. Drop in markdown files, or ask Claude to draft one (\"write a runbook for resetting a Slack workspace owner\").",
  library:
    "No library files yet. Drop runbook PDFs, scripts, or any reference doc you reach for repeatedly — Claude can pull from these when answering tickets or building workflows.",
  reports:
    "No reports yet. Click \"Generate overview\" above for an instant snapshot of ticket status, recent activity, top askers, and current escalations — or ask Claude in the chat (\"/report VPN tickets last 30 days\") for a custom report.",
};

/// Anchor tag override for ReactMarkdown rendering. Three URL shapes
/// are routed:
///
/// - `openit://skill/<name>` → pastes `/<name>` into the active Claude
///   PTY, kicking off that skill conversationally. Used by the welcome
///   doc's "Connect to Cloud" CTA. Future: support args via query
///   string.
/// - `http(s)://...` → opens in the user's default browser via Tauri's
///   `openUrl` plugin so the in-app webview isn't replaced by the
///   linked page.
/// - Anything else → renders as a normal `<a>` (in-page anchors,
///   `mailto:`, etc.).
function ExternalAnchor({
  href,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href && href.startsWith("openit://skill/")) {
    const skillName = href.slice("openit://skill/".length).split("?")[0];
    // Use href="#" rather than the openit:// URL — the Tauri webview
    // tries to navigate the whole shell when it sees a real custom
    // scheme, which reloads the app. Stash the skill name on a
    // data attribute so the CSS selector can still target this kind
    // of link for the secondary-button styling.
    return (
      <a
        href="#"
        data-openit-skill={skillName}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const cmd = `/${skillName}`;
          const wrapped = `${BRACKETED_PASTE_OPEN}${cmd}${BRACKETED_PASTE_CLOSE}`;
          console.log("[viewer] pasting skill into Claude:", cmd);
          writeToActiveSession(wrapped)
            .then((ok) => {
              if (!ok) {
                alert(
                  "Couldn't reach Claude — make sure Claude is running in the right-hand pane, then click again.",
                );
              }
            })
            .catch((err) => console.warn("[viewer] paste-to-Claude failed:", err));
        }}
        {...rest}
      >
        {children}
      </a>
    );
  }
  const isExternal = !!href && /^https?:\/\//i.test(href);
  if (!isExternal) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch((err) => console.warn("[viewer] openUrl failed:", err));
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

type ViewMode = "rendered" | "raw" | "table" | "edit";

function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

function isImage(path: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp)$/i.test(path);
}

function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

function isSpreadsheet(path: string): boolean {
  return /\.(xlsx|csv)$/i.test(path);
}

function isOfficeDoc(path: string): boolean {
  return /\.(docx|pptx)$/i.test(path);
}

function mimeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}

export function Viewer({
  source,
  repo,
  fsTick,
  intakeUrl,
  welcomeFlashKey,
  onOpenPath,
}: {
  source: ViewerSource;
  repo: string;
  fsTick?: number;
  /** Current intake server URL — substituted into `{{INTAKE_URL}}` placeholders
   *  in markdown content (the welcome doc uses this to surface a clickable
   *  link to the live intake page despite the URL being a dynamic OS-assigned
   *  port that changes per app launch). */
  intakeUrl?: string | null;
  /** Bumped by the parent when the user clicks "Getting Started" while the
   *  welcome doc is already the active source. Triggers a one-shot flash
   *  animation so the click doesn't look like a no-op. */
  welcomeFlashKey?: number;
  /** Open another path in the viewer (used by the conversations-list
   *  cards to drill into a specific thread). Optional — falls back to
   *  no-op if the parent didn't wire it. */
  onOpenPath?: (path: string) => void | Promise<void>;
}) {
  const [content, setContent] = useState<string>("");
  const [binaryData, setBinaryData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("rendered");

  // Self-loaded table data for datastore-table
  const [tableItems, setTableItems] = useState<MemoryItem[]>([]);
  const [tableHasMore, setTableHasMore] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);

  // Live override of the row content for datastore-row sources. Source
  // captures the row at click time; this gets populated when the
  // on-disk file changes (fsTick) so the table/raw view updates
  // without re-clicking.
  const [rowOverride, setRowOverride] = useState<MemoryItem | null>(null);
  // Lifted from below the early returns (was at the copy-button section)
  // — calling useState after a conditional early return broke the
  // Rules of Hooks: hook count differed between "no source" and "with
  // source" renders, surfacing as a blank-screen render error.
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  // Filter for the conversations-list view. `all` shows every thread;
  // the others narrow by ticket status. Persists across click+reopen
  // of the conversations folder within the same session, but resets
  // when the project (repo) changes — the filter is per-project, not
  // global.
  const [conversationsFilter, setConversationsFilter] =
    useState<"all" | "open" | "resolved" | "escalated">("all");
  useEffect(() => {
    setConversationsFilter("all");
  }, [repo]);

  // Edit-mode state for the markdown viewer. `editDraft` is the
  // textarea value (decoupled from `content` so unsaved edits don't
  // race with disk re-reads). `editSaving` shows a brief saving
  // indicator on the Save button. Both reset whenever the source
  // changes — opening a different file mid-edit discards the draft
  // (matches what most code editors do without an explicit prompt).
  const [editDraft, setEditDraft] = useState<string>("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Parallel state for row-edit mode — keyed by field id, mirrors the
  // row content. Stored as `unknown` per field so `string[]`,
  // booleans, etc. round-trip without coercion until save.
  const [rowEditDraft, setRowEditDraft] = useState<Record<string, unknown>>({});

  // Reply composer state for the conversation-thread view. The admin
  // can answer the asker directly from the thread bubble pane —
  // bypasses Claude entirely for the "I can answer this myself"
  // case. The write lands as `role: "admin"` and the auto-commit
  // driver bookkeeps it.
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  // Pending attachments staged in the admin composer. `path` is the
  // repo-relative location after the file lands on disk; we write
  // straight to `filestores/attachments/<ticketId>/<filename>` and
  // include the path on the next reply turn.
  const [replyAttachments, setReplyAttachments] = useState<
    { path: string; filename: string }[]
  >([]);
  const [replyDragOver, setReplyDragOver] = useState(false);
  // "Generate overview" button state on the reports/ entity-folder
  // view. Run kicks off the local script via the Tauri command and,
  // on success, jumps the viewer to the freshly-written file. fsTick
  // wakes the explorer so the new file appears in the tree.
  const [reportRunning, setReportRunning] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  useEffect(() => {
    setReplyText("");
    setReplySending(false);
    setReplyError(null);
    setReplyAttachments([]);
    setReplyDragOver(false);
  }, [source]);
  useEffect(() => {
    // Fetch the admin's git email once and cache it so the composer
    // doesn't re-shell for every thread open. Falls back to "admin"
    // if git's user.email isn't set globally.
    let cancelled = false;
    (async () => {
      try {
        const { gitGlobalUserEmail } = await import("../lib/api");
        const email = await gitGlobalUserEmail();
        if (!cancelled) setAdminEmail(email);
      } catch {
        /* leave as null — composer falls back to "admin" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setEditDraft("");
    setRowEditDraft({});
    setEditSaving(false);
    setEditError(null);
  }, [source]);
  // Reset on source change so a new click clears the previous override.
  useEffect(() => setRowOverride(null), [source]);

  useEffect(() => {
    setError(null);
    setBinaryData(null);
    if (!source) {
      setContent("");
      return;
    }
    if (source.kind === "file") {
      let cancelled = false;
      const path = source.path;

      if (isImage(path) || isPdf(path) || isSpreadsheet(path)) {
        setMode("rendered");
        fsReadBytes(path)
          .then((bytes) => !cancelled && setBinaryData(bytes))
          .catch((e) => !cancelled && setError(String(e)));
        return () => { cancelled = true; };
      }
      if (isOfficeDoc(path)) {
        setMode("rendered");
        setContent("");
        return;
      }
      setMode(isMarkdown(path) ? "rendered" : "raw");
      fsRead(path)
        .then((c) => !cancelled && setContent(c))
        .catch((e) => !cancelled && setError(String(e)));
      return () => { cancelled = true; };
    }
    if (source.kind === "sync") {
      setMode("raw");
      setContent(source.lines.join("\n"));
      return;
    }
    if (source.kind === "diff") {
      setMode("raw");
      setContent(source.text);
      return;
    }
    if (source.kind === "datastore-table") {
      setMode("table");
      setContent("");
      setTableItems(source.items ?? []);
      setTableHasMore(source.hasMore ?? false);
      // Only fetch from API if we have a real collection ID
      if (source.collection.id) {
        setTableLoading(true);
        let cancelled = false;
        loadCreds().then(async (creds) => {
          if (!creds || cancelled) { setTableLoading(false); return; }
          try {
            const resp = await fetchDatastoreItems(creds, source.collection.id, 100, 0);
            if (!cancelled) {
              setTableItems(resp.items);
              setTableHasMore(resp.pagination.hasNextPage);
            }
          } catch (e) {
            console.warn("[Viewer] failed to load table items:", e);
          } finally {
            if (!cancelled) setTableLoading(false);
          }
        });
        return () => { cancelled = true; };
      }
      return;
    }
    if (source.kind === "datastore-row") {
      // Default to the table-style key/value view — easier to read at a
      // glance than raw JSON. Users who want raw JSON can click the
      // Raw tab.
      setMode("table");
      const raw = source.item.content;
      if (raw == null) {
        setContent("{}");
      } else if (typeof raw === "object") {
        setContent(JSON.stringify(raw, null, 2));
      } else {
        try {
          setContent(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          setContent(String(raw));
        }
      }
      return;
    }
    if (source.kind === "datastore-schema") {
      setMode("raw");
      setContent(JSON.stringify(source.collection.schema, null, 2));
      return;
    }
    if (source.kind === "agent") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "workflow") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "conversation-thread") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "conversations-list") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "entity-folder") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "databases-list") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "filestores-list") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "attachments-folder") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "knowledge-bases-list") {
      setMode("rendered");
      setContent("");
      return;
    }
  }, [source]);

  // Re-read the single-row file from disk when fsTick fires. Lets edits
  // by Claude (or any process touching the .json file) reflect in the
  // viewer without the user having to re-click the row.
  useEffect(() => {
    if (!source || source.kind !== "datastore-row" || !repo) return;
    if (fsTick === 0) return;
    const filePath = `${repo}/databases/${source.collection.name}/${source.item.key || source.item.id}.json`;
    let cancelled = false;
    (async () => {
      try {
        const raw = await fsRead(filePath);
        const parsed = JSON.parse(raw);
        if (cancelled) return;
        const merged: MemoryItem = {
          ...source.item,
          content: parsed,
        };
        setRowOverride(merged);
        // Also update raw-mode content so the Raw tab stays current.
        setContent(JSON.stringify(parsed, null, 2));
      } catch (e) {
        // File might have been deleted (server-delete propagated) —
        // leave the existing view rather than error.
        console.warn("[Viewer] row reload failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [fsTick, source, repo]);

  // Re-read disk-based datastore tables when filesystem changes (fsTick from native watcher)
  useEffect(() => {
    if (!source || source.kind !== "datastore-table" || source.collection.id || !repo) return;
    // Skip the initial render (fsTick === 0 is handled by the source-loading effect above)
    if (fsTick === 0) return;
    const dirPath = `${repo}/databases/${source.collection.name}`;
    let cancelled = false;

    (async () => {
      try {
        const nodes = await fsList(dirPath);
        const items: MemoryItem[] = [];
        for (const node of nodes) {
          if (node.is_dir || node.name === "_schema.json") continue;
          // Skip conflict shadow files — they're a local-only artifact
          // (`<key>.server.json` written when both sides edit the same
          // row) and showing them as separate table rows misleads the
          // user into thinking the remote has two rows.
          if (node.name.includes(".server.")) continue;
          try {
            const raw = await fsRead(node.path);
            const content = JSON.parse(raw);
            const key = node.name.replace(/\.json$/, "");
            items.push({ id: key, key, content, createdAt: "", updatedAt: "" });
          } catch { /* skip unparseable */ }
        }
        if (!cancelled) setTableItems(items);
      } catch (e) {
        console.warn("[Viewer] fs change reload failed:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [fsTick, source, repo]);

  if (!source) {
    return <div className="viewer empty">Select a file from the explorer</div>;
  }
  if (error) {
    return <div className="viewer error">{error}</div>;
  }

  // --- Title ---
  const getTitle = (): string => {
    switch (source.kind) {
      case "file": return source.path;
      case "sync": return "Sync output";
      case "diff": return "Git diff";
      case "datastore-table": return source.collection?.name ?? "Datastore";
      case "datastore-schema": return `${source.collection?.name ?? "Datastore"} — Schema`;
      case "datastore-row": return `${source.collection?.name ?? "Datastore"} / ${source.item?.key || source.item?.id || "Row"}`;
      case "agent": return source.agent?.name ?? "Agent";
      case "workflow": return source.workflow?.name ?? "Workflow";
      case "conversation-thread": return `Conversation — ${source.ticketId}`;
      case "conversations-list": return `Conversations — ${source.threads.length} thread${source.threads.length === 1 ? "" : "s"}`;
      case "entity-folder": {
        const noun = ENTITY_FOLDER_NOUN[source.entity];
        // For KB collections, surface the collection name in the
        // title (e.g. "Knowledge base — default — 3 articles") so the
        // admin can tell which KB they're in when more than one
        // exists.
        if (source.entity === "knowledge-base") {
          const m = source.path.match(/^knowledge-bases\/([^/]+)$/);
          const colName = m ? m[1] : "default";
          return `Knowledge base — ${colName} — ${source.files.length} ${noun}${source.files.length === 1 ? "" : "s"}`;
        }
        const label = ENTITY_FOLDER_LABELS[source.entity];
        return `${label} — ${source.files.length} ${noun}${source.files.length === 1 ? "" : "s"}`;
      }
      case "databases-list": {
        const n = source.collections.length;
        return `Databases — ${n} collection${n === 1 ? "" : "s"}`;
      }
      case "filestores-list": {
        const n = source.collections.length;
        return `Filestores — ${n} collection${n === 1 ? "" : "s"}`;
      }
      case "attachments-folder": {
        const n = source.tickets.length;
        return `Attachments — ${n} ticket${n === 1 ? "" : "s"}`;
      }
      case "knowledge-bases-list": {
        const n = source.collections.length;
        return `Knowledge bases — ${n} collection${n === 1 ? "" : "s"}`;
      }
      default: return "";
    }
  };
  const title = getTitle();

  // --- Tabs ---
  const showFileTabs = source.kind === "file" && isMarkdown(source.path);
  const showRowTabs = source.kind === "datastore-row";
  // The sync stream and the diff view are the two cases where the
  // user's natural next step is "paste this into Claude". A copy
  // button here saves a triple-click + ⌘C and avoids selection
  // accidentally truncating long output.
  const showCopy = source.kind === "sync" || source.kind === "diff";
  const copyableText =
    source.kind === "sync"
      ? source.lines.join("\n")
      : source.kind === "diff"
      ? source.text
      : "";
  const handleCopy = async () => {
    if (!copyableText) return;
    try {
      await navigator.clipboard.writeText(copyableText);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch (e) {
      console.error("[viewer] clipboard write failed:", e);
    }
  };

  // --- Render body ---
  const renderBody = () => {
    // File viewers
    if (source.kind === "file") {
      if (isImage(source.path) && binaryData) {
        return <ImageViewer data={binaryData} mimeType={mimeForPath(source.path)} />;
      }
      if (isPdf(source.path) && binaryData) {
        return <PdfViewer data={binaryData} />;
      }
      if (isSpreadsheet(source.path) && binaryData) {
        return <SpreadsheetViewer data={binaryData} filename={source.path} />;
      }
      if (isOfficeDoc(source.path)) {
        return <OfficeViewer filename={source.path} />;
      }
      if (mode === "edit" && isMarkdown(source.path)) {
        const filePath = source.path;
        const onSave = async () => {
          if (!repo || !filePath.startsWith(`${repo}/`)) {
            setEditError("Cannot save: file is outside the project folder.");
            return;
          }
          const rel = filePath.slice(repo.length + 1);
          const lastSlash = rel.lastIndexOf("/");
          const subdir = lastSlash >= 0 ? rel.slice(0, lastSlash) : "";
          const filename = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
          setEditSaving(true);
          setEditError(null);
          try {
            const { entityWriteFile } = await import("../lib/api");
            await entityWriteFile(repo, subdir, filename, editDraft);
            setContent(editDraft);
            setMode("rendered");
          } catch (err) {
            setEditError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setEditSaving(false);
          }
        };
        const onCancel = () => {
          setEditDraft(content);
          setEditError(null);
          setMode("rendered");
        };
        const isDirty = editDraft !== content;
        return (
          <div className="viewer-edit">
            <textarea
              className="viewer-edit-textarea"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              spellCheck={false}
              autoFocus
            />
            <div className="viewer-edit-footer">
              {editError && <span className="viewer-edit-error">{editError}</span>}
              <button
                type="button"
                className="viewer-edit-btn viewer-edit-btn-secondary"
                onClick={onCancel}
                disabled={editSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="viewer-edit-btn viewer-edit-btn-primary"
                onClick={onSave}
                disabled={editSaving || !isDirty}
              >
                {editSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        );
      }
      if (mode === "rendered" && isMarkdown(source.path)) {
        // Substitute live template tokens before rendering. {{INTAKE_URL}}
        // is the only one for now — used by the welcome doc to link to
        // the dynamic intake URL that changes per app launch. If the
        // server isn't running yet (intakeUrl is null), strip the link
        // gracefully so we don't render a broken `[text](null)`.
        const rendered = intakeUrl
          ? content.split("{{INTAKE_URL}}").join(intakeUrl)
          : content.replace(/\[([^\]]+)\]\(\{\{INTAKE_URL\}\}\)/g, "$1");
        // Re-mount the markdown subtree on flashKey change so the CSS
        // animation re-fires. Combining with a class is enough — no
        // imperative DOM poking.
        const flashClass =
          welcomeFlashKey && welcomeFlashKey > 0 ? "viewer-md-flash" : "";
        return (
          <div className={`viewer-md ${flashClass}`} key={`md-${welcomeFlashKey ?? 0}`}>
            <ReactMarkdown
              components={{ a: ExternalAnchor }}
              urlTransform={(url) =>
                url.startsWith("openit://") ? url : defaultUrlTransform(url)
              }
            >
              {rendered}
            </ReactMarkdown>
          </div>
        );
      }
      return <pre className="viewer-content">{content}</pre>;
    }

    // Datastore table view
    if (source.kind === "datastore-table") {
      if (tableLoading && tableItems.length === 0) {
        return <div className="viewer-content" style={{ opacity: 0.5 }}>Loading table data...</div>;
      }
      // Friendly empty-state — mirrors the conversations-list notice so
      // an empty `databases/<col>/` folder reads as "ready to receive
      // rows" rather than a broken table. Tickets and people are the
      // built-in collections; user-created collections share the same
      // generic copy.
      if (tableItems.length === 0) {
        const colName = source.collection.name;
        const message =
          colName === "tickets"
            ? "No tickets yet. Tickets land here when someone files one via the Intake form (top-right header) — share that URL on your machine and the new rows show up immediately."
            : colName === "people"
              ? "No people records yet. People rows are referenced by tickets (asker, assignee) and access audits. Ask Claude — \"add Alice from Engineering\" — or sync a directory once you connect to cloud."
              : `No rows in "${colName}" yet. Add one by editing the JSON files on disk under databases/${colName}/, or ask Claude to populate this collection.`;
        return (
          <div className="viewer-summary">
            <p className="summary-desc">{message}</p>
          </div>
        );
      }
      return (
        <DataTable
          collection={source.collection}
          items={tableItems}
          hasMore={tableHasMore}
          onLoadMore={async () => {
            const creds = await loadCreds();
            if (!creds) return;
            try {
              const resp = await fetchDatastoreItems(creds, source.collection.id, 100, tableItems.length);
              setTableItems((prev) => [...prev, ...resp.items]);
              setTableHasMore(resp.pagination.hasNextPage);
            } catch (e) {
              console.warn("[Viewer] load more failed:", e);
            }
          }}
          onRowClick={(key) => {
            const filePath = `${repo}/databases/${source.collection.name}/${key}.json`;
            writeToActiveSession(filePath + " ");
          }}
        />
      );
    }

    // Datastore row view
    if (source.kind === "datastore-row") {
      const liveItem = rowOverride ?? source.item;
      if (mode === "table") {
        return (
          <DataTable
            collection={source.collection}
            items={[liveItem]}
            onRowClick={(key) => {
              const filePath = `${repo}/databases/${source.collection.name}/${key}.json`;
              writeToActiveSession(filePath + " ");
            }}
          />
        );
      }
      if (mode === "edit") {
        const collection = source.collection;
        const rowKey = liveItem.key || liveItem.id;
        const onSave = async () => {
          if (!repo) {
            setEditError("Cannot save: no repo open.");
            return;
          }
          setEditSaving(true);
          setEditError(null);
          try {
            const { entityWriteFile } = await import("../lib/api");
            const json = JSON.stringify(rowEditDraft, null, 2);
            await entityWriteFile(
              repo,
              `databases/${collection.name}`,
              `${rowKey}.json`,
              json,
            );
            setContent(json);
            // Mirror the saved state back into the live row override
            // so the View tab updates without a re-click. The original
            // `source.item` is captured at click time and won't move.
            setRowOverride({ ...liveItem, content: rowEditDraft });
            setMode("table");
          } catch (err) {
            setEditError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setEditSaving(false);
          }
        };
        const onCancel = () => {
          setRowEditDraft({});
          setEditError(null);
          setMode("table");
        };
        return (
          <RowEditForm
            collection={collection}
            draft={rowEditDraft}
            onChange={setRowEditDraft}
            onSave={onSave}
            onCancel={onCancel}
            saving={editSaving}
            error={editError}
          />
        );
      }
      return <pre className="viewer-content">{content}</pre>;
    }

    // Agent summary
    if (source.kind === "agent") {
      const a = source.agent;
      return (
        <div className="viewer-summary">
          <h2>{a.name}</h2>
          {a.description && <p className="summary-desc">{a.description}</p>}
          <div className="summary-section">
            <h3>Details</h3>
            <table className="summary-table">
              <tbody>
                {a.selectedModel && (
                  <tr><td>Model</td><td>{a.selectedModel}</td></tr>
                )}
                {a.isShared !== undefined && (
                  <tr><td>Shared</td><td>{a.isShared ? "Yes" : "No"}</td></tr>
                )}
                <tr><td>ID</td><td><code>{a.id}</code></td></tr>
              </tbody>
            </table>
          </div>
          {a.instructions && (
            <div className="summary-section">
              <h3>Instructions</h3>
              <div className="viewer-md">
                <ReactMarkdown>{a.instructions}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Workflow summary
    if (source.kind === "workflow") {
      const w = source.workflow;
      return (
        <div className="viewer-summary">
          <h2>{w.name}</h2>
          {w.description && <p className="summary-desc">{w.description}</p>}
          {w.inputs && w.inputs.length > 0 && (
            <div className="summary-section">
              <h3>Inputs</h3>
              <table className="summary-table">
                <thead>
                  <tr><th>Name</th><th>Type</th><th>Required</th></tr>
                </thead>
                <tbody>
                  {w.inputs.map((inp, i) => (
                    <tr key={i}>
                      <td>{inp.name}</td>
                      <td><code>{inp.type}</code></td>
                      <td>{inp.required ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {w.triggers && w.triggers.length > 0 && (
            <div className="summary-section">
              <h3>Triggers</h3>
              <ul>
                {w.triggers.map((t, i) => (
                  <li key={i}>
                    {t.name}
                    {t.url && <code className="trigger-url">{t.url}</code>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="summary-section">
            <h3>Details</h3>
            <table className="summary-table">
              <tbody>
                <tr><td>ID</td><td><code>{w.id}</code></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // Conversations list — one clickable card per thread, sorted by
    // most-recent activity. Click a card → open that thread's chat
    // view via the parent's onOpenPath callback.
    if (source.kind === "conversations-list") {
      if (source.threads.length === 0) {
        return (
          <div className="viewer-summary">
            <p className="summary-desc">
              No conversation threads yet. They appear here once a ticket gets
              its first message — file a ticket via the Intake form to start one.
            </p>
          </div>
        );
      }
      // Counts per status drive the badges on the filter buttons. We
      // walk threads once for both the counts and the filtered list to
      // keep the render tight on big projects.
      const counts: Record<"all" | "open" | "resolved" | "escalated", number> = {
        all: source.threads.length,
        open: 0,
        resolved: 0,
        escalated: 0,
      };
      for (const t of source.threads) {
        if (t.status === "open" || t.status === "agent-responding") {
          // Group `agent-responding` (transient processing) under `open`
          // so a tiny burst of in-flight tickets doesn't surface its
          // own column. The dedicated activity banner already covers
          // the in-flight case visually.
          counts.open += 1;
        } else if (t.status === "resolved" || t.status === "closed") {
          counts.resolved += 1;
        } else if (t.status === "escalated") {
          counts.escalated += 1;
        }
      }
      const matchesFilter = (status: string) => {
        if (conversationsFilter === "all") return true;
        if (conversationsFilter === "open") {
          return status === "open" || status === "agent-responding";
        }
        if (conversationsFilter === "resolved") {
          return status === "resolved" || status === "closed";
        }
        if (conversationsFilter === "escalated") {
          return status === "escalated";
        }
        return true;
      };
      const visibleThreads = source.threads.filter((t) => matchesFilter(t.status || ""));
      const filterButton = (key: "all" | "open" | "resolved" | "escalated", label: string) => (
        <button
          key={key}
          type="button"
          className={`conv-filter-btn${conversationsFilter === key ? " conv-filter-btn-active" : ""}`}
          onClick={() => setConversationsFilter(key)}
          aria-pressed={conversationsFilter === key}
        >
          {label}
          <span className="conv-filter-count">{counts[key]}</span>
        </button>
      );
      return (
        <div className="viewer-summary viewer-conversations">
          <div className="conv-filter-bar" role="tablist">
            {filterButton("all", "All")}
            {filterButton("open", "Open")}
            {filterButton("resolved", "Resolved")}
            {filterButton("escalated", "Escalated")}
          </div>
          {visibleThreads.length === 0 ? (
            <p className="summary-desc">No threads match this filter.</p>
          ) : (
            <div className="viewer-thread-list">
              {visibleThreads.map((t) => (
                <button
                  key={t.ticketId}
                  type="button"
                  className={`thread-card thread-card-status-${t.status || "unknown"}`}
                  onClick={() => {
                    if (onOpenPath) {
                      void onOpenPath(`${repo}/databases/conversations/${t.ticketId}`);
                    }
                  }}
                  title={`Open conversation for ${t.ticketId}`}
                >
                  <div className="thread-card-row">
                    <span className="thread-card-subject">{t.subject || "(no subject)"}</span>
                    {t.status && <span className="thread-card-status">{t.status}</span>}
                  </div>
                  <div className="thread-card-meta">
                    {t.asker && <span className="thread-card-asker">{t.asker}</span>}
                    <span className="thread-card-count">
                      {t.turnCount} message{t.turnCount === 1 ? "" : "s"}
                    </span>
                    {t.lastTurnAt && (
                      <span className="thread-card-time">{t.lastTurnAt}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    // Top-level `filestores/` parent. Two cards (attachments,
    // library) — same layout as databases-list. Click attachments →
    // attachments-folder welcome stub. Click library → entity-folder
    // file view.
    if (source.kind === "knowledge-bases-list") {
      return (
        <div className="viewer-summary">
          <ul className="databases-list">
            {source.collections.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className="databases-list-item"
                  onClick={() => {
                    if (onOpenPath) void onOpenPath(c.path);
                  }}
                  title={`Open ${c.name}`}
                >
                  <div className="databases-list-row">
                    <span className="databases-list-name">{c.name}</span>
                    <span className="databases-list-count">
                      {c.itemCount} article{c.itemCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="databases-list-desc">{c.description}</p>
                  {!c.isBuiltin && (
                    <div className="databases-list-meta">
                      <span className="databases-list-tag">custom</span>
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    if (source.kind === "filestores-list") {
      return (
        <div className="viewer-summary">
          <ul className="databases-list">
            {source.collections.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className="databases-list-item"
                  onClick={() => {
                    if (onOpenPath) void onOpenPath(c.path);
                  }}
                  title={`Open ${c.name}`}
                >
                  <div className="databases-list-row">
                    <span className="databases-list-name">{c.name}</span>
                    <span className="databases-list-count">
                      {c.itemCount} {c.itemNoun}{c.itemCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="databases-list-desc">{c.description}</p>
                  {!c.isBuiltin && (
                    <div className="databases-list-meta">
                      <span className="databases-list-tag">custom</span>
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    // `filestores/attachments/` welcome stub + per-ticket roll-up.
    // The lead paragraph explains what lives in this folder so an
    // admin clicking it for the first time understands the split
    // from `library/`. Below, one card per ticket subfolder routes
    // back to the conversation thread — that's where attachments
    // belong contextually, alongside the messages they came in
    // with.
    if (source.kind === "attachments-folder") {
      return (
        <div className="viewer-summary">
          {source.tickets.length === 0 ? (
            <p className="summary-desc">
              No attachments yet. Files dropped into a chat or admin reply land here, grouped by ticket.
            </p>
          ) : (
            <ul className="databases-list">
              {source.tickets.map((t) => (
                <li key={t.ticketId}>
                  <button
                    type="button"
                    className="databases-list-item"
                    onClick={() => {
                      // Jump to the conversation thread, not the raw
                      // attachments folder — that's where the files
                      // make sense.
                      if (onOpenPath && repo) {
                        void onOpenPath(`${repo}/databases/conversations/${t.ticketId}`);
                      }
                    }}
                    title={`Open conversation for ${t.ticketId}`}
                  >
                    <div className="databases-list-row">
                      <span className="databases-list-name">{t.ticketId}</span>
                      <span className="databases-list-count">
                        {t.fileCount} file{t.fileCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    // Top-level `databases/` parent. Each subfolder is a collection
    // with its own row format (datastore-table for tickets/people,
    // conversations-list for conversations). The parent view here
    // surfaces an at-a-glance overview — name, item count, schema
    // status — so the user sees the shape of their data without
    // expanding every folder. Click a card → onOpenPath routes into
    // the per-collection viewer.
    if (source.kind === "databases-list") {
      if (source.collections.length === 0) {
        return (
          <div className="viewer-summary">
            <p className="summary-desc">
              No collections yet. Collections are JSON-backed tables that hold tickets,
              people, conversations, and any custom entities you create. Ask Claude —
              <em> "create a collection for inventory items"</em> — and it will scaffold
              one under <code>databases/</code> with a starter schema.
            </p>
          </div>
        );
      }
      return (
        <div className="viewer-summary">
          <ul className="databases-list">
            {source.collections.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className="databases-list-item"
                  onClick={() => {
                    if (onOpenPath) void onOpenPath(c.path);
                  }}
                  title={`Open ${c.name}`}
                >
                  <div className="databases-list-row">
                    <span className="databases-list-name">{c.name}</span>
                    <span className="databases-list-count">
                      {c.itemCount} {c.name === "conversations" ? "thread" : "row"}{c.itemCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="databases-list-meta">
                    <span className="databases-list-tag">
                      {c.hasSchema ? "schema" : "schema-less"}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    // Generic top-level entity folder (agents/, workflows/, knowledge-
    // base/, filestore/). Empty → friendly notice, same affordance the
    // conversations-list provides. Non-empty → simple file list whose
    // entries route through onOpenPath so per-file viewers (agent /
    // workflow / file) take over on click.
    if (source.kind === "entity-folder") {
      const isReports = source.entity === "reports";
      const onGenerateOverview = async () => {
        if (!repo || reportRunning) return;
        setReportRunning(true);
        setReportError(null);
        try {
          const relPath = await reportOverviewRun(repo);
          // The script writes to disk; the watcher will refresh the
          // explorer. Jump the viewer to the new file so the admin
          // sees the result immediately rather than scrolling for it.
          if (onOpenPath) void onOpenPath(`${repo}/${relPath}`);
        } catch (e) {
          setReportError(e instanceof Error ? e.message : String(e));
        } finally {
          setReportRunning(false);
        }
      };
      const reportsHeader = isReports ? (
        <div className="viewer-summary-actions">
          <button
            type="button"
            className="viewer-edit-btn viewer-edit-btn-primary"
            onClick={onGenerateOverview}
            disabled={reportRunning || !repo}
          >
            {reportRunning ? "Generating…" : "Generate overview"}
          </button>
          {reportError && (
            <span className="viewer-edit-error">{reportError}</span>
          )}
        </div>
      ) : null;
      if (source.files.length === 0) {
        return (
          <div className="viewer-summary">
            {reportsHeader}
            <p className="summary-desc">{ENTITY_FOLDER_EMPTY_COPY[source.entity]}</p>
          </div>
        );
      }
      return (
        <div className="viewer-summary">
          {reportsHeader}
          <ul className="entity-folder-list">
            {source.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className="entity-folder-item"
                  onClick={() => {
                    if (onOpenPath) void onOpenPath(f.path);
                  }}
                  // Surface the full description on hover for long
                  // strings the line-clamp truncates.
                  title={f.description ? `${f.displayName} — ${f.description}` : `Open ${f.name}`}
                >
                  <span className="entity-folder-name">{f.displayName}</span>
                  {f.description && (
                    <span className="entity-folder-desc">{f.description}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    // Conversation thread — chat-style bubbles, ordered by timestamp.
    // The Add-to-Claude affordance is rendered inline with the title
    // up in the viewer-header (see below) — keeping this body clean.
    if (source.kind === "conversation-thread") {
      const turns = source.turns;
      const ticketId = source.ticketId;
      const sendReply = async () => {
        const trimmed = replyText.trim();
        // Allow attachment-only replies (admin drops a screenshot
        // showing the fix and sends without typing). Otherwise text
        // is required.
        if (!repo) return;
        if (!trimmed && replyAttachments.length === 0) return;
        setReplySending(true);
        setReplyError(null);
        try {
          const { entityWriteFile } = await import("../lib/api");
          const nowMs = Date.now();
          const rand = Math.random().toString(36).slice(2, 6);
          const msgId = `msg-${nowMs}-${rand}`;
          const isoNow = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          const sender = adminEmail ?? "admin";
          const payload: Record<string, unknown> = {
            id: msgId,
            ticketId,
            role: "admin",
            sender,
            timestamp: isoNow,
            body: trimmed || "(attachment)",
          };
          if (replyAttachments.length > 0) {
            payload.attachments = replyAttachments.map((a) => a.path);
          }
          await entityWriteFile(
            repo,
            `databases/conversations/${ticketId}`,
            `${msgId}.json`,
            JSON.stringify(payload, null, 2),
          );
          setReplyText("");
          setReplyAttachments([]);
          // Bumping the ticket back to `open` (it might be at
          // escalated / resolved / closed). Done as a best-effort
          // optimistic write — the auto-commit driver picks both
          // files up. If reading the ticket fails (e.g. file
          // missing), skip without surfacing a hard error since the
          // reply itself succeeded.
          try {
            const { fsRead } = await import("../lib/api");
            const ticketPath = `${repo}/databases/tickets/${ticketId}.json`;
            const raw = await fsRead(ticketPath);
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            parsed.status = "open";
            parsed.updatedAt = isoNow;
            if (typeof parsed.assignee !== "string" || !parsed.assignee) {
              parsed.assignee = sender;
            }
            await entityWriteFile(
              repo,
              "databases/tickets",
              `${ticketId}.json`,
              JSON.stringify(parsed, null, 2),
            );
          } catch (e) {
            console.warn("[viewer] reply: ticket update skipped:", e);
          }
        } catch (err) {
          setReplyError(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setReplySending(false);
        }
      };
      return (
        <div className="viewer-thread-wrapper">
          {turns.length === 0 ? (
            <div className="viewer-summary">
              <p className="summary-desc">No turns logged yet for this thread.</p>
            </div>
          ) : (
            <div className="viewer-thread">
              {turns.map((t) => {
                const isAsker = t.role === "asker";
                return (
                  <div
                    key={t.id}
                    className={`thread-turn ${isAsker ? "thread-turn-asker" : "thread-turn-agent"}`}
                  >
                    <div className="thread-turn-meta">
                      <span className="thread-turn-sender">{t.sender || t.role}</span>
                      <span className="thread-turn-role">{t.role}</span>
                      {t.timestamp && (
                        <span className="thread-turn-time">{t.timestamp}</span>
                      )}
                    </div>
                    <div className="thread-turn-body">{t.body}</div>
                    {t.attachments && t.attachments.length > 0 && (
                      <AttachmentList attachments={t.attachments} repo={repo} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div
            className={`thread-reply-composer${replyDragOver ? " thread-reply-composer-drag" : ""}`}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes("Files")) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                setReplyDragOver(true);
              }
            }}
            onDragLeave={() => setReplyDragOver(false)}
            onDrop={async (e) => {
              setReplyDragOver(false);
              const files = Array.from(e.dataTransfer.files ?? []);
              if (files.length === 0 || !repo) return;
              e.preventDefault();
              e.stopPropagation();
              const { entityWriteFileBytes } = await import("../lib/api");
              const subdir = `filestores/attachments/${ticketId}`;
              const newAttachments: { path: string; filename: string }[] = [];
              for (const f of files) {
                const filename = f.name || "upload";
                try {
                  const buf = await f.arrayBuffer();
                  await entityWriteFileBytes(repo, subdir, filename, buf);
                  newAttachments.push({
                    path: `${subdir}/${filename}`,
                    filename,
                  });
                } catch (err) {
                  console.error(`[admin-reply] failed to attach ${filename}:`, err);
                }
              }
              if (newAttachments.length > 0) {
                setReplyAttachments((prev) => [...prev, ...newAttachments]);
              }
            }}
          >
            {replyAttachments.length > 0 && (
              <div className="thread-reply-chips">
                {replyAttachments.map((att) => (
                  <span key={att.path} className="thread-reply-chip">
                    <span className="thread-reply-chip-name">{att.filename}</span>
                    <button
                      type="button"
                      className="thread-reply-chip-remove"
                      onClick={() =>
                        setReplyAttachments((prev) =>
                          prev.filter((a) => a.path !== att.path),
                        )
                      }
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              className="thread-reply-input"
              placeholder={`Reply as ${adminEmail ?? "admin"} (drop files to attach)…`}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl + Enter sends — matches Slack / iMessage.
                // Plain Enter inserts a newline so multi-line replies
                // are easy.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void sendReply();
                }
              }}
              rows={2}
              disabled={replySending}
            />
            <div className="thread-reply-footer">
              {replyError && (
                <span className="thread-reply-error">{replyError}</span>
              )}
              <span className="thread-reply-hint">⌘↩ to send · drop files to attach</span>
              <button
                type="button"
                className="viewer-edit-btn viewer-edit-btn-primary"
                onClick={() => void sendReply()}
                disabled={
                  replySending ||
                  (!replyText.trim() && replyAttachments.length === 0)
                }
              >
                {replySending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Deploy / diff
    return <pre className="viewer-content">{content}</pre>;
  };

  return (
    <div className="viewer">
      <div className="viewer-header">
        {source && source.kind === "conversation-thread" && onOpenPath && (
          <button
            type="button"
            className="viewer-back-btn"
            onClick={() => {
              // Navigate back to the parent conversations list. The
              // filter pill state lives in this Viewer instance and
              // is preserved across the round-trip — clicking back
              // lands on the same `Open` / `All` / `Resolved` /
              // `Escalated` selection the user had before opening
              // the thread.
              void onOpenPath(`${repo}/databases/conversations`);
            }}
            title="Back to conversations"
            aria-label="Back to conversations"
          >
            ←
          </button>
        )}
        <span className="viewer-title">{title}</span>
        {source && source.kind === "conversation-thread" && (
          <button
            type="button"
            className="viewer-add-btn"
            onClick={() => {
              const path = `${repo}/databases/conversations/${source.ticketId}`;
              writeToActiveSession(path + " ").catch((e) =>
                console.warn("[viewer] add-to-claude failed:", e),
              );
            }}
            title="Reference this conversation in Claude"
          >
            Add to Claude
          </button>
        )}
        {showFileTabs && (
          <div className="viewer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={mode === "rendered"}
              className={`viewer-tab ${mode === "rendered" ? "active" : ""}`}
              onClick={() => setMode("rendered")}
            >
              View
            </button>
            <button
              role="tab"
              aria-selected={mode === "edit"}
              className={`viewer-tab ${mode === "edit" ? "active" : ""}`}
              onClick={() => {
                // Seed the draft with the current content the first
                // time edit mode is entered, but don't clobber an
                // in-progress draft on a re-click of Edit.
                if (mode !== "edit") setEditDraft(content);
                setEditError(null);
                setMode("edit");
              }}
            >
              Edit
            </button>
          </div>
        )}
        {showRowTabs && (
          <div className="viewer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={mode === "table"}
              className={`viewer-tab ${mode === "table" ? "active" : ""}`}
              onClick={() => setMode("table")}
            >
              View
            </button>
            <button
              role="tab"
              aria-selected={mode === "edit"}
              className={`viewer-tab ${mode === "edit" ? "active" : ""}`}
              onClick={() => {
                // Seed the form with the current row content the
                // first time edit mode is entered. Re-clicking Edit
                // while already editing keeps the in-progress draft.
                if (mode !== "edit" && source && source.kind === "datastore-row") {
                  const liveItem = rowOverride ?? source.item;
                  const raw = liveItem.content;
                  let parsed: Record<string, unknown> = {};
                  if (raw && typeof raw === "object") {
                    parsed = { ...(raw as Record<string, unknown>) };
                  } else if (typeof raw === "string") {
                    try {
                      parsed = JSON.parse(raw) as Record<string, unknown>;
                    } catch {
                      parsed = {};
                    }
                  }
                  setRowEditDraft(parsed);
                }
                setEditError(null);
                setMode("edit");
              }}
            >
              Edit
            </button>
            <button
              role="tab"
              aria-selected={mode === "raw"}
              className={`viewer-tab ${mode === "raw" ? "active" : ""}`}
              onClick={() => setMode("raw")}
            >
              Raw
            </button>
          </div>
        )}
        {showCopy && (
          <button
            type="button"
            className="viewer-copy-btn"
            onClick={handleCopy}
            title="Copy contents to clipboard"
          >
            {copyState === "copied" ? "Copied!" : "Copy"}
          </button>
        )}
      </div>
      {renderBody()}
    </div>
  );
}
