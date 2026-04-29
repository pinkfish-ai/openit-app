import { useState, type ReactNode } from "react";
import { ENTITY_META, type EntityKind } from "./entityIcons";
import { TrashIcon } from "./TrashIcon";

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
  /** When set, dragging files from the desktop onto this card calls
   *  the handler with the dropped File list. Used by the filestores-
   *  list view so users can drop files directly onto a collection
   *  card without first opening it. */
  onFilesDropped?: (files: File[]) => void | Promise<void>;
  /** When set, the card shows a hover-revealed trash button that
   *  invokes this handler. The handler is responsible for any
   *  confirmation prompt — the grid just wires the click + stops
   *  propagation so the card's `onClick` doesn't fire. */
  onDelete?: () => void | Promise<void>;
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
      {cards.map((c) => (
        <EntityCardItem key={c.key} card={c} fallbackIcon={meta.icon} />
      ))}
    </div>
  );
}

function EntityCardItem({
  card: c,
  fallbackIcon,
}: {
  card: EntityCard;
  fallbackIcon: ReactNode;
}) {
  const [dragOver, setDragOver] = useState(false);
  const Tag = c.onClick ? "button" : "div";
  const dropProps = c.onFilesDropped
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        },
        onDragLeave: () => setDragOver(false),
        onDrop: async (e: React.DragEvent) => {
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          await c.onFilesDropped?.(files);
        },
      }
    : {};
  const card = (
    <Tag
      type={c.onClick ? "button" : undefined}
      className={`entity-card ${c.onClick ? "entity-card-clickable" : ""}${
        dragOver ? " entity-card-drag" : ""
      }`}
      onClick={c.onClick}
      {...dropProps}
    >
      <span className="entity-card-glyph" aria-hidden>
        {c.icon ?? fallbackIcon}
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
  if (!c.onDelete) return card;
  // The delete button has to sit OUTSIDE the card's <button> element
  // — nesting interactive controls inside a button is invalid HTML
  // and the click target collapses. Wrap card + delete button in a
  // relatively-positioned div and overlay the trash button at the
  // top-right; CSS hides it until the wrapper is hovered.
  return (
    <div className="entity-card-wrapper">
      {card}
      <button
        type="button"
        className="entity-card-delete"
        title={`Delete ${c.title}`}
        aria-label={`Delete ${c.title}`}
        onClick={(e) => {
          e.stopPropagation();
          void c.onDelete?.();
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

