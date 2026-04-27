// Local-mode incoming-ticket banner. Pinned to the top of the shell
// (just below the conflict banner) whenever any ticket row has
// `status: "incoming"`. Click "Triage in Claude" → pastes a /triage
// invocation referencing the queued ticket files into the active
// Claude PTY.
//
// Driven by fs-tick: the parent Shell's fs watcher bumps `fsTick` on
// every change under the project root, which re-scans the
// openit-tickets-* dirs and refreshes the banner. The watcher already
// covers row writes (admin's `Write` from chat, the localhost intake
// form's POST handler, cloud channel ingest), so no separate event
// source is needed.

import { useEffect, useState } from "react";
import { scanIncomingTickets, type IncomingTicket } from "../lib/incomingTickets";
import { writeToActiveSession } from "./activeSession";

export function IncomingTicketBanner({
  repo,
  fsTick,
}: {
  repo: string | null;
  fsTick: number;
}) {
  const [tickets, setTickets] = useState<IncomingTicket[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!repo) {
      setTickets([]);
      return;
    }
    let cancelled = false;
    scanIncomingTickets(repo)
      .then((rows) => {
        if (!cancelled) setTickets(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[incoming-banner] scan failed:", e);
          setTickets([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repo, fsTick]);

  // Stable key from the ticket set so a new ticket re-shows the banner
  // even after the user dismissed a prior set. Same pattern as
  // ConflictBanner.
  const ticketKey = tickets.map((t) => t.relPath).sort().join("|");

  if (tickets.length === 0) return null;
  if (dismissedKey === ticketKey) return null;

  const first = tickets[0];
  const others = tickets.length - 1;
  const subjectLabel = first.subject || first.relPath.split("/").pop() || first.relPath;

  const onTriage = async () => {
    if (sending) return;
    setSending(true);
    try {
      // Compose a /triage invocation that references the queued ticket
      // file(s) by repo-relative path. The triage skill (Phase 1) reads
      // those files, picks up subject/asker/description, and walks the
      // log → search → answer/escalate flow, flipping each row's status
      // out of "incoming" when done.
      const lines: string[] = [];
      lines.push(
        tickets.length === 1
          ? `/triage incoming ticket: ${first.relPath}`
          : `/triage ${tickets.length} incoming tickets:`,
      );
      if (tickets.length > 1) {
        for (const t of tickets) lines.push(`  - ${t.relPath}`);
      }
      lines.push("");
      lines.push(
        "Read each file, then run the triage flow on the row: log a conversation turn capturing the asker's question, search the knowledge base, answer if confident or escalate if not, and update the row's status. Do not invent answers.",
      );
      const prompt = lines.join("\n");
      // Bracketed-paste so the multi-line invocation lands as a single
      // composed message (matches ConflictBanner's pattern).
      const wrapped = `\x1b[200~${prompt}\x1b[201~`;
      await writeToActiveSession(wrapped);
    } catch (e) {
      console.error("[incoming-banner] paste-to-Claude failed:", e);
    } finally {
      setTimeout(() => setSending(false), 500);
    }
  };

  return (
    <div className="incoming-ticket-banner" role="status">
      <span className="incoming-ticket-banner-icon" aria-hidden>
        ✎
      </span>
      <span className="incoming-ticket-banner-text">
        {tickets.length} new ticket{tickets.length === 1 ? "" : "s"} —{" "}
        <strong>{subjectLabel}</strong>
        {others > 0 ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}.
      </span>
      <button
        type="button"
        className="incoming-ticket-banner-action"
        onClick={onTriage}
        disabled={sending}
        title="Send the queued tickets to Claude for triage"
      >
        {sending ? "Sending…" : "Triage in Claude"}
      </button>
      <button
        type="button"
        className="incoming-ticket-banner-dismiss"
        onClick={() => setDismissedKey(ticketKey)}
        title="Hide until a new ticket arrives"
      >
        Dismiss
      </button>
    </div>
  );
}
