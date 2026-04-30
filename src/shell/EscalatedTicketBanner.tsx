// Floating top-right notification toast for tickets the agent
// escalated — admin must handle. Renders like a macOS notification:
// pinned top-right of the app shell, persistent until the admin
// either takes action ("Answer ticket") or explicitly dismisses.
//
// Driven by fs-tick: the parent Shell's fs watcher bumps `fsTick`
// on every change under the project root, which re-scans
// `databases/tickets/` for `status: "escalated"`. No separate
// event source.

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

  // Stable key from the ticket set so a new ticket re-shows the
  // toast after a prior batch was dismissed or actioned.
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
      const lines: string[] = [];
      lines.push(
        tickets.length === 1
          ? `/answer-ticket ${first.relPath}`
          : `/answer-ticket ${tickets.length} escalated tickets:`,
      );
      if (tickets.length > 1) {
        for (const t of tickets) lines.push(`  - ${t.relPath}`);
      }
      const wrapped = `\x1b[200~${lines.join("\n")}\x1b[201~`;
      await writeToActiveSession(wrapped);

      if (onOpenPath && repo) {
        const ticketFile = first.relPath.split("/").pop() || "";
        const ticketId = ticketFile.replace(/\.json$/, "");
        if (ticketId) {
          onOpenPath(`${repo}/databases/conversations/${ticketId}`);
        }
      }
      // Dismiss this batch once the admin actioned it. A new ticket
      // escalating later changes ticketKey, which clears the dismissal
      // and re-shows the toast.
      setDismissedKey(ticketKey);
    } catch (e) {
      console.error("[escalated-banner] paste-to-Claude failed:", e);
    } finally {
      setTimeout(() => setSending(false), 500);
    }
  };

  return (
    <div className="escalated-toast-anchor">
      <Banner
        variant="warn"
        eyebrow="Needs your reply"
        icon="✎"
        onClose={() => setDismissedKey(ticketKey)}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={onAnswer}
            loading={sending}
            disabled={sending}
            title="Open the queued tickets with Claude to draft a response"
          >
            {sending ? "Sending…" : "Answer ticket"}
          </Button>
        }
      >
        <strong>{subjectLabel}</strong>
        {others > 0 ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}
      </Banner>
    </div>
  );
}
