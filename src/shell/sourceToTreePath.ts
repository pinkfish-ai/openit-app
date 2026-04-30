import type { ViewerSource } from "./types";

/**
 * Return the absolute filesystem path that a ViewerSource maps to in
 * the FileExplorer tree, or null when the source has no tree
 * representation (transient views like an in-memory diff, a single
 * agent-trace turn, or the synthetic tools panel).
 *
 * Used to keep the file explorer's "active row" in sync with whatever
 * the canvas is showing — Workbench tile clicks, Inbox row clicks,
 * entity-list card clicks, and direct file clicks all funnel through
 * `nav.source` in Shell, so this is the single derivation point.
 */
export function sourceToTreePath(
  source: ViewerSource,
  repo: string | null,
): string | null {
  if (!source || !repo) return null;
  switch (source.kind) {
    case "file":
      return source.path;

    case "conversation-thread":
      return `${repo}/databases/conversations/${source.ticketId}`;

    case "conversations-list":
      return `${repo}/databases/conversations`;

    case "people-list":
      return `${repo}/databases/${source.collection.name}`;

    case "datastore-table":
      return `${repo}/databases/${source.collection.name}`;

    case "entity-folder":
      return `${repo}/${source.path}`;

    case "databases-list":
      return `${repo}/databases`;

    case "filestores-list":
      return `${repo}/filestores`;

    case "knowledge-bases-list":
      return `${repo}/knowledge-bases`;

    case "attachments-folder":
      return `${repo}/filestores/attachments`;

    // Kinds without a stable tree node — leave the highlight cleared
    // rather than pin it to a stale row:
    //   - sync / diff: transient overlays
    //   - agent / workflow / datastore-row / datastore-schema: row-level
    //     detail views; the underlying file path isn't carried on the
    //     source. Could be added later if AgentRow/WorkflowRow grow a
    //     `path` field.
    //   - agent-trace / agent-trace-list: live under the hidden
    //     `.openit/agent-traces/` directory which the explorer never
    //     surfaces.
    //   - tools: synthetic panel, no on-disk folder.
    case "sync":
    case "diff":
    case "agent":
    case "workflow":
    case "datastore-row":
    case "datastore-schema":
    case "agent-trace":
    case "agent-trace-list":
    case "tools":
      return null;
  }
}
