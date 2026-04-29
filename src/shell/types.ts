import type { DataCollection, MemoryItem } from "../lib/skillsApi";
import type { Agent } from "../lib/agentSync";
import type { Workflow } from "../lib/workflowSync";

/// Mirrors `agent_trace::TraceEvent` on the Rust side. Persisted at
/// `.openit/agent-traces/<ticketId>/<startedAt>.json` per turn; the
/// agent-activity banner click-through opens the latest one in the
/// viewer.
export type TraceEvent = {
  ts: string;
  kind: string;
  tool?: string;
  verb?: string;
  raw?: unknown;
  text?: string;
};

export type TraceDoc = {
  ticket_id: string;
  turn_id: string;
  started_at: string;
  completed_at: string;
  model: string;
  outcome: string;
  events: TraceEvent[];
};

/// One conversation turn — sender, role, body, timestamp. The thread
/// view orders these by timestamp and renders them as chat bubbles.
export type ConversationTurn = {
  id: string;
  ticketId: string;
  role: "asker" | "agent" | "admin" | "system" | string;
  sender: string;
  timestamp: string;
  body: string;
  /// Repo-relative paths to attachments associated with this turn —
  /// e.g. `filestores/attachments/<ticketId>/<filename>`. Asker
  /// uploads land here via `/chat/upload`; admin replies sent from
  /// the desktop composer write attachments through `entityWriteFile`
  /// to the same path. Empty / missing when the turn has no
  /// attachments.
  attachments?: string[];
};

/// Summary of a single conversation thread, shown as a clickable card
/// in the conversations-list view (one row per thread). Clicking opens
/// the chat-thread view for that ticketId.
export type PersonSummary = {
  /// File-stem key (e.g. the email-as-id used for the person row).
  key: string;
  name: string;
  email: string;
  role: string;
  department: string;
  channels: string[];
};

export type ConversationThreadSummary = {
  ticketId: string;
  // Subject pulled from the ticket file; falls back to the first
  // message body if the ticket isn't readable yet.
  subject: string;
  // Asker label from the ticket; empty when the ticket file is missing.
  asker: string;
  // Status from the ticket — drives a status pill on the card.
  status: string;
  // ticket.createdAt or fallback to the thread folder's first turn.
  createdAt: string;
  // Newest turn's timestamp — used for sort + "last activity" label.
  lastTurnAt: string;
  // Number of msg-*.json files under the thread folder.
  turnCount: number;
  // Free-form labels from the ticket. Includes `auto-escalated` when
  // the stale-open scan flipped this ticket — the only signal on the
  // card that "escalated" means "timed out" vs "agent gave up".
  tags: string[];
};

