---
name: report
description: Generate a custom helpdesk report from the local ticket and conversation data. Reads tickets / conversations / people, drafts a markdown report, writes it to reports/<timestamp>-<slug>.md so the newest report sorts to the top of the explorer. Use for anything more specific than the canned "Generate overview" — e.g. "VPN tickets last month", "which KB articles were cited most this quarter", "summarize escalations by asker".
---

## When to use

Slash-invoked by the admin: `/report <what they want a report on>`. The instant, canned helpdesk overview is produced by the **Generate overview** button in the explorer (which shells out to `.claude/scripts/report-overview.mjs`); this skill is the freeform path for anything that button doesn't already cover.

Both paths write into the same `reports/` folder. Newest sorts to the top by filename.

## How to run it

### 1. Clarify the scope (only if the request is genuinely ambiguous)

Don't pepper the admin with questions. If they said "VPN tickets" you have enough — pick the obvious time window (last 30 days) and run with it; mention the choice in the report header so they can push back.

Ask only when there's a real fork: "tickets" could mean only-escalated or all-statuses, "performance" could mean response time or KB-hit rate. One question, then go.

### 2. Read the data you need

Everything is local files — use the built-in tools:

- **Tickets** — `Glob "databases/tickets/*.json"`, `Read` each that matches the scope.
- **Conversations** — for each relevant ticket, `databases/conversations/<ticketId>/msg-*.json`. Skip `*.server.*` (sync conflict shadows).
- **People** — `databases/people/*.json` for asker lookups.
- **KB** — `Glob "knowledge-bases/**/*.md"` if the report is about KB coverage / cited articles.

For a report scoped to a date range, filter by `createdAt` (for "tickets opened in window") or `updatedAt` (for "tickets touched in window"). Both are ISO-8601 strings — `Date.parse()`-comparable.

### 3. Draft the report

Markdown. Lead with a `# Title` that explains what the report covers. Include a one-line generated-at note so the admin can tell which run they're looking at:

```markdown
# VPN tickets — last 30 days

_Generated 2026-04-27T14:32:00Z — 12 tickets matching tag:vpn._

## By status
| Status | Count |
| --- | --- |
| escalated | 4 |
| resolved | 8 |

## …
```

Use plain markdown tables. No HTML, no charts. If a section has no data, write `_None._` rather than rendering an empty table.

### 4. Write the file

`Write` to `reports/<timestamp>-<slug>.md`:

- **`<timestamp>`** = local time as `YYYY-MM-DD-HHmm` (e.g. `2026-04-27-1432`). Reverse-alphabetical sort on the filename puts the newest report at the top of the explorer with no metadata read.
- **`<slug>`** = kebab-case derived from the report title, max ~40 chars. e.g. `vpn-tickets-last-30-days`.

If `reports/` doesn't exist yet, `Write` creates it.

### 5. Tell the admin where it landed

Show the path and the headline numbers so they don't have to open the file to know if it answered the question. Offer to refine in place — further iterations should `Edit` the same file rather than create a new timestamped one (a fresh prompt = fresh file; a refinement = edit-in-place).

```
Wrote reports/2026-04-27-1432-vpn-tickets-last-30-days.md.

12 VPN-tagged tickets in the window — 4 currently escalated, 8 resolved.

Want me to dig into the escalated ones, or break it down by asker?
```

## What this skill is *not* for

- **Canned overviews** — use the **Generate overview** button (one click, deterministic, free, runs in <1s).
- **Live dashboards** — reports are point-in-time snapshots. If the admin wants something they'll re-run regularly, write the snapshot now and offer to `/schedule` a recurring agent for it.
- **Multi-step playbooks** — those are workflows (V2). A report is read-only output.
