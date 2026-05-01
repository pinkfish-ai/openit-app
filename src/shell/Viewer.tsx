import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { fsRead, fsReadBytes, fsList, fsReveal, reportOverviewRun, entityWriteFile, entityWriteFileBytes, entityDeleteFile, entityListLocal } from "../lib/api";
import { loadCreds } from "../lib/pinkfishAuth";
import { fetchDatastoreItems } from "../lib/datastoreSync";
import { loadOpenitConfig } from "../lib/openitConfig";
import type { MemoryItem } from "../lib/skillsApi";
import type { Agent } from "../lib/agentSync";
import { DataTable } from "./DataTable";
import { EntityCardGrid } from "./EntityCardGrid";
import { FileThumbnail, isImageFile } from "./FileThumbnail";
import { EntityBadge, type EntityKind } from "./entityIcons";
import { ToolsPanel } from "./ToolsPanel";
import { TrashIcon } from "./TrashIcon";
import { useToast } from "../Toast";
import { Button, TabStrip, Tab } from "../ui";
import { FileTypeBadge, formatBytes } from "./FileTypeBadge";
import { RowEditForm } from "./RowEditForm";
import { AttachmentList } from "./AttachmentList";
import { ImageViewer } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { SpreadsheetViewer } from "./viewers/SpreadsheetViewer";
import { OfficeViewer } from "./viewers/OfficeViewer";
import { DiffViewer } from "./DiffViewer";
import { writeToActiveSession } from "./activeSession";
import { PaneBody } from "../ui";

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
    const ok = await ask(
      `${list} already exist${collisions.length === 1 ? "s" : ""} in this folder.\n\nReplace?`,
      { title: "Replace files?", kind: "warning" },
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
  const ok = await ask(
    `Delete "${filename}"?\n\nThis cannot be undone.`,
    { title: "Delete file?", kind: "warning" },
  );
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

/// Hello-world starter content for the "New" button on the scripts /
/// skills folder views. The .mjs template exports a default async
/// function (the shape every plugin-script entry point uses); the .md
/// template seeds a frontmatter-less skill stub the user can fill in.
const NEW_FILE_TEMPLATES: Record<"mjs" | "md", string> = {
  // Default-export AND top-level invocation so the same file works
  // both ways — `import helloWorld from './untitled.mjs'` for reuse
  // elsewhere, AND `node untitled.mjs` (the in-app Run button) prints
  // "Hello, world!" without the user having to add a call site.
  mjs:
    `export default async function helloWorld() {\n` +
    `  console.log("Hello, world!");\n` +
    `}\n` +
    `\n` +
    `await helloWorld();\n`,
  md: `When you invoke this skill, say "Hello World"\n`,
};

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

/// Plain JSON files reaching this viewer (i.e. routed as
/// `source.kind === "file"`, not as a `datastore-row` / `agent` /
/// `workflow` / etc.). Datastore rows, agents, workflows, and
/// `_schema.json` files all have dedicated structured editors and route
/// by `source.kind` upstream — they don't hit the file branch.
/// What's left here is config (`.openit/config.json`), agent-traces, and
/// any standalone `.json` an admin drops in. All editable as raw text.
function isJsonFile(path: string): boolean {
  return /\.json$/i.test(path);
}

/// JavaScript module scripts. `.claude/scripts/*.mjs` is the plugin
/// surface; `filestores/scripts/*.mjs` is the admin's own scripts
/// folder. Both should be editable for ad-hoc tweaks. (Plugin scripts
/// get overwritten by the next plugin sync — that's expected and
/// orthogonal to whether they're editable in the moment.)
function isMjsScript(path: string): boolean {
  return /\.mjs$/i.test(path);
}

/// Files the in-app "Run" button can execute (`node` for JS family,
/// `python3` for `.py`). Used to gate the run affordance and the
/// always-edit mode — runnable scripts skip the View/Edit toggle
/// since "view" doesn't add value when the file is plain text the
/// user came here to edit + run.
function isRunnableScript(path: string): boolean {
  return /\.(mjs|js|cjs|py)$/i.test(path);
}

/// Files that should expose View / Edit tabs and a textarea-backed
/// edit mode. Markdown, JSON, and `.mjs` scripts.
function hasEditableTextMode(path: string): boolean {
  return isMarkdown(path) || isJsonFile(path) || isMjsScript(path);
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
  tunnelUrl,
  welcomeFlashKey,
  onOpenPath,
  onShowSource,
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
}: {
  source: ViewerSource;
  repo: string;
  fsTick?: number;
  /** Local intake server URL — fallback for `{{INTAKE_URL}}` substitution
   *  when the public tunnel isn't up yet. */
  intakeUrl?: string | null;
  /** Public tunnel URL (e.g. `https://xxx.lhr.life`). Preferred over
   *  `intakeUrl` for `{{INTAKE_URL}}` substitution so CTA links in the
   *  welcome doc point at the shareable URL instead of localhost. */
  tunnelUrl?: string | null;
  /** Bumped by the parent when the user clicks "Getting Started" while the
   *  welcome doc is already the active source. Triggers a one-shot flash
   *  animation so the click doesn't look like a no-op. */
  welcomeFlashKey?: number;
  /** Open another path in the viewer (used by the conversations-list
   *  cards to drill into a specific thread). Optional — falls back to
   *  no-op if the parent didn't wire it. */
  onOpenPath?: (path: string) => void | Promise<void>;
  /** Programmatically route the viewer to a non-path source (e.g.
   *  the captured stdout/stderr of a script run). The parent owns
   *  the source state, so a card-level handler can't call setSource
   *  directly — this prop is the escape hatch. */
  onShowSource?: (source: ViewerSource) => void;
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
  // Inline rename state for the file-title in the viewer-header.
  // `renamingPath` is the source path the user is currently editing
  // (null when not renaming). `renameDraft` is the textbox value.
  // Both reset whenever the source changes — opening a different file
  // mid-rename discards the draft.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const [renameError, setRenameError] = useState<string | null>(null);
  useEffect(() => {
    setRenamingPath(null);
    setRenameDraft("");
    setRenameError(null);
  }, [source]);

  // Parallel state for row-edit mode — keyed by field id, mirrors the
  // row content. Stored as `unknown` per field so `string[]`,
  // booleans, etc. round-trip without coercion until save.
  const [rowEditDraft, setRowEditDraft] = useState<Record<string, unknown>>({});

  // Agent-edit draft + post-save override. Mirrors the rowEditDraft /
  // rowOverride pattern but for the agent panel: draft holds the
  // in-flight form values, override flips the rendered/raw view to the
  // saved content without waiting for the FS watcher to re-read disk.
  const [agentEditDraft, setAgentEditDraft] = useState<{
    description: string;
    instructions: string;
  }>({ description: "", instructions: "" });
  const [agentOverride, setAgentOverride] = useState<Agent | null>(null);

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
  // Auto-scroll the sync log to the bottom whenever new lines arrive
  // — without this, watching a multi-class push from the top of the
  // pane means the latest lines fall below the fold and the user has
  // to scroll manually for every click. Only fires when the sync
  // source is active; other raw renders (diff, schema) keep default
  // scroll behaviour. The <pre> itself doesn't scroll — PaneBody is
  // the scroll container per `.viewer-content` styling — so we walk
  // up to the closest overflow-scroll ancestor and pin it to the
  // bottom.
  //
  // Depend on `content`, not `source`. The content-loading effect
  // below also depends on `[source]`, runs in declaration order
  // AFTER this one, and is what calls `setContent(...)` for sync
  // sources. If we depend on `[source]` here, our scroll runs while
  // the DOM still shows the previous content — `scrollHeight`
  // reads the old height and the bottom-pin lags by a render. Keying
  // on `content` re-runs after the setContent re-render so the DOM
  // is up to date by the time we measure. (BugBot iter 4.)
  const syncPreRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (source?.kind !== "sync") return;
    const el = syncPreRef.current;
    if (!el) return;
    let p: HTMLElement | null = el.parentElement;
    while (p) {
      const overflowY = window.getComputedStyle(p).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        p.scrollTop = p.scrollHeight;
        return;
      }
      p = p.parentElement;
    }
  }, [source, content]);
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
  useEffect(() => setAgentOverride(null), [source]);

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
      // Runnable scripts default into edit mode and stay there —
      // there's no "View" worth toggling for plain code, and the
      // admin came here to edit + run. The textarea draft is
      // seeded from disk in the .then below so Cancel still has
      // something to revert to.
      const runnable = isRunnableScript(path);
      setMode(runnable ? "edit" : isMarkdown(path) ? "rendered" : "raw");
      fsRead(path)
        .then((c) => {
          if (cancelled) return;
          setContent(c);
          if (runnable) setEditDraft(c);
        })
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
    if (source.kind === "script-output") {
      setMode("rendered");
      setContent("");
      return;
    }
    // Draft files: no disk read. Pre-seed the textarea with the
    // template content so the user can audit/edit before Save.
    // `content` stays empty so `isDirty = editDraft !== content` is
    // true on first paint — Save lights up immediately, no need for
    // the user to wiggle the cursor before they can commit.
    if (source.kind === "draft-file") {
      setMode("edit");
      setContent("");
      setEditDraft(source.initialContent);
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
      case "file": return source.path.split("/").pop() ?? source.path;
      case "sync": return "Sync output";
      case "diff": return "Git diff";
      case "script-output":
        return `Run: ${source.script.split("/").pop() ?? source.script}`;
      case "draft-file": return source.filename;
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
      case "filestores-list":    return "Filestores";
      case "attachments-folder": return "Attachments";
      case "knowledge-bases-list": return "Knowledge Bases";
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
  // Runnable scripts skip the View/Edit toggle (they always render
  // edit mode) — the tab strip would be a single live tab, which is
  // worse than no tabs.
  const showFileTabs =
    (source.kind === "file" &&
      hasEditableTextMode(source.path) &&
      !isRunnableScript(source.path)) ||
    source.kind === "datastore-schema";
  const showRowTabs = source.kind === "datastore-row";
  const showAgentTabs = source.kind === "agent";
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

  // "run" affordance in the viewer-subheader for runnable script
  // files (.mjs / .js / .cjs / .py living anywhere — gates on
  // extension, not just the scripts folder, so an admin viewing a
  // script in a sub-folder still gets the same affordance). Same
  // backend as the run-icon on the folder card; routes the viewer
  // to a `script-output` source so the captured streams show up
  // inline.
  const runFileAffordance: { onRun: () => Promise<void> } | null =
    source && source.kind === "file" && repo &&
    /\.(mjs|js|cjs|py)$/i.test(source.path) &&
    onShowSource
      ? (() => {
          const filePath = source.path;
          return {
            onRun: async () => {
              try {
                const { scriptRun } = await import("../lib/api");
                const out = await scriptRun(repo, filePath);
                onShowSource({
                  kind: "script-output",
                  script: filePath,
                  stdout: out.stdout,
                  stderr: out.stderr,
                  exitCode: out.exitCode,
                  durationMs: out.durationMs,
                });
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                console.error(`[script-run] header run failed:`, err);
                showToast(`Run failed: ${reason}`);
              }
            },
          };
        })()
      : null;

  // "new +" affordance in the viewer-subheader for the scripts /
  // skills folder views. Mirrors the placement of the "add to chat"
  // link so the create action lives at the top-right of the pane,
  // not inside the dropzone where it competed with the drag target.
  // Routes to a `draft-file` source — no file lands on disk until
  // the user clicks Save (so a Cancel on the edit screen leaves
  // nothing behind).
  const newFileAffordance: { onCreate: () => void; title: string } | null =
    source && source.kind === "entity-folder" && repo &&
    (source.entity === "scripts" || source.entity === "skills")
      ? (() => {
          const ext: "mjs" | "md" = source.entity === "scripts" ? "mjs" : "md";
          const subdirAbs = source.path;
          const existing = source.files.map((f) => f.name);
          return {
            title:
              source.entity === "scripts"
                ? "Draft a new untitled.mjs script — Save to commit it"
                : "Draft a new untitled.md skill — Save to commit it",
            onCreate: () => {
              if (!onShowSource) return;
              // Pick the first free `untitled[-N].<ext>` against the
              // current listing. The draft is in-memory only — Save
              // will write the file and route to it; if the user
              // Cancels, no file ever lands on disk.
              const relSubdir = toRepoRelative(repo, subdirAbs);
              const taken = new Set(existing);
              let filename = `untitled.${ext}`;
              let i = 2;
              while (taken.has(filename)) {
                filename = `untitled-${i}.${ext}`;
                i += 1;
              }
              const fullPath = relSubdir
                ? `${repo}/${relSubdir}/${filename}`
                : `${repo}/${filename}`;
              onShowSource({
                kind: "draft-file",
                path: fullPath,
                subdir: relSubdir,
                filename,
                initialContent: NEW_FILE_TEMPLATES[ext],
              });
            },
          };
        })()
      : null;

  // Pre-compute conversation status counts so the header pills can
  // display them without re-walking on each render frame. Memoising
  // would be overkill — the array is small and reads from the same
  /// Validate + commit an inline rename from the viewer-header. Reads
  /// `renamingPath` / `renameDraft`, calls `entity_rename_file` on
  /// disk, then re-routes the viewer to the new path so the next
  /// fsTick refresh doesn't bounce the user back to a stale source.
  /// Bails (no-op) when the draft is empty, contains a path
  /// separator, or matches the original — keeping a click-then-blur
  /// without changes from triggering a needless write.
  async function commitRename(): Promise<void> {
    if (!renamingPath || !source || source.kind !== "file") return;
    const original = renamingPath.split("/").pop() ?? renamingPath;
    const next = renameDraft.trim();
    if (!next || next === original) {
      setRenamingPath(null);
      setRenameDraft("");
      setRenameError(null);
      return;
    }
    if (next.includes("/") || next.includes("\\")) {
      setRenameError("Filename can't contain slashes");
      return;
    }
    const dirAbs = renamingPath.slice(0, renamingPath.length - original.length - 1);
    const relSubdir = toRepoRelative(repo, dirAbs);
    try {
      const { entityRenameFile } = await import("../lib/api");
      await entityRenameFile(repo, relSubdir, original, next);
      const newPath = `${dirAbs}/${next}`;
      setRenamingPath(null);
      setRenameDraft("");
      setRenameError(null);
      if (onOpenPath) await onOpenPath(newPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[rename] failed for ${original} → ${next}:`, err);
      setRenameError(`Rename failed: ${reason}`);
    }
  }

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
  // user's natural next step is "paste this into Claude". The
  // "add to chat" affordance pastes the contents into the active Claude
  // session (bracketed-paste so the terminal treats it as one atomic
  // input) and falls back to clipboard if Claude isn't running in the
  // right pane.
  const showAddToChat = source.kind === "sync" || source.kind === "diff";
  const addableText =
    source.kind === "sync"
      ? source.lines.join("\n")
      : source.kind === "diff"
      ? source.text
      : "";
  const handleAddToChat = async () => {
    if (!addableText) return;
    const wrapped = `${BRACKETED_PASTE_OPEN}${addableText}${BRACKETED_PASTE_CLOSE}`;
    try {
      const ok = await writeToActiveSession(wrapped);
      if (!ok) {
        await navigator.clipboard.writeText(addableText);
      }
    } catch (e) {
      console.error("[viewer] add-to-chat failed:", e);
    }
  };

  // Media file viewers (image, pdf, spreadsheet, office) want the pane
  // body to be full-bleed — they manage their own internal padding /
  // toolbars / canvas sizing. The conversation thread also goes flush
  // so the pane has a single scroll container (the messages list) with
  // the reply composer pinned as a non-scrolling flex sibling at the
  // bottom — without this, PaneBody became a second scroll container
  // and the composer drifted upward past later turns. Markdown EDIT
  // mode and datastore-row EDIT mode go flush for the same reason —
  // the editable area scrolls and the Cancel/Save footer pins to the
  // bottom of the pane (otherwise the buttons floated mid-pane below
  // the content). Everything else uses the canonical pane padding so
  // content's left edge sits in the same place across pages.
  const flushBody =
    source.kind === "conversation-thread" ||
    (source.kind === "datastore-row" && mode === "edit") ||
    (source.kind === "datastore-schema" && mode === "edit") ||
    (source.kind === "file" &&
      (isImage(source.path) ||
        isPdf(source.path) ||
        isSpreadsheet(source.path) ||
        isOfficeDoc(source.path) ||
        (mode === "edit" && hasEditableTextMode(source.path))));

  // Shared edit-mode renderer: textarea + Cancel / Save footer. Used by
  // both the `kind: file` editable-text path (markdown / JSON / .mjs)
  // and the `kind: datastore-schema` editor (which writes back to
  // `databases/<col>/_schema.json`).
  const renderEditTextarea = (args: {
    filePath: string;
    /// Mode to return to on Cancel and after a successful Save. Markdown
    /// has a rendered preview ("rendered"); JSON / .mjs / schema only
    /// have raw text ("raw"); runnable scripts stay in "edit" because
    /// the View/Edit toggle is suppressed for them.
    afterMode: "raw" | "rendered" | "edit";
    /// Run `JSON.parse(draft)` before writing. Surfaces typos on Save
    /// instead of letting them silently fall through to defaults at
    /// load time.
    validateAsJson: boolean;
  }): ReactNode => {
    const { filePath, afterMode, validateAsJson } = args;
    const onSave = async () => {
      if (!repo || !filePath.startsWith(`${repo}/`)) {
        setEditError("Cannot save: file is outside the project folder.");
        return;
      }
      if (validateAsJson) {
        try {
          JSON.parse(editDraft);
        } catch (e) {
          setEditError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
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
        setMode(afterMode);
      } catch (err) {
        setEditError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setEditSaving(false);
      }
    };
    const onCancel = () => {
      setEditDraft(content);
      setEditError(null);
      setMode(afterMode);
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
          <Button
            variant="secondary"
            size="sm"
            onClick={onCancel}
            disabled={editSaving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={editSaving || !isDirty}
            loading={editSaving}
          >
            {editSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
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
      if (mode === "edit" && hasEditableTextMode(source.path)) {
        return renderEditTextarea({
          filePath: source.path,
          afterMode: isRunnableScript(source.path)
            ? "edit"
            : isMarkdown(source.path)
              ? "rendered"
              : "raw",
          validateAsJson: isJsonFile(source.path),
        });
      }
      if (mode === "rendered" && isMarkdown(source.path)) {
        // Substitute live template tokens before rendering. {{INTAKE_URL}}
        // is the only one for now — used by the welcome doc to link to
        // the dynamic intake URL that changes per app launch. If the
        // server isn't running yet (intakeUrl is null), strip the link
        // gracefully so we don't render a broken `[text](null)`.
        // Prefer the public tunnel URL so the CTA is shareable; fall back
        // to the local intake URL while the tunnel is still coming up.
        const ctaUrl = tunnelUrl ?? intakeUrl;
        const rendered = ctaUrl
          ? content.split("{{INTAKE_URL}}").join(ctaUrl)
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

    // In-memory draft from the "New" button — no file on disk yet.
    // Same edit chrome as the existing file editor, but Save commits
    // a fresh write and routes the viewer to the now-real file.
    // Cancel uses the parent's back-stack (the entity-folder is the
    // last-known nav target). Save is naturally enabled because the
    // baseline `content` is empty so any draft text reads as dirty.
    if (source.kind === "draft-file") {
      const draftSource = source;
      const onSaveDraft = async () => {
        if (!repo) return;
        setEditSaving(true);
        setEditError(null);
        try {
          const { entityWriteFile } = await import("../lib/api");
          await entityWriteFile(
            repo,
            draftSource.subdir,
            draftSource.filename,
            editDraft,
          );
          showToast(`Created ${draftSource.filename}`);
          // Refresh the parent folder in place so the new file shows
          // up in its card list, THEN navigate to the file. Same-
          // sourceKey check in setSource means the folder refresh is
          // an in-place update (no extra back-stack entry); the file
          // nav pushes the now-fresh folder onto back so the back
          // arrow lands on a current listing.
          if (onOpenPath) {
            const folderAbs = `${repo}/${draftSource.subdir}`;
            await onOpenPath(folderAbs);
            await onOpenPath(draftSource.path);
          }
        } catch (err) {
          setEditError(
            `Save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          setEditSaving(false);
        }
      };
      const onCancelDraft = () => {
        // Discard the draft and go back. The user came from an
        // entity-folder (the New button only appears there), so
        // back-history is reliably non-empty here. The fallback
        // is a no-op in that edge case rather than risk a stuck
        // canvas — the user can navigate via the file tree.
        if (onGoBack && canGoBack) onGoBack();
      };
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
            <Button
              variant="secondary"
              size="sm"
              onClick={onCancelDraft}
              disabled={editSaving}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onSaveDraft}
              disabled={editSaving || editDraft.length === 0}
              loading={editSaving}
            >
              {editSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      );
    }

    // Captured stdout / stderr from a Run-button invocation. Two
    // monospaced blocks (stdout green-tinted, stderr red-tinted)
    // bracketed by a one-line summary so the admin can see exit
    // status + duration at a glance. Empty streams are suppressed
    // so a successful silent run doesn't leave dangling labels.
    if (source.kind === "script-output") {
      const ok = source.exitCode === 0;
      const filename = source.script.split("/").pop() ?? source.script;
      return (
        <div className="viewer-summary script-output">
          <div className="script-output-summary">
            <span
              className={`script-output-status ${ok ? "ok" : "fail"}`}
              aria-label={ok ? "Exited 0" : `Exited ${source.exitCode}`}
            >
              {ok ? "✓" : "✗"} exit {source.exitCode}
            </span>
            <span className="script-output-duration">
              {source.durationMs}ms
            </span>
            <code className="script-output-script">{filename}</code>
          </div>
          {source.stdout && (
            <>
              <h3 className="script-output-label">stdout</h3>
              <pre className="viewer-content script-output-stream">
                {source.stdout}
              </pre>
            </>
          )}
          {source.stderr && (
            <>
              <h3 className="script-output-label script-output-label-err">
                stderr
              </h3>
              <pre className="viewer-content script-output-stream script-output-stream-err">
                {source.stderr}
              </pre>
            </>
          )}
          {!source.stdout && !source.stderr && (
            <p className="summary-desc">
              The script ran to completion without printing anything.
            </p>
          )}
        </div>
      );
    }

    // Datastore schema (the `_schema.json` for a collection). Rendered
    // as raw JSON for read; the textarea editor lets admins tweak field
    // labels / types / comments inline. Save writes back to
    // `databases/<col>/_schema.json` and JSON-validates first so a typo
    // can't drop the whole schema. After save, the on-disk file watcher
    // (fsTick) pulls the new schema into the row + table viewers.
    if (source.kind === "datastore-schema") {
      if (mode === "edit") {
        return renderEditTextarea({
          filePath: `${repo}/databases/${source.collection.name}/_schema.json`,
          afterMode: "raw",
          validateAsJson: true,
        });
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

    // Agent summary — three modes (rendered / edit / raw) mirror the
    // datastore-row pattern so agents read & edit the same way as rows.
    if (source.kind === "agent") {
      const a: Agent = agentOverride ?? source.agent;

      if (mode === "raw") {
        // Same shape `canonicalizeForDisk` produces — keeps Raw view
        // identical to what's on disk.
        const json = JSON.stringify(
          {
            id: a.id ?? "",
            name: a.name ?? "",
            description: a.description ?? "",
            instructions: a.instructions ?? "",
          },
          null,
          2,
        );
        return <pre className="viewer-content">{json}</pre>;
      }

      if (mode === "edit") {
        const onSave = async () => {
          if (!repo) {
            setEditError("Cannot save: no repo open.");
            return;
          }
          setEditSaving(true);
          setEditError(null);
          try {
            // Filename is the local (unprefixed) `name` — agents/<name>.json.
            // Editing the in-file `name` is out of V1 scope; only
            // description + instructions round-trip from this form, so
            // the filename never changes.
            const filename = `${a.name}.json`;
            const json = JSON.stringify(
              {
                id: a.id ?? "",
                name: a.name ?? "",
                description: agentEditDraft.description,
                instructions: agentEditDraft.instructions,
              },
              null,
              2,
            );
            await entityWriteFile(repo, "agents", filename, json);
            setAgentOverride({
              ...a,
              description: agentEditDraft.description,
              instructions: agentEditDraft.instructions,
            });
            setMode("rendered");
          } catch (err) {
            setEditError(
              `Save failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            setEditSaving(false);
          }
        };
        const onCancel = () => {
          setEditError(null);
          setMode("rendered");
        };
        return (
          <div className="row-edit">
            <div className="row-edit-form">
              <label className="row-edit-field">
                <span className="row-edit-label">Description</span>
                <input
                  type="text"
                  className="row-edit-input"
                  value={agentEditDraft.description}
                  onChange={(e) =>
                    setAgentEditDraft({
                      ...agentEditDraft,
                      description: e.target.value,
                    })
                  }
                />
              </label>
              <label className="row-edit-field">
                <span className="row-edit-label">Instructions</span>
                <textarea
                  className="row-edit-textarea"
                  rows={20}
                  value={agentEditDraft.instructions}
                  onChange={(e) =>
                    setAgentEditDraft({
                      ...agentEditDraft,
                      instructions: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="row-edit-footer">
              {editError && <span className="row-edit-error">{editError}</span>}
              <Button
                variant="secondary"
                size="sm"
                onClick={onCancel}
                disabled={editSaving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={onSave}
                disabled={editSaving}
                loading={editSaving}
              >
                {editSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        );
      }

      // Default: rendered (read-only beautiful view).
      return (
        <div className="viewer-summary">
          <h2>{a.name}</h2>
          {a.description && <p className="summary-desc">{a.description}</p>}
          <div className="summary-section">
            <h3>Details</h3>
            <table className="summary-table">
              <tbody>
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
        const sampleUrl = tunnelUrl || intakeUrl || null;
        return (
          <div className="viewer-summary">
            <p className="summary-desc">
              No conversation threads yet. They appear here once a ticket gets
              its first message — file a ticket via the Intake form to start one.
            </p>
            {sampleUrl && (
              <Button
                variant="primary"
                onClick={() => {
                  openUrl(sampleUrl).catch((err) =>
                    console.warn("[viewer] openUrl failed:", err),
                  );
                }}
              >
                Submit sample ticket
              </Button>
            )}
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
                  <Button
                    variant="ghost"
                    tone="destructive"
                    size="sm"
                    iconOnly
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
                  </Button>
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
          // "Run" only for the scripts folder. Spawns `node <script>`
          // server-side and routes the viewer to a script-output
          // source so the captured stdout / stderr lands in the main
          // content window instead of an external terminal.
          onRun:
            source.entity === "scripts" &&
            /\.(mjs|js|cjs|py)$/i.test(f.path) &&
            onShowSource
              ? async () => {
                  try {
                    const { scriptRun } = await import("../lib/api");
                    const out = await scriptRun(repo, f.path);
                    onShowSource({
                      kind: "script-output",
                      script: f.path,
                      stdout: out.stdout,
                      stderr: out.stderr,
                      exitCode: out.exitCode,
                      durationMs: out.durationMs,
                    });
                  } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    console.error(`[script-run] ${f.name} failed:`, err);
                    showToast(`Run failed: ${reason}`);
                  }
                }
              : undefined,
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
            acceptsDrop ? " viewer-summary-droppable" : ""
          }${acceptsDrop && folderDragOver ? " viewer-summary-drag" : ""}${
            showDropZone ? " viewer-summary-dropzone" : ""
          }`}
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
              <Button
                variant="ghost"
                size="sm"
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
              </Button>
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
        // Any manual admin turn flips the ticket to `escalated` —
        // `open` means "agent is working on it" and once an admin
        // chimes in, the agent is no longer the sole driver. Gated on
        // `ticketLifecycle.escalateOnAdminReply`: admins can disable
        // to leave commentary on resolved threads without re-opening
        // them.
        //
        // `updatedAt` is bumped regardless of the gate. The auto-close
        // walker uses it as the resolve-time anchor — without this,
        // an admin commenting on a resolved ticket while
        // `escalateOnAdminReply: false` could see the ticket
        // auto-close moments later because the close timer still
        // tracked from the original resolve. Admin activity is real
        // engagement; the lifecycle clock should reset.
        //
        // `assignee` stamps regardless too — admin authorship of the
        // turn is a fact independent of the lifecycle decision.
        try {
          const cfg = await loadOpenitConfig(repo);
          const ticketPath = `${repo}/databases/tickets/${ticketId}.json`;
          const raw = await fsRead(ticketPath);
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          parsed.updatedAt = isoNow;
          if (cfg.ticketLifecycle.escalateOnAdminReply) {
            parsed.status = "escalated";
          }
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
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      className="thread-reply-chip-remove"
                      onClick={() =>
                        setReplyAttachments((prev) =>
                          prev.filter((a) => a.path !== att.path),
                        )
                      }
                      title="Remove"
                    >
                      ×
                    </Button>
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
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void markResolved()}
                disabled={replySending}
                title="Mark this ticket as resolved and capture the resolution as a KB article, skill, or script"
              >
                Mark as resolved
              </Button>
              {replyError && (
                <span className="thread-reply-error">{replyError}</span>
              )}
              <span className="thread-reply-hint">⌘↩ to send · drop files to attach</span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void sendReply()}
                disabled={
                  replySending ||
                  (!replyText.trim() && replyAttachments.length === 0)
                }
                loading={replySending}
              >
                {replySending ? "Sending…" : "Send"}
              </Button>
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

    // Sync output gets a ref so the auto-scroll useEffect above can
    // pin the view to the latest line.
    if (source?.kind === "sync") {
      return (
        <pre ref={syncPreRef} className="viewer-content">
          {content}
        </pre>
      );
    }

    // Diff: VSCode-style per-file unified-diff renderer. Click on a
    // file header opens the file in the viewer (synced with
    // FileExplorer via the `onOpenPath` round-trip).
    if (source?.kind === "diff") {
      return (
        <div className="viewer-content diff-content">
          <DiffViewer
            text={content}
            onOpenFile={
              repo && onOpenPath
                ? (rel) => {
                    void onOpenPath(`${repo}/${rel}`);
                  }
                : undefined
            }
          />
        </div>
      );
    }

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
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onGoBack?.()}
            disabled={!canGoBack}
            title="Back"
            aria-label="Back"
          >
            ←
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onGoForward?.()}
            disabled={!canGoForward}
            title="Forward"
            aria-label="Forward"
          >
            →
          </Button>
        </div>
        {headerKind && <EntityBadge kind={headerKind} showLabel={false} />}
        {source && source.kind === "file" ? (
          renamingPath === source.path ? (
            <input
              type="text"
              className="viewer-title viewer-title-rename"
              value={renameDraft}
              autoFocus
              onChange={(e) => {
                setRenameDraft(e.target.value);
                setRenameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenamingPath(null);
                  setRenameDraft("");
                  setRenameError(null);
                }
              }}
              onBlur={() => void commitRename()}
            />
          ) : (
            <button
              type="button"
              className="viewer-title viewer-title-editable"
              onClick={() => {
                const filename = source.path.split("/").pop() ?? source.path;
                setRenamingPath(source.path);
                setRenameDraft(filename);
                setRenameError(null);
              }}
              title="Click to rename"
            >
              {title}
            </button>
          )
        ) : (
          <span className="viewer-title">{title}</span>
        )}
        {renameError && (
          <span className="viewer-title-rename-error" role="alert">
            {renameError}
          </span>
        )}
        {source && source.kind === "conversation-thread" && onOpenPath && (
          <TabStrip variant="segmented">
            <Tab active>Conversation</Tab>
            <Tab
              onClick={() => {
                void onOpenPath(`${repo}/databases/tickets/${source.ticketId}.json`);
              }}
              title="Open the ticket record (status, tags, notes, asker info)"
            >
              Ticket
            </Tab>
          </TabStrip>
        )}
        {source && source.kind === "entity-folder" && source.entity === "reports" && (
          <>
            <Button
              variant="linkMuted"
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
              loading={reportRunning}
              title="Generate an instant helpdesk overview report"
            >
              {reportRunning ? "generating…" : "generate overview"}
            </Button>
            <Button
              variant="linkMuted"
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
              <span className="arrow" aria-hidden="true">→</span>
            </Button>
          </>
        )}
        {runFileAffordance && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runFileAffordance.onRun()}
            title="Run this script with node / python3 and show the output"
          >
            <span className="viewer-run-glyph" aria-hidden="true">▶</span>
            Run
          </Button>
        )}
        {newFileAffordance && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => newFileAffordance.onCreate()}
            title={newFileAffordance.title}
          >
            New
            <span className="arrow" aria-hidden="true">+</span>
          </Button>
        )}
        {showFileTabs && (
          <TabStrip variant="segmented">
            <Tab
              active={mode !== "edit"}
              onClick={() => {
                // Markdown files have a rendered preview; JSON,
                // .mjs, and datastore schemas only have a raw textual
                // view. Branch on file type so View returns the user
                // to whichever read-only mode applies.
                const renderable =
                  source.kind === "file" && isMarkdown(source.path);
                setMode(renderable ? "rendered" : "raw");
              }}
            >
              View
            </Tab>
            <Tab
              active={mode === "edit"}
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
            </Tab>
          </TabStrip>
        )}
        {showRowTabs && (
          <TabStrip variant="segmented">
            {source.kind === "datastore-row" &&
              source.collection.name === "tickets" &&
              onOpenPath && (
                <Tab
                  onClick={() => {
                    void onOpenPath(
                      `${repo}/databases/conversations/${source.item.key || source.item.id}`,
                    );
                  }}
                  title="Open the conversation thread for this ticket"
                >
                  Conversation
                </Tab>
              )}
            <Tab
              active={mode === "table"}
              onClick={() => setMode("table")}
            >
              {source.kind === "datastore-row" &&
              source.collection.name === "tickets"
                ? "Ticket"
                : "View"}
            </Tab>
            <Tab
              active={mode === "edit"}
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
            </Tab>
            <Tab
              active={mode === "raw"}
              onClick={() => setMode("raw")}
            >
              Raw
            </Tab>
          </TabStrip>
        )}
        {showAgentTabs && (
          <TabStrip variant="segmented">
            <Tab
              active={mode === "rendered"}
              onClick={() => setMode("rendered")}
            >
              View
            </Tab>
            <Tab
              active={mode === "edit"}
              onClick={() => {
                if (mode !== "edit" && source.kind === "agent") {
                  const a = agentOverride ?? source.agent;
                  setAgentEditDraft({
                    description: a.description ?? "",
                    instructions: a.instructions ?? "",
                  });
                }
                setEditError(null);
                setMode("edit");
              }}
            >
              Edit
            </Tab>
            <Tab
              active={mode === "raw"}
              onClick={() => setMode("raw")}
            >
              Raw
            </Tab>
          </TabStrip>
        )}
        {showPeopleTabs && (
          <TabStrip variant="segmented">
            <Tab
              active={peopleView === "cards"}
              onClick={() => setPeopleView("cards")}
            >
              Cards
            </Tab>
            <Tab
              active={peopleView === "table"}
              onClick={() => setPeopleView("table")}
            >
              Table
            </Tab>
          </TabStrip>
        )}
        {showConversationsFilter && (
          <TabStrip>
            {(["all", "open", "resolved", "escalated"] as const).map((key) => (
              <Tab
                key={key}
                active={conversationsFilter === key}
                count={conversationCounts[key]}
                onClick={() => setConversationsFilter(key)}
              >
                {key === "all" ? "All" : key[0].toUpperCase() + key.slice(1)}
              </Tab>
            ))}
          </TabStrip>
        )}
        {showAddToChat && (
          <Button
            variant="linkMuted"
            onClick={handleAddToChat}
            title="Paste these contents into Claude in the right pane"
          >
            add to chat
            <span className="arrow" aria-hidden="true">→</span>
          </Button>
        )}
      </div>
      {(chatAddPath || attachmentsTicketId) && (
        <div className="viewer-subheader">
          {attachmentsTicketId && onOpenPath && (
            <Button
              variant="linkMuted"
              onClick={() => {
                void onOpenPath(`${repo}/databases/conversations/${attachmentsTicketId}`);
              }}
              title="Open the related conversation thread"
            >
              conversation
              <span className="arrow" aria-hidden="true">→</span>
            </Button>
          )}
          {chatAddPath && (
            <Button
              variant="linkMuted"
              onClick={() => {
                writeToActiveSession(chatAddPath + " ").catch((e) =>
                  console.warn("[viewer] add-to-chat failed:", e),
                );
              }}
              title="Reference this in Claude"
            >
              add to chat
              <span className="arrow" aria-hidden="true">→</span>
            </Button>
          )}
        </div>
      )}
      <PaneBody flush={flushBody}>{renderBody()}</PaneBody>
    </div>
  );
}
