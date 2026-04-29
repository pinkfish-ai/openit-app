import { useEffect, useState, type ReactNode } from "react";
import { getActiveSession, subscribeActiveSession } from "./activeSession";

/**
 * Header strip above the xterm. The "live" dot reflects actual pty
 * session state — green-breathing while a Claude session is connected,
 * dimmed when nothing is running.
 *
 * The `+` button asks the parent to remount ChatPane with a fresh
 * pty (Shell.tsx bumps a session key on click). The optional
 * `dragHandle` slot is where the parent injects a PaneDragHandle so
 * the chat pane can be dragged to reorder.
 */
export function ChatShellHeader({
  onNewSession,
  onResumeSession,
  dragHandle,
}: {
  onNewSession: () => void;
  onResumeSession?: () => void;
  dragHandle?: ReactNode;
}) {
  const [alive, setAlive] = useState<boolean>(
    () => getActiveSession() !== null,
  );

  useEffect(() => subscribeActiveSession((id) => setAlive(id !== null)), []);

  return (
    <div className="chat-shell-header">
      {dragHandle}
      <span className="chat-shell-title">Claude</span>
      <span className="chat-shell-sub">your IT co-pilot</span>
      <span className="chat-shell-spacer" />
      <span
        className={`chat-shell-dot ${alive ? "alive" : "idle"}`}
        title={alive ? "Session connected" : "No active session"}
      />
      {onResumeSession && (
        <button
          type="button"
          className="pane-icon-btn pane-icon-btn-accent"
          onClick={onResumeSession}
          title="Resume previous Claude session"
          aria-label="Resume a previous Claude session"
        >
          ↺
        </button>
      )}
      <button
        type="button"
        className="pane-icon-btn pane-icon-btn-accent"
        onClick={onNewSession}
        title="New Claude session"
        aria-label="Start a new Claude session"
      >
        +
      </button>
    </div>
  );
}
