import type { DragEvent } from "react";

type PaneId = "left" | "center" | "right";

/**
 * Small grip handle that lives at the start of each pane's header.
 * The user grabs it and drags onto another pane to reorder — VS Code
 * tab-strip semantics. Only the handle itself is `draggable`, not the
 * surrounding header, so clicks on tabs / buttons next to it continue
 * to work normally.
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
      ⠿
    </span>
  );
}
