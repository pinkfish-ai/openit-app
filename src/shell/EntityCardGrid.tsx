import type { ReactNode } from "react";

export type EntityKind =
  | "agents"
  | "knowledge-base"
  | "knowledge-bases"
  | "library"
  | "attachments"
  | "people"
  | "tickets"
  | "databases"
  | "filestores"
  | "reports"
  | "workflows";

export type EntityCard = {
  /** Stable React key. */
  key: string;
  title: string;
  /** Short subtitle / description. */
  description?: string;
  /** Right-aligned metadata text (count, date, tag). */
  meta?: ReactNode;
  /** A single optional pill below the description (status, etc.). */
  badge?: { label: string; tone?: "neutral" | "ok" | "warn" | "info" };
  onClick?: () => void;
};

/**
 * Visual primitive for every entity-list surface. Each card has the
 * same chrome (border / shadow / hover lift) and a kind-specific
 * glyph + accent so people / agents / knowledge / attachments etc.
 * read as one family.
 */
export function EntityCardGrid({
  kind,
  cards,
  empty,
}: {
  kind: EntityKind;
  cards: EntityCard[];
  /** Optional copy shown when `cards` is empty. */
  empty?: ReactNode;
}) {
  const meta = ENTITY_META[kind];

  if (cards.length === 0) {
    return (
      <div className={`entity-grid entity-grid-empty entity-tone-${meta.tone}`}>
        <div className="entity-grid-empty-glyph" aria-hidden>
          {meta.glyph}
        </div>
        {empty && <div className="entity-grid-empty-body">{empty}</div>}
      </div>
    );
  }

  return (
    <div className={`entity-grid entity-tone-${meta.tone}`}>
      {cards.map((c) => {
        const Tag = c.onClick ? "button" : "div";
        return (
          <Tag
            key={c.key}
            type={c.onClick ? "button" : undefined}
            className={`entity-card ${c.onClick ? "entity-card-clickable" : ""}`}
            onClick={c.onClick}
          >
            <span className="entity-card-glyph" aria-hidden>
              {meta.glyph}
            </span>
            <div className="entity-card-body">
              <div className="entity-card-row">
                <span className="entity-card-title">{c.title}</span>
                {c.meta !== undefined && (
                  <span className="entity-card-meta">{c.meta}</span>
                )}
              </div>
              {c.description && (
                <span className="entity-card-desc">{c.description}</span>
              )}
              {c.badge && (
                <span
                  className={`entity-card-badge entity-card-badge-${
                    c.badge.tone ?? "neutral"
                  }`}
                >
                  {c.badge.label}
                </span>
              )}
            </div>
          </Tag>
        );
      })}
    </div>
  );
}

type EntityMeta = {
  glyph: string;
  /** Drives the glyph background tint and the accent highlight. */
  tone: "accent" | "sage" | "ochre" | "link" | "clay" | "neutral";
};

const ENTITY_META: Record<EntityKind, EntityMeta> = {
  agents: { glyph: "✦", tone: "accent" },
  "knowledge-base": { glyph: "❋", tone: "ochre" },
  "knowledge-bases": { glyph: "❋", tone: "ochre" },
  library: { glyph: "▤", tone: "neutral" },
  attachments: { glyph: "◫", tone: "neutral" },
  people: { glyph: "◔", tone: "sage" },
  tickets: { glyph: "◉", tone: "accent" },
  databases: { glyph: "▦", tone: "link" },
  filestores: { glyph: "▤", tone: "neutral" },
  reports: { glyph: "❍", tone: "link" },
  workflows: { glyph: "↻", tone: "sage" },
};
