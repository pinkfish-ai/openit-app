// Banner that surfaces tickets the triage agent escalated. Parallel
// to ConflictBanner — same paste-into-active-Claude pattern, same
// refreshTick prop for dismiss-clear semantics.
//
// Phase B of the helpdesk vision (auto-dev/plans/2026-04-26-helpdesk-vision.md).

import { useEffect, useState } from "react";
import {
  subscribeEscalatedTickets,
  type EscalatedTicket,
} from "../lib/ticketStatus";
import { writeToActiveSession } from "./activeSession";

export function EscalatedTicketBanner({
  refreshTick = 0,
}: { refreshTick?: number } = {}) {
  const [tickets, setTickets] = useState<EscalatedTicket[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => subscribeEscalatedTickets(setTickets), []);

  // Same dismiss-clear-on-refresh semantic as ConflictBanner — manual
  // pulls / post-push events bump refreshTick so a stale dismiss
  // doesn't keep the banner hidden when the user explicitly asked
  // for a fresh look.
  useEffect(() => {
    if (refreshTick > 0) setDismissedKey(null);
  }, [refreshTick]);

  // Stable key identifies the current ticket set for dismiss tracking.
  const ticketKey = tickets
    .map((t) => t.workingTreePath)
    .sort()
    .join("|");

  if (tickets.length === 0) return null;
  if (dismissedKey === ticketKey) return null;

  const onSolveInClaude = async () => {
    if (resolving) return;
    setResolving(true);
    try {
      const lines = ["/answer-ticket", "", "Tickets:"];
      for (const t of tickets) {
        lines.push(`- \`${t.workingTreePath}\``);
      }
      const prompt = lines.join("\n");
      const wrapped = `\x1b[200~${prompt}\x1b[201~`;
      await writeToActiveSession(wrapped);
    } catch (e) {
      console.error("[escalated-ticket-banner] paste-to-Claude failed:", e);
    } finally {
      setTimeout(() => setResolving(false), 500);
    }
  };

  return (
    <div className="escalated-ticket-banner" role="alert">
      <span className="escalated-ticket-banner-icon" aria-hidden>
        🎫
      </span>
      <span className="escalated-ticket-banner-text">
        {tickets.length} escalated ticket
        {tickets.length === 1 ? "" : "s"} need
        {tickets.length === 1 ? "s" : ""} a human.
      </span>
      <button
        type="button"
        className="escalated-ticket-banner-resolve"
        onClick={onSolveInClaude}
        disabled={resolving}
        title="Send the escalated tickets to Claude for guided response"
      >
        {resolving ? "Sending…" : "Solve with Claude"}
      </button>
      <button
        type="button"
        className="escalated-ticket-banner-dismiss"
        onClick={() => setDismissedKey(ticketKey)}
        title="Hide until the ticket set changes"
      >
        Dismiss
      </button>
    </div>
  );
}
