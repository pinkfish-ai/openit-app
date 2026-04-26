# OpenIT Helpdesk — Vision and Phases

**Status:** Active. Phase A in progress on `feat/triage-agent-bootstrap`.

## The pitch

An out-of-the-box IT ticketing system that **gets smarter every time it's used.** The IT admin's only job is to teach the system once — after that it answers itself.

A user asks a question. An AI agent reads it, logs it as a ticket, searches the knowledge base. If the KB has the answer, the agent replies and the ticket closes. If not, the ticket is escalated and a banner pops up in OpenIT — *"new escalated ticket, solve with Claude."* The IT admin clicks through, writes the answer in chat, and Claude turns that answer into a KB article. **Answer once.** Next time someone asks the same question, the agent answers from the KB without anyone touching it.

For action-shaped requests ("reset my password", "give me access to the staging GCP project"), the loop extends. The admin doesn't just write an answer — Claude watches what the admin does to handle the request, and scaffolds a workflow that captures it. Future identical requests run the workflow on autopilot. The system learns both **answers** and **actions** from the admin's responses.

The whole thing lives as files in the user's `~/OpenIT/<orgId>/` folder — agents, workflows, KB articles, ticket data — version-controlled, portable, and editable from any tool. OpenIT is just the interface.

## The flow

```
┌────────────┐
│  User      │  asks a question
└──────┬─────┘
       │
       ▼
┌────────────────┐
│  Triage agent  │  (1) logs ticket
│ openit-triage  │  (2) searches KB
└──────┬─────────┘
       │
       ├─── KB has the answer ──┐
       │                        ▼
       │                  ┌──────────┐
       │                  │  reply   │  ticket closes
       │                  └──────────┘
       │
       └─── KB doesn't have it ─┐
                                ▼
                         ┌─────────────┐
                         │  escalate   │  banner: "Solve with Claude"
                         └──────┬──────┘
                                │
                                ▼
                         ┌─────────────────────┐
                         │  Admin in OpenIT    │
                         │  - reads ticket     │
                         │  - drafts answer    │
                         │  - sends to user    │
                         │  - writes KB article│  ◀─── "answer once"
                         │  - (optionally)     │
                         │    builds workflow  │
                         └─────────────────────┘
                                │
                                ▼
                         next time same question →
                         agent answers from KB,
                         no human needed
```

## Phases

### Phase A — Triage agent bootstrap

**Goal:** out-of-the-box "I have an agent that can answer questions" — even if there's no traffic ingest yet, the user can talk to the agent in Claude Code chat.

What ships:
- Auto-create `openit-triage-<orgId>` agent on connect (mirrors how datastores / filestore are auto-created today).
- Auto-ensure `openit-kb-<orgId>` knowledge base (already happens via `resolveProjectKb`).
- Auto-create `openit-tickets-<orgId>` datastore (already exists via `DEFAULT_DATASTORES`).
- Triage agent's instructions encode the full flow: log ticket → search KB → answer or escalate.

Testable today: connect on a fresh org, see the agent appear in `agents/openit-triage-<orgId>.json`, send the agent a question in Claude chat, watch it run the loop.

What's deferred:
- Resource bindings (API key + canRead/canWrite per datastore/KB). Agent uses gateway tools instead.
- Non-OpenIT channel ingest (Slack/email).

PR scope: ~1 day.

### Phase B — Admin response loop ("Solve with Claude" banner)

**Goal:** when a ticket gets escalated, the admin sees a banner in OpenIT — same UX as the conflict banner. They click "Solve with Claude", which pastes a prompt into the active session walking Claude through reading the ticket, drafting a reply, and capturing the answer as a KB article.

What ships:
- A new banner component (parallel to `ConflictBanner`) that subscribes to a "open ticket" aggregate.
- Detection: scan `databases/openit-tickets-<orgId>/*.json` for rows whose status indicates escalated/open-needs-human. Update on fs change ticks.
- Skill: `/answer-ticket <ticketId>` walks the response flow: read ticket → admin drafts → send reply (channel TBD) → ask "save as KB article?" → on yes, draft and write `knowledge-base/<title>.md`.
- The "answer once" principle is the key UX — we always offer to capture, default yes.

Testable: manually edit a ticket row to status="open", banner appears. Click "Solve with Claude". Skill runs.

PR scope: ~2 days.

### Phase C — Workflow capture for action-shaped tickets

**Goal:** when the admin handles a ticket that requires *doing something* (not just answering), Claude scaffolds a workflow capturing the actions so future identical tickets run on autopilot.

What ships:
- During Phase B's response flow, an additional question: "Was this an answer or an action?"
- If action: Claude follows along as the admin executes (gateway calls, file edits, etc.), then generates a `workflows/<name>.json` describing the steps.
- A "matcher" so the triage agent recognizes when a future ticket fits an existing workflow → runs the workflow instead of escalating.
- Skill: `/capture-workflow <ticketId>`.

Testable: handle an action-shaped ticket, verify a workflow gets generated, run a similar new ticket through and confirm the workflow fires.

PR scope: ~3-5 days. Depends on workflow runtime maturity.

### Phase D — Channel ingest

**Goal:** users don't need OpenIT to file tickets. Email, Slack, web form all funnel into the triage flow.

What ships:
- Wire the triage agent to existing Pinkfish channels (Slack DM, email mailbox, public form).
- Channel-agnostic intake → same triage flow.

PR scope: TBD; depends on channel infrastructure already in `/platform`. Likely a few separate PRs per channel.

### Phase E — Metrics + self-tune

**Goal:** show the admin "how much time the system is saving you" + let the system improve itself.

What ships:
- A simple dashboard view: tickets/week, % auto-answered, KB articles created, workflows captured.
- Agent self-tunes its instructions based on which KB articles get hit / which escalations get marked "wasn't actually a missing KB article" by the admin.

PR scope: V3 territory; not blocking for V1.

## Working order

One phase at a time, one PR per phase. Phase A's the current branch (`feat/triage-agent-bootstrap`).

Order matters: Phase B depends on Phase A's tickets datastore + status field convention. Phase C depends on Phase B's response skill. Phase D is independent of B/C and can run in parallel once Phase A lands. Phase E waits.

## Naming conventions (locked in by Phase A)

- Agent: `openit-triage-<orgId>` — singular per org; the triage entry point.
- Datastore: `openit-tickets-<orgId>` (already named this). Fields per `case-management` template.
- KB: `openit-kb-<orgId>` (already named this).
- Filestore: `openit-docs-<orgId>` (already named this).
- KB articles created by the response loop go in `knowledge-base/` with kebab-case filenames matching the question's intent (e.g., `how-to-reset-vpn-password.md`).
