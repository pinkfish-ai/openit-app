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
  | null;
