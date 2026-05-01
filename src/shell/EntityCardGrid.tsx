import { useEffect, useState, type ReactNode } from "react";
import { ENTITY_META, type EntityKind } from "./entityIcons";
import { TrashIcon } from "./TrashIcon";
import { PlayIcon } from "./PlayIcon";
import { Button } from "../ui";

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
   *  propagation so the card's `onClick` doesn't fire. Also bound
   *  to Backspace/Delete when the card is focused, and exposed
   *  as a "Delete" entry in the right-click context menu. */
  onDelete?: () => void | Promise<void>;
  /** When set, the right-click context menu shows a "Reveal in
   *  Finder" entry that calls this handler. */
  onReveal?: () => void | Promise<void>;
  /** When set, the card shows a hover-revealed play button that
   *  invokes this handler. Used by the scripts-folder cards to
   *  spawn `node <script>` and route the viewer to the captured
   *  stdout/stderr. The handler is responsible for any guard
   *  prompts — the grid just wires the click + stops propagation
   *  so the card's onClick (which would open the file) doesn't
   *  fire alongside the run. */
  onRun?: () => void | Promise<void>;
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
  const [menu, setMenu] = useState<{
    cardKey: string;
    x: number;
    y: number;
  } | null>(null);

  // Dismiss the menu on Escape or any click outside.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

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

  const activeCard = menu ? cards.find((c) => c.key === menu.cardKey) : null;

  return (
    <div className={`entity-grid entity-tone-${meta.tone}`}>
      {cards.map((c) => (
        <EntityCardItem
          key={c.key}
          card={c}
          fallbackIcon={meta.icon}
          onContextMenu={(x, y) => {
            if (!c.onDelete && !c.onReveal) return;
            setMenu({ cardKey: c.key, x, y });
          }}
        />
      ))}
      {menu && activeCard && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="context-menu"
            style={{ top: menu.y, left: menu.x }}
            role="menu"
          >
            {activeCard.onReveal && (
              <Button
                variant="ghost"
                className="context-menu-item"
                onClick={() => {
                  void activeCard.onReveal?.();
                  setMenu(null);
                }}
              >
                Reveal in Finder
              </Button>
            )}
            {activeCard.onDelete && (
              <Button
                variant="ghost"
                tone="destructive"
                className="context-menu-item"
                onClick={() => {
                  // The onDelete handler runs its own window.confirm()
                  // — duplicating it here with an arm-twice click
                  // forced three clicks to delete from the menu. Drop
                  // straight into the handler.
                  void activeCard.onDelete?.();
                  setMenu(null);
                }}
              >
                Delete
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EntityCardItem({
  card: c,
  fallbackIcon,
  onContextMenu,
}: {
  card: EntityCard;
  fallbackIcon: ReactNode;
  onContextMenu: (x: number, y: number) => void;
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
          // preventDefault MUST run before any early return — without
          // it the Tauri webview falls back to its default drop
          // behavior (navigate to the file URL) and the SPA unloads.
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length === 0) return;
          await c.onFilesDropped?.(files);
        },
      }
    : {};
  // Keyboard delete: a focused clickable card responds to Backspace
  // or Delete by triggering its onDelete handler. The handler runs
  // its own confirm() so a fat-finger keystroke can't silently nuke
  // a file. Only clickable cards (which render as <button>) can
  // receive focus, so this is naturally scoped.
  const onKeyDown = c.onDelete
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          void c.onDelete?.();
        }
      }
    : undefined;
  const card = (
    <Tag
      type={c.onClick ? "button" : undefined}
      className={`entity-card ${c.onClick ? "entity-card-clickable" : ""}${
        dragOver ? " entity-card-drag" : ""
      }`}
      onClick={c.onClick}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (!c.onDelete && !c.onReveal) return;
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
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
  if (!c.onDelete && !c.onRun) return card;
  // Action buttons (run, delete) have to sit OUTSIDE the card's
  // <button> element — nesting interactive controls inside a button
  // is invalid HTML and the click target collapses. Wrap card +
  // overlays in a relatively-positioned div and absolute-position
  // each action at the top-right; CSS hides them until the wrapper
  // is hovered. Run sits to the LEFT of delete so the destructive
  // gesture stays on the far edge.
  return (
    <div className="entity-card-wrapper">
      {card}
      {c.onRun && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="entity-card-run"
          title={`Run ${c.title}`}
          aria-label={`Run ${c.title}`}
          onClick={(e) => {
            e.stopPropagation();
            void c.onRun?.();
          }}
        >
          <PlayIcon />
        </Button>
      )}
      {c.onDelete && (
        <Button
          variant="ghost"
          tone="destructive"
          size="sm"
          iconOnly
          className="entity-card-delete"
          title={`Delete ${c.title}`}
          aria-label={`Delete ${c.title}`}
          onClick={(e) => {
            e.stopPropagation();
            void c.onDelete?.();
          }}
        >
          <TrashIcon />
        </Button>
      )}
    </div>
  );
}
