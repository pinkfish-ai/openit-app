import { type ReactNode } from "react";

export function ChatShellHeader({
  onNewSession,
  onResumeSession,
  dragHandle,
}: {
  onNewSession: () => void;
  onResumeSession?: () => void;
  dragHandle?: ReactNode;
}) {
  return (
    <div className="chat-shell-header">
      {dragHandle}
      <span className="chat-shell-title">Claude</span>
      <span className="chat-shell-sub">your IT co-pilot</span>
      <span className="chat-shell-spacer" />
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
