import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fsRead, fsReadBytes, fsList, fsReveal, reportOverviewRun, entityWriteFileBytes, entityDeleteFile, entityListLocal } from "../lib/api";
import { loadCreds } from "../lib/pinkfishAuth";
import { fetchDatastoreItems } from "../lib/datastoreSync";
import type { MemoryItem } from "../lib/skillsApi";
import { DataTable } from "./DataTable";
import { EntityCardGrid } from "./EntityCardGrid";
import { FileThumbnail, isImageFile } from "./FileThumbnail";
import { EntityBadge, type EntityKind } from "./entityIcons";
import { ToolsPanel } from "./ToolsPanel";
import { TrashIcon } from "./TrashIcon";
import { useToast } from "../Toast";
import { FileTypeBadge, formatBytes } from "./FileTypeBadge";
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

/// Land each dropped file into `<repo>/<subdir>/<filename>`. Used by
/// every drag-from-desktop affordance on entity-folder views and on
/// the filestores/knowledge-bases collection cards. On any failure
/// the error string is set via `setError` so the call site can render
/// it; successes are silent because the fs watcher refreshes the
/// folder listing on its own.
/// Some sources (filestores-list, knowledge-bases-list) carry the
/// collection's absolute on-disk path because that's what `fsList`
/// returns. The Rust write commands require a repo-relative subdir
/// (the `validate_subdir` guard rejects absolute paths to prevent
/// writes outside the repo). Strip the repo prefix when present;
/// otherwise return the path as-is and let the validator complain
/// with a useful message.
function toRepoRelative(repo: string, path: string): string {
  const r = repo.endsWith("/") ? repo : `${repo}/`;
  if (path.startsWith(r)) return path.slice(r.length);
  if (path === repo) return "";
  return path;
}

