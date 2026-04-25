import type { DataCollection, MemoryItem } from "../lib/skillsApi";
import type { Agent } from "../lib/agentSync";
import type { Workflow } from "../lib/workflowSync";

export type ViewerSource =
  | { kind: "file"; path: string }
  | { kind: "deploy"; lines: string[] }
  | { kind: "diff"; text: string }
  | { kind: "datastore-table"; collection: DataCollection; items?: MemoryItem[]; hasMore?: boolean; onLoadMore?: () => void }
  | { kind: "datastore-row"; collection: DataCollection; item: MemoryItem }
  | { kind: "datastore-schema"; collection: DataCollection }
  | { kind: "agent"; agent: Agent }
  | { kind: "workflow"; workflow: Workflow }
  | null;
