import type { DataCollection, MemoryItem } from "../lib/skillsApi";
import type { Agent } from "../lib/agentSync";
import type { Workflow } from "../lib/workflowSync";

/// One conversation turn — sender, role, body, timestamp. The thread
/// view orders these by timestamp and renders them as chat bubbles.
export type ConversationTurn = {
  id: string;
  ticketId: string;
  role: "asker" | "agent" | "admin" | "system" | string;
  sender: string;
  timestamp: string;
  body: string;
};

/// Summary of a single conversation thread, shown as a clickable card
/// in the conversations-list view (one row per thread). Clicking opens
/// the chat-thread view for that ticketId.
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
  | null;
