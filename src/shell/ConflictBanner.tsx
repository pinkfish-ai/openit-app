// Aggregate sync-conflict banner. Subscribes to the engine's conflict
// store and renders a single line at the top of the shell whenever any
// of the five entities has unresolved local-and-remote-changed conflicts.
//
// Click "Resolve in Claude" → composes a generic prompt walking Claude
// through each conflict (canonical vs `.server.` shadow) and pastes
// it into the live Claude PTY. Claude reads, merges, deletes shadows;
// user reviews diff before committing.

import { useEffect, useState } from "react";
import {
  buildConflictPrompt,
  subscribeConflicts,
  type AggregatedConflict,
} from "../lib/syncEngine";
import { writeToActiveSession } from "./activeSession";

export function ConflictBanner({ refreshTick = 0 }: { refreshTick?: number } = {}) {
  const [conflicts, setConflicts] = useState<AggregatedConflict[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => subscribeConflicts(setConflicts), []);

  // A user-initiated refresh (manual pull, etc.) is a deliberate
  // "show me current state" gesture, so any prior dismiss should
  // clear. Without this, dismissing once + the engine re-emitting the
  // same conflict on a fresh pull would leave the banner permanently
  // hidden until the conflict set actually changed (or the app
  // restarted). The user reported exactly that.
  useEffect(() => {
    if (refreshTick > 0) setDismissedKey(null);
  }, [refreshTick]);

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

  const onResolveInClaude = async () => {
    if (resolving) return;
    const prompt = buildConflictPrompt(conflicts);
    if (!prompt) return;
    setResolving(true);
    try {
      // Wrap in bracketed-paste escapes so the multi-line prompt lands
      // as a single composed message instead of getting submitted line-
      // by-line by the TUI's input layer. Modern Ink-based CLIs (Claude
      // Code included) honor ESC[200~ … ESC[201~. Single-line prompts
      // would be unaffected, but the pattern is harmless either way.
      const wrapped = `\x1b[200~${prompt}\x1b[201~`;
      await writeToActiveSession(wrapped);
    } catch (e) {
      console.error("[conflict-banner] paste-to-Claude failed:", e);
    } finally {
      // Re-enable quickly even on error — user might want to retry.
      setTimeout(() => setResolving(false), 500);
    }
  };

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
        className="conflict-banner-resolve"
        onClick={onResolveInClaude}
        disabled={resolving}
        title="Send the conflict list to Claude for guided merge"
      >
        {resolving ? "Sending…" : "Resolve in Claude"}
      </button>
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
