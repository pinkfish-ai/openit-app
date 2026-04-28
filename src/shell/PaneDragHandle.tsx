import type { DragEvent } from "react";

type PaneId = "left" | "center" | "right";

/**
 * Small grip handle that lives at the start of each pane's header.
 * The user grabs it and drags onto another pane to reorder — VS Code
 * tab-strip semantics. Only the handle itself is `draggable`, not the
 * surrounding header, so clicks on tabs / buttons next to it continue
 * to work normally.
 *
 * Uses an inline SVG (six-dot grip) rather than a unicode glyph so it
 * renders consistently regardless of font and stays subtle on the
 * cream pane chrome.
 */
export function PaneDragHandle({
  paneId,
  onDragStart,
  onDragEnd,
}: {
  paneId: PaneId;
  onDragStart: (paneId: PaneId, e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <span
      className="pane-drag-handle"
      draggable
      role="button"
      aria-label={`Drag to rearrange the ${paneId} pane`}
      title="Drag to rearrange this pane"
      onDragStart={(e) => onDragStart(paneId, e)}
      onDragEnd={onDragEnd}
    >
      <svg
        viewBox="0 0 12 18"
        width="10"
        height="14"
        fill="currentColor"
        aria-hidden
      >
        <circle cx="3" cy="3" r="1.1" />
        <circle cx="9" cy="3" r="1.1" />
        <circle cx="3" cy="9" r="1.1" />
        <circle cx="9" cy="9" r="1.1" />
        <circle cx="3" cy="15" r="1.1" />
        <circle cx="9" cy="15" r="1.1" />
      </svg>
    </span>
  );
}