export type ViewerSource =
  | { kind: "file"; path: string }
  | { kind: "sync"; lines: string[] }
  | { kind: "diff"; text: string }
  | { kind: "datastore-table"; collection: DataCollection; items?: MemoryItem[]; hasMore?: boolean; onLoadMore?: () => void }
  | { kind: "datastore-row"; collection: DataCollection; item: MemoryItem }
  | { kind: "datastore-schema"; collection: DataCollection }
  | { kind: "agent"; agent: Agent }
  | { kind: "workflow"; workflow: Workflow }
  | { kind: "conversation-thread"; ticketId: string; turns: ConversationTurn[] }
  | { kind: "conversations-list"; threads: ConversationThreadSummary[] }
  // People directory — one row per contact. Default view is cards
  // (name + email + role/department); the header has a Cards / Table
  // toggle so admins can flip into the raw datastore-table when they
  // need to see every column. The `collection` mirrors what the
  // datastore-table source carries so the table view can render
  // without re-resolving.
  | {
      kind: "people-list";
      view: "cards" | "table";
      people: PersonSummary[];
      collection: DataCollection;
      items: MemoryItem[];
    }
  // Per-turn agent trace (the verbs + timestamps the agent emitted
  // running this chat turn). Opened by clicking the agent-activity
  // banner; resolves to the most recent trace file under
  // `.openit/agent-traces/<ticketId>/`. `doc` may be null on the
  // very first click before any turn has finished — the viewer shows
  // a "composing first reply" placeholder, and the fs-watcher tick
  // re-resolves the source once the file lands.
  | {
      kind: "agent-trace";
      ticketId: string;
      subject: string;
      doc: TraceDoc | null;
    }
  // All traces for a single ticket, oldest-first. Surfaced when the
  // admin clicks `.openit/agent-traces/<ticketId>/` in the file
  // explorer — the viewer renders each turn's trace stacked with a
  // separator. Each entry carries the source filename so the header
  // can show "turn 3 (2026-04-28T20:09:43Z)".
  | {
      kind: "agent-trace-list";
      ticketId: string;
      subject: string;
      docs: { name: string; doc: TraceDoc | null }[];
    }
  // Top-level entity folder (agents/, workflows/, knowledge-base/, filestore/).
  // Carries the files inside so the viewer can either show a list or a
  // friendly empty-state notice — the same affordance the conversations-
  // list provides for the databases/conversations folder.
  | {
      kind: "entity-folder";
      // Top-level entity folders that render a card list. `library`
      // is the curated filestore collection (`filestores/library/`);
      // `knowledge-base` covers any KB collection under
      // `knowledge-bases/<name>/` (default + user-created); the
      // operational `filestores/attachments/` collection has its own
      // ticketid-grouped renderer and isn't part of this set.
      // `reports` carries on-demand generated markdown reports —
      // sorted newest-first by filename instead of alphabetically.
      entity:
        | "agents"
        | "workflows"
        | "knowledge-base"
        | "library"
        | "reports"
        | "attachments-ticket";
      // Repo-relative path the resolver matched. For non-KB entities
      // it equals the entity name; for KB it carries the specific
      // collection (e.g. `knowledge-bases/default` or
      // `knowledge-bases/<custom>`) so the fsTick re-resolver knows
      // which folder to walk, and the title-bar can show the
      // collection name.
      path: string;
      // displayName drops the file extension and falls back to the
      // entity's own `name` field when readable (agents/workflows JSON);
      // description is the entity's `description` field, or the first
      // markdown heading for knowledge-base, or empty for library.
      files: { name: string; displayName: string; description: string; path: string }[];
    }
  // Top-level `databases/` directory. Each collection is its own
  // subfolder (databases/<col>/) — the parent view shows them as cards
  // with item counts and routes clicks to the per-collection viewer
  // (datastore-table or conversations-list, whichever the child
  // resolver picks up).
  | { kind: "databases-list"; collections: { name: string; path: string; itemCount: number; hasSchema: boolean }[] }
  // Top-level `filestores/` directory — mirrors `databases-list`.
  // `attachments` and `library` ship as built-ins (special-cased for
  // copy + counting semantics); the resolver also enumerates any
  // user-created collection (`mkdir filestores/foo`) so the UI
  // gracefully surfaces them with a generic description.
  | { kind: "filestores-list"; collections: { name: string; path: string; itemCount: number; itemNoun: string; description: string; isBuiltin: boolean }[] }
  // `filestores/attachments/` view: introductory copy explaining the
  // collection's purpose plus a list of per-ticket subfolders (each
  // is a clickable card that jumps to the matching conversation
  // thread). This is what surfaces when the admin clicks the
  // attachments folder in the explorer.
  | { kind: "attachments-folder"; tickets: { ticketId: string; path: string; fileCount: number }[] }
  // Top-level `knowledge-bases/` directory — same plural-with-default
  // shape as filestores/. `default` ships out of the box (cloud-sync
  // target in V1); admins can `mkdir knowledge-bases/<custom>/` to
  // add their own collections, which surface here too. Each card
  // shows article count + one-line purpose blurb.
  | { kind: "knowledge-bases-list"; collections: { name: string; path: string; itemCount: number; description: string; isBuiltin: boolean }[] }
  // Cloud CTA — shown when an admin clicks any "Connect to Cloud"
  // affordance while still local-only. A static pitch page that
  // explains what cloud unlocks (team sync, hosted agents, MCPs);
  // the page's primary button kicks off the actual onboarding flow.
  | { kind: "cloud-cta" }
  // Getting Started — the auto-opened first-launch page and the
  // target of the App-header "Getting Started" button. Replaces the
  // markdown welcome doc with a React surface that mirrors the
  // cloud-cta layout (eyebrow + headline + lead + a single intake
  // CTA). The intake URL is read from Viewer's `intakeUrl` prop.
  | { kind: "getting-started" }
  | null;
