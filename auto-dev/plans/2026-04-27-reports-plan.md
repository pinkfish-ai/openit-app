# Reports — plan

**Goal**: a `reports/` directory the admin can browse from the explorer, populated two ways:
1. **Programmatic + instant** — a "Generate overview" button shells out to a Node script that reads tickets/people/conversations and writes a markdown summary in <1s. No LLM, deterministic, free.
2. **Freeform via skill** — `/report <prompt>` skill lets Claude read the same data and author a custom markdown report into the same dir.

Both write to `reports/<YYYY-MM-DD-HHmm>-<slug>.md`. Newest sorts to the top by filename — no metadata lookup needed.

**Non-goals (V1)**: scheduling, recurring reports, dedup, charts, parametrized templates ("last 30 days"), cloud-sync target, re-run-in-place, search/tags, an agent. The substrate is just a folder of markdown — every one of those is a future bolt-on.

---

## Storage shape

- New top-level `reports/` (sibling of `agents/`, `workflows/`, `knowledge-bases/`, `filestores/`).
- Files: `reports/<YYYY-MM-DD-HHmm>-<slug>.md`. Plain markdown. No JSON, no schema, no required frontmatter.
- Newest-first via reverse alphabetical on filename — same trick `databases/conversations/<ticketId>/msg-*.json` uses.
- Each `/report` run or "Generate overview" click writes a *new* timestamped file. We accept clutter for V1; dedup is a later concern.

---

## Component A — programmatic script

**File**: `scripts/openit-plugin/scripts/report-overview.mjs`. Same dev-loop as the other plugin scripts (edit here, copy to `~/OpenIT/<orgId>/.claude/scripts/` for testing, copy to `/web` at merge).

**Reads**:
- `databases/tickets/*.json` — status counts, recent activity, escalation list.
- `databases/people/*.json` — asker name lookup.
- `databases/conversations/<ticketId>/msg-*.json` — turn counts, last activity (skip `*.server.*`).

**Computes** (single pass, all in-memory):
- Tickets by status (`incoming`, `agent-responding`, `answered`, `escalated`, `resolved`, `closed`).
- Last 7 days: created / resolved / escalated counts.
- Top 5 askers by ticket volume.
- Currently-escalated list with subject + age.

**Writes**: `reports/<timestamp>-overview.md` with `# Helpdesk overview`, generated-at line, tables. Markdown only — no charts.

**Stdout**: one JSON line, matching the existing scripts pattern (`sync-push.mjs`, `kb-search.mjs`):
- success: `{"ok":true,"path":"reports/2026-04-27-1432-overview.md"}`
- failure: `{"ok":false,"error":"<msg>"}`

Runs from terminal (`node .claude/scripts/report-overview.mjs`) or from the in-app button — single code path.

---

## Component B — freeform skill

**File**: `scripts/openit-plugin/skills/report.md`. Admin-facing (no `ai-` prefix), slash-invoked: `/report <prompt>`.

Skill body (concise):
1. Read the admin's prompt.
2. `Glob`/`Read` `databases/tickets/*.json` and the relevant `databases/conversations/<ticketId>/*.json` based on the prompt's scope.
3. Draft markdown — `# Title`, sections, plain tables. Iterate with the admin if they push back.
4. `Write` to `reports/<timestamp>-<slug>.md`. Slug = kebab-case from title, max ~40 chars.
5. Tell the admin the path; offer to refine in place via further `Edit`s on the same file (no new file per iteration).

Add a one-row entry in `scripts/openit-plugin/CLAUDE.md` Skills table and the directory-layout table at the top.

---

## Component C — explorer wiring

**Bootstrap** (`src-tauri/src/project.rs` ~line 65–85): add `"reports"` to the dir-creation list so a fresh project always shows the folder.

**Routing** (`src/shell/entityRouting.ts`):
- Extend the `entity-folder` branch (around line 267–280) to handle `rel === "reports"`.
- Reuse the KB markdown-preview path (first `# heading` or first non-empty line as `description`).
- One sort override: for `entity === "reports"`, sort `files` descending by `name` instead of ascending by `displayName`.
- Add `"reports"` to the `entity` union type in `src/shell/types.ts`.

