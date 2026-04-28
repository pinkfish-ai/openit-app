import type { ReactNode } from "react";
import { ENTITY_META, type EntityKind } from "./entityIcons";

export type { EntityKind };

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
  /** Override the kind-shared glyph for this card — used for image
   *  thumbnails on attachment / library cards. Falls back to the
   *  kind icon when omitted. */
  icon?: ReactNode;
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
          {meta.icon}
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
              {c.icon ?? meta.icon}
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