async function uploadFilesToSubdir(
  repo: string,
  subdir: string,
  files: File[],
  setError: (msg: string | null) => void,
  onToast?: (msg: string) => void,
): Promise<void> {
  const relSubdir = toRepoRelative(repo, subdir);
  setError(null);
  // Pre-flight: discover any same-named files already on disk so we
  // can ask once for the whole drop instead of one prompt per file.
  let existing = new Set<string>();
  try {
    const listed = await entityListLocal(repo, relSubdir);
    existing = new Set(listed.map((f) => f.filename));
  } catch {
    /* fresh dir — nothing to clobber */
  }
  // Sanitize once per file. A second pass de-duplicates within the
  // batch itself: if two dropped files sanitize to the same name
  // (e.g. `file:1.txt` and `file/1.txt` both become `file-1.txt`,
  // or two files with identical names from different source dirs),
  // we suffix collisions with `-2`, `-3`, … so neither write
  // silently overwrites the other.
  const usedInBatch = new Set<string>();
  const intended = files.map((f) => {
    const base = sanitizeUploadFilename(f.name || "upload");
    let filename = base;
    if (usedInBatch.has(filename)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let i = 2;
      while (usedInBatch.has(`${stem}-${i}${ext}`)) i += 1;
      filename = `${stem}-${i}${ext}`;
    }
    usedInBatch.add(filename);
    return { file: f, filename };
  });
  const collisions = intended.filter((i) => existing.has(i.filename));
  if (collisions.length > 0) {
    const list =
      collisions.length === 1
        ? `"${collisions[0].filename}"`
        : `${collisions.length} files (${collisions
            .map((c) => c.filename)
            .slice(0, 3)
            .join(", ")}${collisions.length > 3 ? "…" : ""})`;
    const ok = window.confirm(
      `${list} already exist${collisions.length === 1 ? "s" : ""} in this folder.\n\nReplace?`,
    );
    if (!ok) return;
  }
  const failed: { name: string; reason: string }[] = [];
  let succeeded = 0;
  for (const { file: f, filename } of intended) {
    try {
      const buf = await f.arrayBuffer();
      await entityWriteFileBytes(repo, relSubdir, filename, buf);
      succeeded += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[folder-upload] failed for ${filename}:`, err);
      failed.push({ name: filename, reason });
    }
  }
  if (failed.length > 0) {
    setError(
      `Failed to upload: ${failed
        .map((f) => `${f.name} (${f.reason})`)
        .join(", ")}`,
    );
  }
  if (succeeded > 0 && onToast) {
    onToast(
      succeeded === 1
        ? `Uploaded ${intended.find((i) => !failed.some((f) => f.name === i.filename))?.filename ?? "file"}`
        : `Uploaded ${succeeded} files`,
    );
  }
}

/// Confirm + delete a single file in an entity folder. Used by the
/// trash button on library/KB/reports/attachments-ticket cards. The
/// fs watcher refreshes the listing on its own — we just surface
/// errors so the user knows when a delete didn't take.
async function deleteFileInSubdir(
  repo: string,
  subdir: string,
  filename: string,
  setError: (msg: string | null) => void,
  onToast?: (msg: string) => void,
): Promise<void> {
  const ok = window.confirm(`Delete "${filename}"?\n\nThis cannot be undone.`);
  if (!ok) return;
  setError(null);
  try {
    await entityDeleteFile(repo, toRepoRelative(repo, subdir), filename);
    onToast?.(`Deleted ${filename}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[folder-delete] failed for ${filename}:`, err);
    setError(`Failed to delete ${filename}: ${reason}`);
  }
}

/// Filenames that survive Finder (narrow no-break space, colons,
/// stray Unicode whitespace) routinely break the sync push and other
/// downstream tools that assume POSIX-safe names. Normalize before
/// the write so what lands on disk matches what later consumers will
/// accept. Rules: collapse any Unicode whitespace run to a single
/// ASCII space, strip characters that are unsafe on at least one
/// major filesystem (`/ \ : * ? " < > |`), and trim. Always preserves
/// the extension.
function sanitizeUploadFilename(name: string): string {
  const cleaned = name
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim();
  return cleaned.length > 0 ? cleaned : "upload";
}

/// Title labels for the entity-folder view. Capital case for the title
/// bar; the explorer rows use the lowercase folder names directly.
const ENTITY_FOLDER_LABELS: Record<
  | "agents"
  | "workflows"
  | "knowledge-base"
  | "library"
  | "reports"
  | "skills"
  | "scripts"
  | "attachments-ticket",
  string
> = {
  agents: "Agents",
  workflows: "Workflows",
  "knowledge-base": "Knowledge base",
  library: "Library",
  reports: "Reports",
  skills: "Skills",
  scripts: "Scripts",
  "attachments-ticket": "Attachments",
};

/// Friendly empty-state copy per top-level entity folder, mirroring the
/// conversations-list notice. Each message says what lives here, why it
/// is empty, and the natural way to populate it.
const ENTITY_FOLDER_EMPTY_COPY: Record<
  | "agents"
  | "workflows"
  | "knowledge-base"
  | "library"
  | "reports"
  | "skills"
  | "scripts"
  | "attachments-ticket",
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
    "No reports yet. Click \"Overview\" above for an instant snapshot of ticket status, recent activity, top askers, and current escalations — or click \"Ask Claude\" to describe a custom report (\"VPN tickets last 30 days\", \"escalations by asker\").",
  skills:
    "No skills yet. Skills capture admin workflows — markdown prompts Claude (or you) read and follow when a similar ticket comes back around. They land here automatically when you click \"Mark as resolved\" on a ticket whose resolution had branches or judgment calls. You can also ask Claude to draft one directly.",
  scripts:
    "No scripts yet. Scripts capture deterministic admin workflows — runnable code (Node / shell / Python) that always does the same thing for the same inputs. They land here automatically when you click \"Mark as resolved\" on a ticket whose resolution was a fixed CLI / API sequence. You can also ask Claude to draft one directly.",
  "attachments-ticket":
    "No attachments on this ticket yet. Files dropped into the chat or admin reply will land here.",
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
  // openit://cloud-cta — opens the cloud CTA page in the center pane.
  // Used by the welcome doc's "Connect to Cloud" link so it routes
  // through the same pitch-page surface as the header pill, sync
  // panel, and command palette (instead of pasting a skill command
  // into Claude). App.tsx listens for the event and calls into the
  // Shell-registered showCloudCta handler.
  // `openit://skill/connect-to-cloud` is the legacy URL that older
  // welcome docs still ship with — re-route it to the same CTA event
  // so existing projects don't try to paste a non-existent skill.
  if (href === "openit://cloud-cta" || href === "openit://skill/connect-to-cloud") {
    return (
      <a
        href="#"
        data-openit-cta="cloud"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("openit:show-cloud-cta"));
        }}
        {...rest}
      >
        {children}
      </a>
    );
  }
  // openit://connect-cloud — kicks off the OAuth flow directly. Used by
  // the connect-to-cloud markdown's primary CTA. Distinct from
  // `openit://cloud-cta` (which opens the pitch page); this one starts
  // the browser handoff. App.tsx listens and calls browserConnect.start().
  if (href === "openit://connect-cloud") {
    return (
      <a
        href="#"
        data-openit-cta="connect-cloud"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("openit:start-cloud-onboarding"));
        }}
        {...rest}
      >
        {children}
      </a>
    );
  }
  // openit://create-samples — populates the workspace with bundled
  // sample tickets / people / conversations / KB articles. App.tsx
  // listens and calls into seedIfEmpty (per-target local-empty gate,
  // so re-clicks after content exists are no-ops).
  if (href === "openit://create-samples") {
    return (
      <a
        href="#"
        data-openit-cta="create-samples"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("openit:create-samples"));
        }}
        {...rest}
      >
        {children}
      </a>
    );
  }
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
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
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
  /** Browser-style back/forward across the center-pane view history.
   *  Wired by Shell so every page gets the same pair of arrows in
   *  the viewer header instead of relying on per-page back buttons. */
  onGoBack?: () => void;
  onGoForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
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

  // People view-mode toggle (Cards / Table). Default cards; sticks
  // for the lifetime of this Viewer instance so flipping into a
  // ticket and back doesn't reset the admin's preferred mode.
  const [peopleView, setPeopleView] = useState<"cards" | "table">("cards");

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
  // Drag-from-desktop into an open entity-folder (library /
  // knowledge-base). Mirrors the reply-composer affordance — drop
  // files anywhere in the card grid and they land in the folder's
  // subdir on disk; the fs watcher re-resolves the folder so they
  // show up as new cards without a manual refresh.
  const [folderDragOver, setFolderDragOver] = useState(false);
  const [folderUploadError, setFolderUploadError] = useState<string | null>(null);
  // v5: the in-viewer ToastView was removed. The global ToastProvider
  // (mounted in main.tsx via src/Toast.tsx) renders all toasts at the
  // window's bottom-right via the unified <Toast> primitive.
  const { show: showToast } = useToast();
  // Reverse the entity-folder card order. Default is the routing
  // layer's natural order (alphabetical for files, newest-first for
  // reports). Per-folder via source.path so flipping one folder's
  // sort doesn't bleed into another.
  const [sortReversed, setSortReversed] = useState<Record<string, boolean>>({});
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
    setFolderDragOver(false);
    setFolderUploadError(null);
    // Reset the Generate-overview button alongside the other view-
    // specific state so a stale failure message doesn't follow the
    // user when they navigate away from reports/ and back.
    setReportRunning(false);
    setReportError(null);
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
    if (source.kind === "agent-trace") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "people-list") {
      setMode("rendered");
      setContent("");
      return;
    }
    if (source.kind === "tools") {
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
            items.push({ id: key, key, sortField: key, content, createdAt: "", updatedAt: "" });
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
      case "file": return source.path.split("/").pop() ?? source.path;
      case "sync": return "Sync output";
      case "diff": return "Git diff";
      case "datastore-table": return source.collection?.name ?? "Datastore";
      case "datastore-schema": return `${source.collection?.name ?? "Datastore"} — Schema`;
      case "datastore-row": return `${source.collection?.name ?? "Datastore"} / ${source.item?.key || source.item?.id || "Row"}`;
      case "agent": return source.agent?.name ?? "Agent";
      case "workflow": return source.workflow?.name ?? "Workflow";
      case "conversation-thread": return `Conversation — ${source.ticketId}`;
      case "conversations-list": return "Inbox";
      case "entity-folder": {
        // For KB collections, surface the collection name (e.g.
        // "Knowledge — default") so the admin can tell which KB they
        // are in when more than one exists. Other entity-folder kinds
        // get their bare label — the EntityBadge's tinted glyph
        // already signals the kind and the cards below show the
        // count.
        if (source.entity === "knowledge-base") {
          const m = source.path.match(/^knowledge-bases\/([^/]+)$/);
          const colName = m ? m[1] : "default";
          return `Knowledge — ${colName}`;
        }
        return ENTITY_FOLDER_LABELS[source.entity];
      }
      case "databases-list":     return "Databases";
      case "filestores-list":    return "Files";
      case "attachments-folder": return "Attachments";
      case "knowledge-bases-list": return "Knowledge";
      case "agent-trace":
        return `Agent trace — ${source.subject}`;
      case "agent-trace-list":
        return `Agent traces — ${source.subject} (${source.docs.length} turn${source.docs.length === 1 ? "" : "s"})`;
      case "people-list":        return "People";
      case "tools": return "Tools";
      default: return "";
    }
  };
  const title = getTitle();

  // --- Tabs ---
  const showFileTabs = source.kind === "file" && isMarkdown(source.path);
  const showRowTabs = source.kind === "datastore-row";
  const showPeopleTabs = source.kind === "people-list";
  const showConversationsFilter = source.kind === "conversations-list";

  // Path used by the "add to chat →" header link. Any source that maps
  // to a real on-disk file or folder Claude can reference goes through
  // this — keeps the link offer consistent across viewers without
  // per-source render branches in the header.
  const chatAddPath: string | null = (() => {
    if (!source) return null;
    if (source.kind === "file") return source.path;
    if (source.kind === "conversation-thread")
      return `${repo}/databases/conversations/${source.ticketId}`;
    if (source.kind === "datastore-row")
      return `${repo}/databases/${source.collection.name}/${source.item.key || source.item.id}.json`;
    if (source.kind === "datastore-table")
      return `${repo}/databases/${source.collection.name}`;
    if (source.kind === "datastore-schema")
      return `${repo}/databases/${source.collection.name}/_schema.json`;
    if (source.kind === "entity-folder") {
      // Reports already has dedicated header actions (generate
      // overview / ask for custom report) — a generic "add to chat"
      // link there would feel redundant.
      if (source.entity === "reports") return null;
      return `${repo}/${source.path}`;
    }
    if (source.kind === "people-list") return `${repo}/databases/people`;
    if (source.kind === "conversations-list")
      return `${repo}/databases/conversations`;
    if (source.kind === "agent")
      return `${repo}/agents/${source.agent.id || source.agent.name}.json`;
    if (source.kind === "workflow")
      return `${repo}/workflows/${source.workflow.id || source.workflow.name}.json`;
    return null;
  })();

  // Ticket id for the "Conversation" header link on attachments
  // subfolders (filestores/attachments/<ticketId>/). Lets admins jump
  // from the file list back to the related thread without re-walking
  // the file tree.
  const attachmentsTicketId: string | null =
    source && source.kind === "entity-folder" && source.entity === "attachments-ticket"
      ? source.path.replace(/^filestores\/attachments\//, "")
      : null;

  // Pre-compute conversation status counts so the header pills can
  // display them without re-walking on each render frame. Memoising
  // would be overkill — the array is small and reads from the same
  // reference until fsTick triggers a new resolver run.
  const conversationCounts: Record<
    "all" | "open" | "resolved" | "escalated",
    number
  > = { all: 0, open: 0, resolved: 0, escalated: 0 };
  if (source.kind === "conversations-list") {
    conversationCounts.all = source.threads.length;
    for (const t of source.threads) {
      if (t.status === "open" || t.status === "agent-responding") {
        conversationCounts.open += 1;
      } else if (t.status === "resolved" || t.status === "closed") {
        conversationCounts.resolved += 1;
      } else if (t.status === "escalated") {
        conversationCounts.escalated += 1;
      }
    }
  }
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
              remarkPlugins={[remarkGfm]}
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
          onRowDelete={
            repo
              ? (key) =>
                  deleteFileInSubdir(
                    repo,
                    `databases/${source.collection.name}`,
                    `${key}.json`,
                    setFolderUploadError,
                    showToast,
                  )
              : undefined
          }
        />
      );
    }

    // Datastore row view
    if (source.kind === "datastore-row") {
      const liveItem = rowOverride ?? source.item;
      if (mode === "table") {
        // Vertical label/value summary instead of a single-row table.
        // A single row in a wide-column table forces horizontal scroll
        // and hides everything past the first 3-4 fields; a vertical
        // form is far easier to scan when reading one row at a time.
        // (Multi-row tables still use DataTable — that's where the
        // horizontal layout pays off.)
        const fields = (source.collection.schema?.fields ?? []) as Array<{
          id: string;
          label?: string;
          type?: string;
          values?: string[];
          nullable?: boolean;
        }>;
        const content =
          liveItem.content && typeof liveItem.content === "object"
            ? (liveItem.content as Record<string, unknown>)
            : {};
        const renderValue = (
          field: { id: string; type?: string },
          value: unknown,
        ): ReactNode => {
          const empty =
            value === null ||
            value === undefined ||
            (typeof value === "string" && value === "") ||
            (Array.isArray(value) && value.length === 0);
          if (empty) {
            return <span className="row-view-empty">—</span>;
          }
          if (field.type === "string[]" && Array.isArray(value)) {
            return (
              <div className="row-view-tags">
                {value.map((v, i) => (
                  <span key={i} className="thread-card-tag">
                    {String(v)}
                  </span>
                ))}
              </div>
            );
          }
          if (field.type === "text" && typeof value === "string") {
            return <div className="row-view-text">{value}</div>;
          }
          if (typeof value === "boolean") {
            return <span>{value ? "Yes" : "No"}</span>;
          }
          if (typeof value === "object") {
            return <code className="row-view-code">{JSON.stringify(value)}</code>;
          }
          return <span>{String(value)}</span>;
        };
        return (
          <div className="row-view">
            <div className="row-view-key">
              <span className="row-view-key-label">Key</span>
              <code className="row-view-code">{liveItem.key || liveItem.id}</code>
            </div>
            <dl className="row-view-fields">
              {fields.map((field) => (
                <div key={field.id} className="row-view-field">
                  <dt>{field.label ?? field.id}</dt>
                  <dd>{renderValue(field, content[field.id])}</dd>
                </div>
              ))}
            </dl>
          </div>
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.instructions}</ReactMarkdown>
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
      // Status filter pills live in the viewer-header now (see
      // `showConversationsFilter` below). The body just renders the
      // filtered list.
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
      const filterCaption: Record<typeof conversationsFilter, string> = {
        all: "All tickets across every status.",
        open: "Agent is working with the person, awaiting their reply.",
        resolved: "Tickets marked as resolved.",
        escalated: "Agent needs help solving.",
      };
      return (
        <div className="viewer-summary viewer-conversations">
          <p className="viewer-list-caption">{filterCaption[conversationsFilter]}</p>
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
                  {t.tags.length > 0 && (
                    <div className="thread-card-tags">
                      {t.tags.map((tag) => (
                        <span key={tag} className="thread-card-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    // People directory — card or table view, toggled in the
    // top-right of the viewer header (see `showPeopleTabs` below).
    if (source.kind === "people-list") {
      const view = peopleView;
      if (view === "table") {
        return (
          <div className="viewer-summary viewer-people">
            {folderUploadError && (
              <p className="viewer-edit-error">{folderUploadError}</p>
            )}
            <DataTable
              collection={source.collection}
              items={source.items}
              onRowClick={(key) => {
                const filePath = `${repo}/databases/${source.collection.name}/${key}.json`;
                writeToActiveSession(filePath + " ");
              }}
              onRowDelete={
                repo
                  ? (key) =>
                      deleteFileInSubdir(
                        repo,
                        `databases/${source.collection.name}`,
                        `${key}.json`,
                        setFolderUploadError,
                        showToast,
                      )
                  : undefined
              }
            />
          </div>
        );
      }

      if (source.people.length === 0) {
        return (
          <div className="viewer-summary viewer-people">
            <p className="summary-desc">
              No people yet. Anyone who files a ticket lands here so we can
              identify askers consistently across tickets and channels.
            </p>
          </div>
        );
      }

      return (
        <div className="viewer-summary viewer-people">
          {folderUploadError && (
            <p className="viewer-edit-error">{folderUploadError}</p>
          )}
          <div className="viewer-thread-list">
            {source.people.map((p) => (
              <div key={p.key} className="thread-card-wrapper">
                <button
                  type="button"
                  className="thread-card thread-card-person"
                  onClick={() => {
                    if (onOpenPath) {
                      void onOpenPath(`${repo}/databases/people/${p.key}.json`);
                    }
                  }}
                  title={`Open ${p.name || p.email || p.key}`}
                >
                  <div className="thread-card-row">
                    <span className="thread-card-subject">
                      {p.name || p.email || p.key}
                    </span>
                    {p.role && (
                      <span className="thread-card-status">{p.role}</span>
                    )}
                  </div>
                  <div className="thread-card-meta">
                    {p.email && p.email !== p.name && (
                      <span className="thread-card-asker">{p.email}</span>
                    )}
                    {p.department && (
                      <span className="thread-card-count">{p.department}</span>
                    )}
                  </div>
                </button>
                {repo && (
                  <button
                    type="button"
                    className="entity-card-delete thread-card-delete"
                    title={`Delete ${p.name || p.email || p.key}`}
                    aria-label={`Delete ${p.name || p.email || p.key}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteFileInSubdir(
                        repo,
                        "databases/people",
                        `${p.key}.json`,
                        setFolderUploadError,
                        showToast,
                      );
                    }}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            ))}
          </div>
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
          {folderUploadError && (
            <p className="viewer-edit-error">{folderUploadError}</p>
          )}
          <EntityCardGrid
            kind="knowledge-bases"
            cards={source.collections.map((c) => ({
              key: c.path,
              title: c.name,
              description: c.description,
              meta: `${c.itemCount} article${c.itemCount === 1 ? "" : "s"}`,
              badge: c.isBuiltin
                ? undefined
                : { label: "custom", tone: "info" },
              onClick: () => onOpenPath && void onOpenPath(c.path),
              onFilesDropped: repo
                ? (files) => uploadFilesToSubdir(repo, c.path, files, setFolderUploadError, showToast)
                : undefined,
              onReveal: () => void fsReveal(c.path).catch(console.error),
            }))}
          />
        </div>
      );
    }

    if (source.kind === "filestores-list") {
      return (
        <div className="viewer-summary">
          {folderUploadError && (
            <p className="viewer-edit-error">{folderUploadError}</p>
          )}
          <EntityCardGrid
            kind="filestores"
            cards={source.collections.map((c) => ({
              key: c.path,
              title: c.name,
              description: c.description,
              meta: `${c.itemCount} ${c.itemNoun}${c.itemCount === 1 ? "" : "s"}`,
              badge: c.isBuiltin
                ? undefined
                : { label: "custom", tone: "info" },
              onClick: () => onOpenPath && void onOpenPath(c.path),
              // Attachments collection is per-ticket — dropping into the
              // generic folder would have nowhere meaningful to land. The
              // remaining built-in (`library`) and any user-created
              // filestore accept drops to their on-disk subdir.
              onFilesDropped:
                repo && c.name !== "attachments"
                  ? (files) =>
                      uploadFilesToSubdir(repo, c.path, files, setFolderUploadError, showToast)
                  : undefined,
              onReveal: () => void fsReveal(c.path).catch(console.error),
            }))}
          />
        </div>
      );
    }

    // Tools — the tools catalog. Synthetic entity (no on-disk
    // contents); the panel detects installed binaries via `which` and
    // shells out to `brew install/uninstall` for mutations.
    if (source.kind === "tools") {
      return <ToolsPanel projectRoot={repo} />;
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
          <EntityCardGrid
            kind="attachments"
            empty={
              <p className="summary-desc">
                No attachments yet. Files dropped into a chat or admin reply land here, grouped by ticket.
              </p>
            }
            cards={source.tickets.map((t) => ({
              key: t.ticketId,
              title: t.ticketId,
              meta: `${t.fileCount} file${t.fileCount === 1 ? "" : "s"}`,
              onClick: () => {
                // Open the actual attachments folder for this ticket.
                // The viewer adds a "Conversation" link in the header
                // so admins can still jump to the related thread
                // when they need context.
                if (onOpenPath) {
                  void onOpenPath(t.path);
                }
              },
              onReveal: () => void fsReveal(t.path).catch(console.error),
            }))}
          />
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
      return (
        <div className="viewer-summary">
          <EntityCardGrid
            kind="databases"
            empty={
              <p className="summary-desc">
                No collections yet. Collections are JSON-backed tables that
                hold tickets, people, conversations, and any custom entities
                you create. Ask Claude —{" "}
                <em>"create a collection for inventory items"</em> — and it
                will scaffold one under <code>databases/</code> with a
                starter schema.
              </p>
            }
            cards={source.collections.map((c) => ({
              key: c.path,
              title: c.name,
              meta: `${c.itemCount} ${
                c.name === "conversations" ? "thread" : "row"
              }${c.itemCount === 1 ? "" : "s"}`,
              onClick: () => onOpenPath && void onOpenPath(c.path),
              onReveal: () => void fsReveal(c.path).catch(console.error),
            }))}
          />
        </div>
      );
    }

    // Generic top-level entity folder (agents/, workflows/, knowledge-
    // base/, filestore/). Empty → friendly notice, same affordance the
    // conversations-list provides. Non-empty → simple file list whose
    // entries route through onOpenPath so per-file viewers (agent /
    // workflow / file) take over on click.
    if (source.kind === "entity-folder") {
      const isReport = source.entity === "reports";
      const reversed = !!sortReversed[source.path];
      const orderedFiles = reversed ? [...source.files].reverse() : source.files;
      const cards = orderedFiles.map((f) => {
        let slug = f.displayName;
        let dateLabel = "";
        if (isReport) {
          const m = f.displayName.match(
            /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2}))?-(.+)$/,
          );
          if (m) {
            const [, yyyy, mm, dd, hh, mi, parsedSlug] = m;
            slug = parsedSlug;
            const monthShort = [
              "Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ][Math.max(0, Math.min(11, Number(mm) - 1))];
            const yearTail =
              new Date().getFullYear() === Number(yyyy) ? "" : `, ${yyyy}`;
            dateLabel =
              hh && mi
                ? `${monthShort} ${Number(dd)}${yearTail} · ${hh}:${mi}`
                : `${monthShort} ${Number(dd)}${yearTail}`;
          }
        }
        // Reports flip the standard layout: description (the human-
        // readable label) becomes the title; filename + parsed date
        // become muted metadata. Other entities keep the standard
        // layout (filename as title, description as subtitle).
        // File-type glyph is shown for non-image files in library /
        // reports / attachments-ticket — surfaces (PDF, MD, CSV, …)
        // where the generic folder glyph wasted scanning real estate.
        // Agents and workflows keep their entity glyph (the kind icon)
        // because the kind itself is the meaningful tag there. Images
        // already get a thumbnail via FileThumbnail.
        const useTypeBadge =
          (source.entity === "library" ||
            source.entity === "reports" ||
            source.entity === "attachments-ticket" ||
            source.entity === "knowledge-base" ||
            source.entity === "skills" ||
            source.entity === "scripts") &&
          !isImageFile(f.path);
        const sizeLabel = formatBytes(f.size);
        return {
          key: f.path,
          title: isReport ? f.description || slug : f.displayName,
          description: isReport ? undefined : f.description,
          meta: isReport
            ? dateLabel
            : sizeLabel || undefined,
          icon: isImageFile(f.path) ? (
            <FileThumbnail absPath={f.path} />
          ) : useTypeBadge ? (
            <FileTypeBadge filename={f.name} />
          ) : undefined,
          onClick: () => onOpenPath && void onOpenPath(f.path),
          onDelete: repo
            ? () =>
                deleteFileInSubdir(repo, source.path, f.name, setFolderUploadError, showToast)
            : undefined,
          onReveal: () => void fsReveal(f.path).catch(console.error),
        };
      });
      // Drag-and-drop upload from the desktop is enabled for the two
      // user-content folders (`library/` and any KB collection).
      // Agents/workflows/reports/attachments-ticket are excluded —
      // those are either system-generated, scoped to ticket context,
      // or schema-shaped and not safe to land arbitrary files into.
      const acceptsDrop =
        source.entity === "library" ||
        source.entity === "knowledge-base" ||
        source.entity === "skills" ||
        source.entity === "scripts";
      const subdir = source.path;
      // When the folder accepts drops AND has nothing in it yet, the
      // wrapper itself becomes the visible drop zone (dashed border,
      // soft fill, "drag here" hint). Once at least one file lands,
      // the drop region collapses back to a no-chrome wrapper that
      // simply hosts the card list.
      const showDropZone = acceptsDrop && cards.length === 0;
      return (
        <div
          className={`viewer-summary${
            acceptsDrop && folderDragOver ? " viewer-summary-drag" : ""
          }${showDropZone ? " viewer-summary-dropzone" : ""}`}
          onDragOver={(e) => {
            // preventDefault is required EVERY time on a file dragover
            // — even when this folder doesn't accept drops. The HTML5
            // spec only fires `drop` on elements whose `dragover` was
            // prevented; without this, the Tauri webview falls back to
            // the OS default and navigates away from the SPA when the
            // user releases the file. The acceptsDrop branch only
            // controls whether we paint the highlight.
            if (!Array.from(e.dataTransfer.types).includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            if (!acceptsDrop || !repo) {
              e.dataTransfer.dropEffect = "none";
              return;
            }
            e.dataTransfer.dropEffect = "copy";
            setFolderDragOver(true);
          }}
          onDragLeave={() => {
            if (acceptsDrop) setFolderDragOver(false);
          }}
          onDrop={async (e) => {
            // preventDefault MUST run before any early return —
            // without it the Tauri webview falls back to its default
            // drop behavior (navigate to the file URL) and unloads
            // the SPA. Stop / reset state up-front for the same
            // reason: the dashed outline must clear regardless of
            // payload or accepts-drop check.
            e.preventDefault();
            e.stopPropagation();
            setFolderDragOver(false);
            if (!acceptsDrop || !repo) return;
            const files = Array.from(e.dataTransfer.files ?? []);
            if (files.length === 0) return;
            await uploadFilesToSubdir(repo, subdir, files, setFolderUploadError, showToast);
          }}
        >
          {source.entity === "reports" && reportError && (
            <p className="viewer-edit-error">{reportError}</p>
          )}
          {folderUploadError && (
            <p className="viewer-edit-error">{folderUploadError}</p>
          )}
          {cards.length > 1 && (
            <div className="viewer-folder-toolbar">
              <button
                type="button"
                className="viewer-folder-sort"
                onClick={() =>
                  setSortReversed((prev) => ({
                    ...prev,
                    [source.path]: !prev[source.path],
                  }))
                }
                title="Reverse sort order"
              >
                {isReport
                  ? reversed
                    ? "oldest first"
                    : "newest first"
                  : reversed
                    ? "Z → A"
                    : "A → Z"}
              </button>
            </div>
          )}
          <EntityCardGrid
            kind={source.entity === "attachments-ticket" ? "attachments" : source.entity}
            cards={cards}
            empty={
              <p className="summary-desc">
                {ENTITY_FOLDER_EMPTY_COPY[source.entity]}
                {showDropZone && (
                  <span className="viewer-summary-dropzone-hint">
                    Drop files here from Finder to add them.
                  </span>
                )}
              </p>
            }
          />
        </div>
      );
    }

    // Conversation thread — chat-style bubbles, ordered by timestamp.
    // The Add-to-Claude affordance is rendered inline with the title
    // up in the viewer-header (see below) — keeping this body clean.
    if (source.kind === "conversation-thread") {
      const turns = source.turns;
      const ticketId = source.ticketId;

      /// Write a single admin turn to disk + bump the ticket back to
      /// `open`. Shared between the textarea Send path and the
      /// drag-drop path so a dropped file always shows up as a real
      /// thread message (not just a chip on the composer that the
      /// admin still has to click Send on). Caller has already
      /// validated body / attachments are non-empty.
      const writeAdminTurn = async (
        body: string,
        attachments: string[],
      ): Promise<void> => {
        if (!repo) return;
        const { entityWriteFile, fsRead } = await import("../lib/api");
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
          body,
        };
        if (attachments.length > 0) payload.attachments = attachments;
        await entityWriteFile(
          repo,
          `databases/conversations/${ticketId}`,
          `${msgId}.json`,
          JSON.stringify(payload, null, 2),
        );
        // Any manual admin turn flips the ticket to `escalated`.
        // `open` semantically means "agent is working on it"; once an
        // admin chimes in, the agent is no longer the sole driver, so
        // the ticket is escalated regardless of the previous status
        // (open, resolved, closed, escalated). Best-effort: missing
        // ticket file is logged but the reply itself stays.
        try {
          const ticketPath = `${repo}/databases/tickets/${ticketId}.json`;
          const raw = await fsRead(ticketPath);
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          parsed.status = "escalated";
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
      };

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
          await writeAdminTurn(
            trimmed || "(attachment)",
            replyAttachments.map((a) => a.path),
          );
          setReplyText("");
          setReplyAttachments([]);
        } catch (err) {
          setReplyError(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setReplySending(false);
        }
      };

      // Manual "Mark as resolved": flip the ticket to `resolved`
      // without writing a turn, then navigate back to the
      // conversations list (filter pill state is preserved by the
      // parent Viewer instance).
      const markResolved = async () => {
        if (!repo) return;
        // Reuse `replySending` as the in-flight guard for both the
        // resolve and send paths. Without this, a user could click
        // Mark-as-resolved and then Send (or ⌘↩) before the resolve
        // write lands, racing two concurrent writes to the same
        // ticket file with the final status determined by whichever
        // finishes last.
        if (replySending) return;
        setReplySending(true);
        setReplyError(null);
        try {
          const { entityWriteFile, fsRead } = await import("../lib/api");
          const ticketPath = `${repo}/databases/tickets/${ticketId}.json`;
          const raw = await fsRead(ticketPath);
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          parsed.status = "resolved";
          parsed.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          await entityWriteFile(
            repo,
            "databases/tickets",
            `${ticketId}.json`,
            JSON.stringify(parsed, null, 2),
          );
          // PIN-5829: kick off /conversation-to-automation so Claude
          // harvests the resolution into a KB article, skill, or
          // script. The ticket is already flipped to resolved on
          // disk, so even if the paste fails the resolve sticks; we
          // surface a one-shot alert in the no-session case so the
          // admin knows the capture didn't fire (matching the
          // skill-anchor pattern around line 321).
          const cmd = `/conversation-to-automation ${ticketId}`;
          const wrapped = `${BRACKETED_PASTE_OPEN}${cmd}${BRACKETED_PASTE_CLOSE}`;
          try {
            const pasted = await writeToActiveSession(wrapped);
            if (!pasted) {
              alert(
                "Ticket marked resolved, but couldn't reach Claude to capture the resolution. " +
                  `Open Claude in the right pane and run \`${cmd}\` to capture as a KB article, skill, or script.`,
              );
            }
          } catch (e) {
            console.warn(`[viewer] /conversation-to-automation paste failed:`, e);
          }
          if (onOpenPath) {
            void onOpenPath(`${repo}/databases/conversations`);
          }
        } catch (err) {
          setReplyError(`Resolve failed: ${err instanceof Error ? err.message : String(err)}`);
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
              if (newAttachments.length === 0) return;
              // Post the dropped files as a standalone admin turn so
              // they show up in the thread immediately. The admin can
              // still type follow-up text and click Send for a separate
              // turn afterwards. If the textarea has unsent text, we
              // bundle it with this drop instead of leaving it stuck
              // in the composer waiting for a manual Send.
              const trimmed = replyText.trim();
              const filenames = newAttachments.map((a) => a.filename);
              const fallbackBody =
                filenames.length === 1
                  ? `attached file: ${filenames[0]}`
                  : `attached files: ${filenames.join(", ")}`;
              setReplySending(true);
              setReplyError(null);
              try {
                await writeAdminTurn(
                  trimmed || fallbackBody,
                  newAttachments.map((a) => a.path),
                );
                setReplyText("");
              } catch (err) {
                setReplyError(
                  `Drop failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              } finally {
                setReplySending(false);
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
              {/* End-action lives on the left; the right side is the
                  continue-action (Send). Asymmetry helps the role:
                  resolve closes the conversation + harvests learnings,
                  Send keeps it going. (PIN-5829.) */}
              <button
                type="button"
                className="viewer-edit-btn thread-reply-resolve"
                onClick={() => void markResolved()}
                disabled={replySending}
                title="Mark this ticket as resolved and capture the resolution as a KB article, skill, or script"
              >
                Mark as resolved
              </button>
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

    // Agent-trace timeline — the verbs the agent emitted while
    // running this turn, in order. The banner click-through opens
    // the most recent turn's trace; admins use this to audit "what
    // did the agent actually do" without paging through the JSON.
    if (source.kind === "agent-trace") {
      const { doc, subject } = source;
      if (!doc) {
        // First-turn race: the banner clicked before
        // `agent_trace::persist_trace` wrote the file. Show a
        // placeholder; the fsTick effect below re-fetches and
        // swaps in the real doc as soon as it lands.
        return (
          <div className="agent-trace-view">
            <div className="agent-trace-header">
              <div className="agent-trace-subject">{subject}</div>
              <div className="agent-trace-meta">
                <span className="agent-trace-time">composing reply…</span>
              </div>
            </div>
            <div className="viewer-summary">
              <p className="summary-desc">
                The agent hasn't finished its first reply on this
                ticket yet. The timeline will appear here as soon as
                the turn completes.
              </p>
            </div>
          </div>
        );
      }
      // Filter to events that have something to show. Tool_result
      // entries carry only the tool_use_id (for UI pairing); we
      // skip them in this list to keep the timeline focused on
      // *actions taken* rather than their internal correlation.
      const items = doc.events.filter(
        (e) => e.kind === "tool_use" || e.kind === "text" || e.kind === "result",
      );
      const formatTs = (iso: string) => {
        // The trace timestamps are ISO-8601 UTC with second precision.
        // Render as local time HH:MM:SS so the relative ordering reads
        // naturally without making the admin parse a Z-suffixed UTC.
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      };
      return (
        <div className="agent-trace-view">
          <div className="agent-trace-header">
            <div className="agent-trace-subject">{subject}</div>
            <div className="agent-trace-meta">
              <span className={`agent-trace-outcome agent-trace-outcome-${doc.outcome}`}>
                {doc.outcome}
              </span>
              <span className="agent-trace-model">{doc.model}</span>
              <span className="agent-trace-time">
                {formatTs(doc.started_at)} → {formatTs(doc.completed_at)}
              </span>
            </div>
          </div>
          {items.length === 0 ? (
            <div className="viewer-summary">
              <p className="summary-desc">
                No actions recorded for this turn yet.
              </p>
            </div>
          ) : (
            <ol className="agent-trace-timeline">
              {items.map((e, idx) => {
                const verb =
                  e.verb ?? (e.tool ? `Running ${e.tool}` : null);
                const isFinalResult = e.kind === "result";
                const isText = e.kind === "text";
                const label = isFinalResult
                  ? "Replied"
                  : isText
                    ? "Thinking"
                    : verb || e.kind;
                // For text/result events, show the model's full wording.
                // Earlier versions truncated to first line + 140 chars
                // for "scannable" timelines, but admins explicitly want
                // to see what the agent said and what tools it called.
                // CSS handles wrapping; the row grows to fit.
                const snippet = e.text ? e.text.trim() : null;
                return (
                  <li
                    key={`${e.ts}-${idx}`}
                    className={`agent-trace-step agent-trace-step-${e.kind}`}
                  >
                    <span className="agent-trace-step-time">{formatTs(e.ts)}</span>
                    <span className="agent-trace-step-label">{label}</span>
                    {snippet && (
                      <span className="agent-trace-step-snippet">{snippet}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      );
    }

    // Agent-trace-list — every per-turn trace for one ticket,
    // stacked oldest-first with a separator between turns. Click
    // path: file explorer → `.openit/agent-traces/<ticketId>/`
    // (the folder, not the individual trace files). Reuses the
    // same step formatting as the single-trace view.
    if (source.kind === "agent-trace-list") {
      const formatTs = (iso: string) => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleTimeString([], {
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
      };
      return (
        <div className="agent-trace-view">
          <div className="agent-trace-header">
            <div className="agent-trace-subject">{source.subject}</div>
            <div className="agent-trace-meta">
              <span className="agent-trace-time">
                {source.docs.length} turn{source.docs.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          {source.docs.length === 0 ? (
            <div className="viewer-summary">
              <p className="summary-desc">No traces recorded for this ticket yet.</p>
            </div>
          ) : (
            source.docs.map((entry, idx) => {
              const { doc, name } = entry;
              if (!doc) {
                return (
                  <section key={name} className="agent-trace-list-turn">
                    <header className="agent-trace-list-divider">
                      Turn {idx + 1} · {name} · (unparseable)
                    </header>
                  </section>
                );
              }
              const items = doc.events.filter(
                (e) => e.kind === "tool_use" || e.kind === "text" || e.kind === "result",
              );
              return (
                <section key={name} className="agent-trace-list-turn">
                  <header className="agent-trace-list-divider">
                    <span className="agent-trace-list-turn-num">Turn {idx + 1}</span>
                    <span className={`agent-trace-outcome agent-trace-outcome-${doc.outcome}`}>
                      {doc.outcome}
                    </span>
                    <span className="agent-trace-model">{doc.model}</span>
                    <span className="agent-trace-time">
                      {formatTs(doc.started_at)} → {formatTs(doc.completed_at)}
                    </span>
                  </header>
                  {items.length === 0 ? (
                    <p className="summary-desc">No actions recorded for this turn.</p>
                  ) : (
                    <ol className="agent-trace-timeline">
                      {items.map((e, i) => {
                        const verb = e.verb ?? (e.tool ? `Running ${e.tool}` : null);
                        const isFinal = e.kind === "result";
                        const isText = e.kind === "text";
                        const label = isFinal ? "Replied" : isText ? "Thinking" : verb || e.kind;
                        const snippet = (() => {
                          if (!e.text) return null;
                          const first = e.text.split("\n")[0]?.trim() ?? "";
                          return first.length > 140 ? `${first.slice(0, 137)}…` : first;
                        })();
                        return (
                          <li
                            key={`${e.ts}-${i}`}
                            className={`agent-trace-step agent-trace-step-${e.kind}`}
                          >
                            <span className="agent-trace-step-time">{formatTs(e.ts)}</span>
                            <span className="agent-trace-step-label">{label}</span>
                            {snippet && (
                              <span className="agent-trace-step-snippet">{snippet}</span>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>
              );
            })
          )}
        </div>
      );
    }

    // Deploy / diff
    return <pre className="viewer-content">{content}</pre>;
  };

  // Map the active source.kind onto the entity meta key so the header
  // can render the matching tinted icon next to the title — closes the
  // loop with the Workbench station / EntityCardGrid card icons.
  let headerKind: EntityKind | null = null;
  if (source) {
    switch (source.kind) {
      case "entity-folder":
        // Map the per-ticket attachments folder to the generic
        // "attachments" icon kind — it doesn't have its own ENTITY_META
        // entry. All other entity-folder values match an EntityKind
        // 1:1.
        headerKind =
          source.entity === "attachments-ticket"
            ? "attachments"
            : (source.entity as EntityKind);
        break;
      case "knowledge-bases-list":
        headerKind = "knowledge-bases";
        break;
      case "filestores-list":
        headerKind = "filestores";
        break;
      case "attachments-folder":
        headerKind = "attachments";
        break;
      case "databases-list":
        headerKind = "databases";
        break;
      case "conversations-list":
        headerKind = "inbox";
        break;
      case "people-list":
        headerKind = "people";
        break;
      case "tools":
        headerKind = "tools";
        break;
    }
  }

  return (
    <div className="viewer">
      <div className="viewer-header">
        {/* Permanent back/forward pair — every viewer page gets the
            same navigation affordance instead of relying on per-kind
            back buttons that only existed for a few views. Disabled
            when the corresponding history stack is empty. */}
        <div className="viewer-nav" role="group" aria-label="Viewer navigation">
          <button
            type="button"
            className="viewer-back-btn"
            onClick={() => onGoBack?.()}
            disabled={!canGoBack}
            title="Back"
            aria-label="Back"
          >
            ←
          </button>
          <button
            type="button"
            className="viewer-back-btn"
            onClick={() => onGoForward?.()}
            disabled={!canGoForward}
            title="Forward"
            aria-label="Forward"
          >
            →
          </button>
        </div>
        {headerKind && <EntityBadge kind={headerKind} showLabel={false} />}
        <span className="viewer-title">{title}</span>
        {source && source.kind === "conversation-thread" && onOpenPath && (
          <div className="viewer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={true}
              className="viewer-tab active"
            >
              Conversation
            </button>
            <button
              role="tab"
              aria-selected={false}
              className="viewer-tab"
              onClick={() => {
                void onOpenPath(`${repo}/databases/tickets/${source.ticketId}.json`);
              }}
              title="Open the ticket record (status, tags, notes, asker info)"
            >
              Ticket
            </button>
          </div>
        )}
        {source && source.kind === "entity-folder" && source.entity === "reports" && (
          <>
            <button
              type="button"
              className="viewer-add-link"
              onClick={async () => {
                if (!repo || reportRunning) return;
                setReportRunning(true);
                setReportError(null);
                try {
                  const relPath = await reportOverviewRun(repo);
                  if (onOpenPath) void onOpenPath(`${repo}/${relPath}`);
                } catch (e) {
                  setReportError(e instanceof Error ? e.message : String(e));
                } finally {
                  setReportRunning(false);
                }
              }}
              disabled={reportRunning || !repo}
              title="Generate an instant helpdesk overview report"
            >
              {reportRunning ? "generating…" : "generate overview"}
            </button>
            <button
              type="button"
              className="viewer-add-link"
              onClick={() => {
                // Paste `/report ` into the Claude pane so the admin
                // can type their custom prompt immediately. Distinct
                // from "add to chat" — that just references the
                // reports folder; this kicks off the full skill.
                const wrapped = `${BRACKETED_PASTE_OPEN}/report ${BRACKETED_PASTE_CLOSE}`;
                writeToActiveSession(wrapped).catch((err) =>
                  console.warn("[viewer] ask-custom-report paste failed:", err),
                );
              }}
              title="Kick off /report in chat for a custom report"
            >
              ask for custom report
              <span className="viewer-add-link-arrow" aria-hidden="true">→</span>
            </button>
          </>
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
            {source.kind === "datastore-row" &&
              source.collection.name === "tickets" &&
              onOpenPath && (
                <button
                  role="tab"
                  aria-selected={false}
                  className="viewer-tab"
                  onClick={() => {
                    void onOpenPath(
                      `${repo}/databases/conversations/${source.item.key || source.item.id}`,
                    );
                  }}
                  title="Open the conversation thread for this ticket"
                >
                  Conversation
                </button>
              )}
            <button
              role="tab"
              aria-selected={mode === "table"}
              className={`viewer-tab ${mode === "table" ? "active" : ""}`}
              onClick={() => setMode("table")}
            >
              {source.kind === "datastore-row" &&
              source.collection.name === "tickets"
                ? "Ticket"
                : "View"}
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
        {showPeopleTabs && (
          <div className="viewer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={peopleView === "cards"}
              className={`viewer-tab ${peopleView === "cards" ? "active" : ""}`}
              onClick={() => setPeopleView("cards")}
            >
              Cards
            </button>
            <button
              role="tab"
              aria-selected={peopleView === "table"}
              className={`viewer-tab ${peopleView === "table" ? "active" : ""}`}
              onClick={() => setPeopleView("table")}
            >
              Table
            </button>
          </div>
        )}
        {showConversationsFilter && (
          <div className="viewer-tabs" role="tablist">
            {(["all", "open", "resolved", "escalated"] as const).map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={conversationsFilter === key}
                className={`viewer-tab ${conversationsFilter === key ? "active" : ""}`}
                onClick={() => setConversationsFilter(key)}
              >
                {key === "all" ? "All" : key[0].toUpperCase() + key.slice(1)}
                <span className="viewer-tab-count">{conversationCounts[key]}</span>
              </button>
            ))}
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
      {(chatAddPath || attachmentsTicketId) && (
        <div className="viewer-subheader">
          {attachmentsTicketId && onOpenPath && (
            <button
              type="button"
              className="viewer-add-link"
              onClick={() => {
                void onOpenPath(`${repo}/databases/conversations/${attachmentsTicketId}`);
              }}
              title="Open the related conversation thread"
            >
              conversation
              <span className="viewer-add-link-arrow" aria-hidden="true">→</span>
            </button>
          )}
          {chatAddPath && (
            <button
              type="button"
              className="viewer-add-link"
              onClick={() => {
                writeToActiveSession(chatAddPath + " ").catch((e) =>
                  console.warn("[viewer] add-to-chat failed:", e),
                );
              }}
              title="Reference this in Claude"
            >
              add to chat
              <span className="viewer-add-link-arrow" aria-hidden="true">→</span>
            </button>
          )}
        </div>
      )}
      {renderBody()}
    </div>
  );
}
