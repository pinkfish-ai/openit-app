# Stage 02 — Implementation plan

Stage 01 produced a Linear ticket: the *why*, scope, success criteria. This stage is where you actually touch the codebase to figure out *how* to build it. Output is a markdown file under `auto-dev/plans/` that becomes the contract for the work.

**Naming:** `auto-dev/plans/YYYY-MM-DD-PIN-####-short-name.md` (date-prefix sorts the folder; PIN-#### makes the ticket trivially findable).

---

## Pre-flight

Before opening the editor on the plan file:

1. **Linear ticket open** — you have the PIN-#### handy, you've re-read the brief.
2. **`gh auth status`** — clean. PR work later will need it.
3. **Reference repos checked out** — `/web`, `/platform`, `/firebase-helpers`, `/pinkfish-connections` siblings of `/openit-app` under `~/Documents/GitHub/`. You'll grep these read-only.
4. **Plugin loop awareness** — if the change touches anything under `scripts/openit-plugin/`, the plan must include the `/web` mirror step at merge time. See `auto-dev/00-autodev-overview.md` § "Plugin scripts and prompts".

## Scope clarification (before writing the plan)

1. **Re-read the ticket carefully.** List every symptom or feature request it describes.
2. **If the ticket is broad or ambiguous,** present a brief scope summary back to the human and confirm before writing the plan. Don't assume all symptoms are in scope.
3. **If you narrow scope,** open a follow-up Linear ticket immediately for the deferred work and link it to the current ticket. Don't leave deferred items as informal notes.

## Plan document structure

### Header (required)

Every plan file MUST start with:

```markdown
# PIN-XXXX: [Short title] — Implementation plan

**Ticket:** [PIN-XXXX](https://linear.app/pinkfish/issue/PIN-XXXX/...)
**Date:** YYYY-MM-DD
**Repo:** `openit-app` (primary)
**References:** `/web` (plugin home, FE patterns), `/platform` (MCPs, services), `/firebase-helpers` (resource APIs), `/pinkfish-connections` (proxy)
**Predecessor:** PIN-YYYY (if this builds on prior work)

---
```

### 1. Technical investigation

The deep dive. Read from `main` of openit-app and whatever sibling repos the change touches. Build a thorough understanding of current state before proposing anything.

**For bugs:**
- Trace the execution path. Follow the code from user action → broken behavior. Cite exact files + functions + line numbers.
- Identify the root cause. Go past symptoms — find the specific code, state-flow, or contract that causes the issue.

**For features:**
- Map existing patterns. How is similar functionality already built in openit-app? What conventions does the codebase follow (sync engines, fetch adapters, Tauri commands, viewer components)?
- Identify integration points. Where does the new code hook in?

**For both:**
- **Cross-repo reach.** If the change touches anything in `scripts/openit-plugin/`, note both the dev path (`openit-app/scripts/openit-plugin/`) and the prod path (`/web/packages/app/public/openit-plugin/`). If the change calls a new endpoint, identify which host (`app-api.<env>`, `skills*.pinkfish.ai`, `proxy*.pinkfish.ai`) and which header (`Authorization: Bearer` vs `Auth-Token: Bearer`). If a generated client (`src/api/generated/firebase-helpers/`) needs regeneration, say so explicitly.
- **What already exists?** Don't reinvent — find reusable code, helpers, hooks. `makeSkillsFetch` is the only authenticated-fetch path; check it before adding a new one.
- **Existing tests.** What's already covered for this area? `vitest run` against the relevant `*.test.ts` to see the current invariants.
- **State + persistence.** If the change touches anything synced (KB / filestore / datastore / agents / workflows), trace through `pushAll` + the per-entity `syncEngine` + the manifest. The `pulled_at_mtime_ms` / `conflict_remote_version` invariants are easy to break.

#### Architecture diagram (when warranted)

A mermaid diagram earns its place when the change involves multiple components interacting, a state-flow that's hard in prose, or a before/after sync-direction comparison. Use `sequenceDiagram` for request/response flows, `flowchart` for branching logic. Keep diagrams focused — they should clarify, not pad.

### 2. Proposed solution

Cross-reference your proposed logic against the ticket's success criteria. If the brief mentions multiple conditions ("either X or Y"), make sure the plan captures the full logic — missing an OR/AND condition here causes rework later.

- **Approach.** High-level strategy. *What* and *why* given what investigation found.
- **Files to modify** — table:

  | File | Change |
  | --- | --- |
  | `src/lib/foo.ts` | One-line description of what changes and why |

- **Unit tests.** Per changed file, what tests need to be added. If a file gets no test, state why (e.g. "pure UI wiring, exercised by manual scenario X"). Don't blanket-write "no tests required."
- **Manual scenarios.** What concrete user flows you'll click through to verify the change end-to-end. Include the cross-repo plugin case if scripts changed (test from `~/OpenIT/<orgId>/.claude/scripts/`, not just from the dev path).
- **Cross-repo plugin steps** (if applicable). The plan must explicitly list:
  1. Dev edit in `openit-app/scripts/openit-plugin/<file>`.
  2. Test by copying to `~/OpenIT/<orgId>/.claude/scripts/<file>`.
  3. At merge: copy into `/web/packages/app/public/openit-plugin/`, bump `manifest.json` version, push.

### 3. Implementation checklist

Last section of the plan. Steps with empty checkboxes, grouped logically. Each item describes *what* to build and *why* the step matters — not every function or file. Glanceable. Example shape:

```markdown
## Implementation checklist

### Step 1 — Foundation

Reason for grouping the next bullets together.

- [ ] Add new field to `cloud.json` schema (`src-tauri/src/project.rs`)
- [ ] Wire reader/writer through Tauri command surface
- [ ] Unit tests for the schema parser

### Step 2 — Behavior

- [ ] …

### Step 3 — Manual sign-off

- [ ] Click-through scenario 1
- [ ] Click-through scenario 2
```

Keep the checklist as short as possible. **More is not better.**

### 4. Stop. Ask the human to review and approve before stage 03.

This is a hard stop. Don't roll into testing on your own.

### 5. Update the Linear ticket

Comment on the ticket with a brief "plan written, here's the shape" summary + link to the plan file in the repo. Keep it punchy — the plan is the contract, the comment is the headline.

---

## Phase transition checklist (before moving to stage 03)

- [ ] Plan file created in `auto-dev/plans/` with the required header
- [ ] Investigation cites real files + line numbers (not vibes)
- [ ] Files-to-modify table is complete; cross-repo `/web` mirror noted if plugin scripts changed
- [ ] Unit-test list per file + manual scenarios listed
- [ ] Implementation checklist is high-level, not a TODO dump
- [ ] Human reviewed and approved the plan
- [ ] Linear ticket has a summary comment

## A note on minimalism

The implementation plan is the place where ambition gets pruned. The brief says *what* and *why*; the plan says *how*, and "how" should be the smallest concrete change that satisfies the brief. If the plan is growing past two screens of checklist, ask whether some of it should be a follow-up ticket instead. Keep the plan as short as possible. **More is not better.**
