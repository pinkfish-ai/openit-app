// Indicator for tickets the agent escalated — admin must handle.
// Renders inside the right (chat) pane just above the chat stream
// as a small pulsing amber pill (see src/ui/EscalationPill.tsx).
//
// v5 third pass: the previous full-width sage Banner read as too
// quiet on the dark chat surface and ate too much vertical space
// for what is fundamentally a one-line nudge. The pill is denser,
// glows warm against dark, and click = the same /answer-ticket
// flow.
//
// Click "Answer ticket" → pastes an /answer-ticket invocation
// referencing the queued ticket files into the active Claude PTY,
// where the admin can draft a reply with Claude's help. After the
// paste, the dismissed-key state hides the pill until a new ticket
// escalates.
//
// Driven by fs-tick: the parent Shell's fs watcher bumps `fsTick`
// on every change under the project root, which re-scans
// `databases/tickets/` for `status: "escalated"`.

import { useEffect, useState } from "react";
import { scanEscalatedTickets, type TicketSummary } from "../lib/escalatedTickets";
import { writeToActiveSession } from "./activeSession";
import { EscalationPill } from "../ui";

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

  // Stable key from the ticket set so a new ticket re-shows the pill
  // even after the user dismissed a prior set.
  const ticketKey = tickets.map((t) => t.relPath).sort().join("|");

  if (tickets.length === 0) return null;
  if (dismissedKey === ticketKey) return null;

  const first = tickets[0];
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
      // the dismissal and re-shows the pill.
      setDismissedKey(ticketKey);
    } catch (e) {
      console.error("[escalated-banner] paste-to-Claude failed:", e);
    } finally {
      setTimeout(() => setSending(false), 500);
    }
  };

  return (
    <EscalationPill
      count={tickets.length}
      subject={subjectLabel}
      onClick={onAnswer}
      disabled={sending}
      title={
        sending
          ? "Sending…"
          : "Open the queued tickets with Claude to draft a response"
      }
    />
  );
}
