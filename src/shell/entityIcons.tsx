import type { ReactNode } from "react";

/**
 * Shared visual identity for every entity kind.
 *
 * One source of truth that the Workbench stations, the EntityCardGrid
 * cards, and the Viewer headers all consume — so when the user clicks
 * "Tickets" in the Workbench, the resulting page header shows the
 * same icon, the same tone, and the same label. No more orange-tile
 * Workbench fighting a multicolor card grid.
 */

export type EntityKind =
  | "inbox"
  | "reports"
  | "people"
  | "knowledge"
  | "knowledge-base"
  | "knowledge-bases"
  | "files"
  | "filestores"
  | "library"
  | "attachments"
  | "agents"
  | "databases"
  | "workflows"
  | "tools";

export type ToneKey = "accent" | "sage" | "ochre" | "link" | "clay" | "neutral";

// ── Inline SVGs ────────────────────────────────────────────────────
// Stroke-style line icons at 1.6px, except People which is filled
// (stroke person reads weak at 14px).

const InboxIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 7l9 6.5L21 7" />
  </svg>
);

const ReportsIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <line x1="6" y1="20" x2="6" y2="14" />
    <line x1="12" y1="20" x2="12" y2="9" />
    <line x1="18" y1="20" x2="18" y2="4" />
  </svg>
);

const PersonIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 21c0-4.0 3.1-7 7-7s7 3.0 7 7v1H5z" />
  </svg>
);

const KnowledgeIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 4a2 2 0 0 1 2-2h12v20H7a2 2 0 0 1-2-2z" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="9" y1="12" x2="15" y2="12" />
  </svg>
);

const FilesIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const AgentsIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l1.8 5.4L19.5 10l-5.7 1.6L12 17l-1.8-5.4L4.5 10l5.7-1.6z" />
  </svg>
);

const AttachmentsIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19a2 2 0 0 1-2.8-2.8L16 8" />
  </svg>
);

const DatabasesIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <ellipse cx="12" cy="6" rx="7" ry="2.5" />
    <path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
    <path d="M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" />
  </svg>
);

const WorkflowsIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 12a8 8 0 0 1 14-5.3" />
    <polyline points="14 4 18 6.7 16 11" />
    <path d="M20 12a8 8 0 0 1-14 5.3" />
    <polyline points="10 20 6 17.3 8 13" />
  </svg>
);

// Wrench — for the Tools entity (CLI tools the agent can call via Bash).
const ToolsIcon: ReactNode = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z" />
    <path d="M14.7 6.3a4 4 0 0 1 5 5" />
  </svg>
);

// ── Per-kind metadata (icon + tone + label) ───────────────────────

type EntityMetaEntry = {
  icon: ReactNode;
  tone: ToneKey;
  label: string;
};

export const ENTITY_META: Record<EntityKind, EntityMetaEntry> = {
  inbox:             { icon: InboxIcon,       tone: "accent",  label: "Inbox" },
  reports:           { icon: ReportsIcon,     tone: "link",    label: "Reports" },
  people:            { icon: PersonIcon,      tone: "sage",    label: "People" },
  knowledge:         { icon: KnowledgeIcon,   tone: "ochre",   label: "Knowledge" },
  "knowledge-base":  { icon: KnowledgeIcon,   tone: "ochre",   label: "Knowledge base" },
  "knowledge-bases": { icon: KnowledgeIcon,   tone: "ochre",   label: "Knowledge" },
  files:             { icon: FilesIcon,       tone: "neutral", label: "Files" },
  filestores:        { icon: FilesIcon,       tone: "neutral", label: "Files" },
  library:           { icon: FilesIcon,       tone: "neutral", label: "Library" },
  attachments:       { icon: AttachmentsIcon, tone: "neutral", label: "Attachments" },
  agents:            { icon: AgentsIcon,      tone: "accent",  label: "Agents" },
  databases:         { icon: DatabasesIcon,   tone: "link",    label: "Databases" },
  workflows:         { icon: WorkflowsIcon,   tone: "sage",    label: "Workflows" },
  tools:             { icon: ToolsIcon,       tone: "accent",  label: "Tools" },
};

// ── Convenience accessors used by call sites ──────────────────────

/// Map of just the icons — kept for backwards compatibility with
/// existing imports. New code should prefer ENTITY_META directly.
export const EntityIcons = {
  inbox: InboxIcon,
  reports: ReportsIcon,
  people: PersonIcon,
  knowledge: KnowledgeIcon,
  knowledgeBase: KnowledgeIcon,
  knowledgeBases: KnowledgeIcon,
  files: FilesIcon,
  library: FilesIcon,
  filestores: FilesIcon,
  agents: AgentsIcon,
  attachments: AttachmentsIcon,
  databases: DatabasesIcon,
  workflows: WorkflowsIcon,
  tools: ToolsIcon,
};

// ── EntityBadge component (used in viewer headers) ────────────────

/// Small tinted badge: tone-colored glyph square + label text.
/// Rendered at the top of an entity-list view so the page header
/// matches the station/card icon that opened it.
export function EntityBadge({
  kind,
  size = "md",
  showLabel = true,
}: {
  kind: EntityKind;
  size?: "sm" | "md";
  showLabel?: boolean;
}) {
  const meta = ENTITY_META[kind];
  return (
    <span
      className={`entity-badge entity-badge-${size} entity-tone-${meta.tone}`}
    >
      <span className="entity-badge-glyph" aria-hidden>
        {meta.icon}
      </span>
      {showLabel && <span className="entity-badge-label">{meta.label}</span>}
    </span>
  );
}
