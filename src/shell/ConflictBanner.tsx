// Aggregate sync-conflict banner. Subscribes to the engine's conflict
// store and renders a single line at the top of the shell whenever any
// of the five entities has unresolved local-and-remote-changed conflicts.
//
// Minimum-viable R5 surface: count + first path + dismiss. Per-entity
// "Resolve in Claude" prompt-builder integration is deferred.

import { useEffect, useState } from "react";
import {
  subscribeConflicts,
  type AggregatedConflict,
} from "../lib/syncEngine";

export function ConflictBanner() {
  const [conflicts, setConflicts] = useState<AggregatedConflict[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => subscribeConflicts(setConflicts), []);

  // Build a stable key from the conflict set so a new conflict (after
  // dismiss) re-shows the banner. Per-session dismiss only — sticks
  // until the conflict set changes meaningfully.
  const conflictKey = conflicts
    .map((c) => `${c.prefix}:${c.manifestKey}`)
    .sort()
    .join("|");

  if (conflicts.length === 0) return null;
  if (dismissedKey === conflictKey) return null;

  const first = conflicts[0];
  const others = conflicts.length - 1;

  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-banner-icon" aria-hidden>⚠</span>
      <span className="conflict-banner-text">
        {conflicts.length} sync conflict
        {conflicts.length === 1 ? "" : "s"}. Local edits diverge from
        Pinkfish on <strong>{first.workingTreePath}</strong>
        {others > 0
          ? ` and ${others} other file${others === 1 ? "" : "s"}`
          : ""}
        .
      </span>
      <button
        type="button"
        className="conflict-banner-dismiss"
        onClick={() => setDismissedKey(conflictKey)}
        title="Hide until the conflict set changes"
      >
        Dismiss
      </button>
    </div>
  );
}
