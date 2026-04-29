// Banner for tickets the agent escalated — admin must handle.
// Renders INLINE inside the right (chat) pane, just below the chat
// header and above the chat stream. (v5: previously rendered with
// position: fixed at the top-right of the viewport, which clipped
// over the chat pane's rounded corner. Re-parented in the
// design-system-v5 PR so it composes with the pane's own chrome.)
//
// Click "Answer ticket" → pastes an /answer-ticket invocation
// referencing the queued ticket files into the active Claude PTY,
// where the admin can draft a reply with Claude's help.
//
// Driven by fs-tick: the parent Shell's fs watcher bumps `fsTick` on
// every change under the project root, which re-scans `databases/
// tickets/` for `status: "escalated"`. No separate event source.

import { useEffect, useState } from "react";
import { scanEscalatedTickets, type TicketSummary } from "../lib/escalatedTickets";
import { writeToActiveSession } from "./activeSession";
import { Banner, Button } from "../ui";

export function EscalatedTicketBanner({
  repo,
  fsTick,
  onOpenPath,
}: {
  repo: string | null;
  fsTick: number;
  onOpenPath?: (path: string) => void;
}) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!repo) {
      setTickets([]);
      return;
    }
    let cancelled = false;
    scanEscalatedTickets(repo)
      .then((rows) => {
        if (!cancelled) setTickets(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[escalated-banner] scan failed:", e);
          setTickets([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repo, fsTick]);

  // Stable key from the ticket set so a new ticket re-shows the banner
  // even after the user dismissed a prior set.
  const ticketKey = tickets.map((t) => t.relPath).sort().join("|");

  if (tickets.length === 0) return null;
  if (dismissedKey === ticketKey) return null;

  const first = tickets[0];
  const others = tickets.length - 1;
  const subjectLabel = first.subject || first.relPath.split("/").pop() || first.relPath;

  const onAnswer = async () => {
    if (sending) return;
    setSending(true);
    try {
      // The agent already triaged — its asker turn + escalation reply
      // are in the conversation thread. The admin's job: read the
      // thread, draft a reply, log it.
      const lines: string[] = [];
      lines.push(
        tickets.length === 1
          ? `/answer-ticket ${first.relPath}`
          : `/answer-ticket ${tickets.length} escalated tickets:`,
      );
      if (tickets.length > 1) {
        for (const t of tickets) lines.push(`  - ${t.relPath}`);
      }
      const prompt = lines.join("\n");
      const wrapped = `\x1b[200~${prompt}\x1b[201~`;
      await writeToActiveSession(wrapped);

      // Also pop the conversation view open in the center panel so
      // the admin can read the thread alongside Claude's draft.
      // Ticket id == conversation folder name (relPath is the ticket
      // file's relative path, e.g. databases/tickets/<id>.json).
      if (onOpenPath && repo) {
        const ticketFile = first.relPath.split("/").pop() || "";
        const ticketId = ticketFile.replace(/\.json$/, "");
        if (ticketId) {
          onOpenPath(`${repo}/databases/conversations/${ticketId}`);
        }
      }
      // Auto-dismiss after Answer — the admin acted on this batch.
      // A new ticket escalating later changes ticketKey, which clears
      // the dismissal and re-shows the toast.
      setDismissedKey(ticketKey);
    } catch (e) {
      console.error("[escalated-banner] paste-to-Claude failed:", e);
    } finally {
      setTimeout(() => setSending(false), 500);
    }
  };

  return (
    <Banner
      variant="success"
      inline
      icon="✎"
      eyebrow="Needs your reply"
      actions={
        <>
          <Button
            variant="primary"
            size="sm"
            onClick={onAnswer}
            disabled={sending}
            title="Open the queued tickets with Claude to draft a response"
          >
            {sending ? "Sending…" : "Answer ticket"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDismissedKey(ticketKey)}
            title="Hide until a new ticket escalates"
          >
            Dismiss
          </Button>
        </>
      }
    >
      <strong>{subjectLabel}</strong>
      {others > 0 ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}
    </Banner>
  );
}
