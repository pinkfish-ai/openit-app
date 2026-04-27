// Live activity banner — shows when any ticket has
// `status: "agent-responding"`, i.e. a `claude -p` chat-intake
// subprocess is currently composing a reply for that ticket. Gives
// the admin real-time visibility into what the agent is working on.
//
// Auto-clears when the agent finishes (status flips to resolved /
// escalated / something else). Not dismissable — it's a transient
// status indicator, not a notification.
//
// Driven by fs-tick: the parent Shell's fs watcher bumps `fsTick`
// when ticket files change. We re-scan and refresh.

import { useEffect, useState } from "react";
import {
  scanAgentRespondingTickets,
  type TicketSummary,
} from "../lib/escalatedTickets";

export function AgentActivityBanner({
  repo,
  fsTick,
}: {
  repo: string | null;
  fsTick: number;
}) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);

  useEffect(() => {
    if (!repo) {
      setTickets([]);
      return;
    }
    let cancelled = false;
    scanAgentRespondingTickets(repo)
      .then((rows) => {
        if (!cancelled) setTickets(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[agent-activity-banner] scan failed:", e);
          setTickets([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repo, fsTick]);

  if (tickets.length === 0) return null;

  const first = tickets[0];
  const others = tickets.length - 1;
  const subjectLabel = first.subject || first.relPath.split("/").pop() || first.relPath;

  return (
    <div className="agent-activity-banner" role="status">
      <span className="agent-activity-banner-spinner" aria-hidden>
        ◐
      </span>
      <span className="agent-activity-banner-text">
        Agent is responding to <strong>{subjectLabel}</strong>
        {others > 0 ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}…
      </span>
    </div>
  );
}