**Sidebar** (`src/shell/FileExplorer.tsx`): add `reports` to the root-level entity list rendered in the sidebar. Place between `knowledge-base` and `workflows` to keep alphabetical-ish grouping.

**Viewer** (`src/shell/Viewer.tsx`):
- For `entity-folder` views where `entity === "reports"`, render a "Generate overview" button in the empty-state / header area.
- Click → invoke a Tauri command that shells out to `.claude/scripts/report-overview.mjs`.
- On success, refresh the file list and select the new file.
- No new viewer kind — markdown files open in the existing markdown viewer.

**Tauri command** (`src-tauri/src/`): one new command `run_report_overview(repo: String) -> Result<String, String>` that spawns `node .claude/scripts/report-overview.mjs` in the project dir, parses the JSON line, returns the path on success or the error on failure. Mirrors how the existing scripts (`sync-push`, `sync-resolve-conflict`) are invoked.

---

## Docs

- `scripts/openit-plugin/CLAUDE.md` — add `reports/` row to the directory-layout table; add `/report` row to the Skills table; add `report-overview.mjs` row to the Scripts table.
- No new top-level doc; the plan itself is the spec.

---

## Out of scope (named so we resist scope creep)

- Scheduled / cron'd reports (use `/schedule` later if wanted).
- Dedup (today's overview overwrites today's overview, etc.).
- Re-run a freeform report with a fresh data pass.
- Charts, sparklines, structured visualization. Markdown tables are enough.
- Cloud sync target for the `reports/` collection.
- Parameterized templates ("weekly summary", "agent quality").
- Tags / search / pin / archive.

---

## Checklist

### Files to add
- [ ] `scripts/openit-plugin/scripts/report-overview.mjs` — programmatic overview generator.
- [ ] `scripts/openit-plugin/skills/report.md` — `/report <prompt>` skill.

### Files to edit
- [ ] `src-tauri/src/project.rs` — add `"reports"` to bootstrap dirs.
- [ ] `src-tauri/src/lib.rs` (or wherever existing scripts are wired) — register `run_report_overview` command.
- [ ] `src/shell/entityRouting.ts` — handle `rel === "reports"` in entity-folder branch; descending sort for reports.
- [ ] `src/shell/types.ts` — add `"reports"` to the `entity` union.
- [ ] `src/shell/FileExplorer.tsx` — sidebar entry.
- [ ] `src/shell/Viewer.tsx` — "Generate overview" button on reports entity-folder.
- [ ] `src/lib/api.ts` — Tauri-invoke wrapper for `run_report_overview`.
- [ ] `scripts/openit-plugin/CLAUDE.md` — three table updates.

### Test plan
- [ ] Fresh project: `reports/` exists after launch, sidebar shows entry, empty-state shows "Generate overview" button.
- [ ] Click "Generate overview" with seeded tickets → new file `reports/<timestamp>-overview.md` appears at top, opens in viewer with status counts, 7-day activity, top askers, escalations.
- [ ] Run `node .claude/scripts/report-overview.mjs` from terminal in test org dir → identical file written, JSON line printed.
- [ ] Empty project (no tickets) → script writes a report with zero-counts everywhere; no crash.
- [ ] Malformed ticket JSON in `databases/tickets/` → script skips it, continues, doesn't fail the whole run.
- [ ] `/report show me VPN tickets` in the desktop Claude pane → skill reads tickets, writes a markdown file, admin sees it in the explorer.
- [ ] Two reports generated within the same minute → filenames don't collide (use HHmmss or append a short rand if needed; decide during impl).
- [ ] Sort order: newest filename is top of the list in the explorer.
- [ ] Markdown viewer renders the report without layout regressions.
- [ ] No regressions on `agents/`, `workflows/`, `knowledge-bases/`, `filestores/` — entity-folder still ascending-sorted for those.

### Definition of done
- Overview button works end-to-end in `tauri dev` against Ben's test org.
- `/report` skill produces a usable markdown file.
- BugBot loop run on the PR; only Low-severity findings remain.
