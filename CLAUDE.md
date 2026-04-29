---
name: OpenIT
description: IT operations and service management plugin for Claude Code. Manage tickets, provision employees, query systems, and automate workflows.
---

Project context, tech stack, repo cheatsheet, auth model, plugin-script dev loop, and the full 6-stage dev process all live in:

- **`auto-dev/00-autodev-overview.md`** — read this first. Covers what OpenIT is, what syncs on connect, the four sibling reference repos (`/web`, `/platform`, `/firebase-helpers`, `/pinkfish-connections`), the one-runtime-token auth model, build/dev instructions, the cross-repo plugin-script loop, and the stage table.

## Dev process — 6 stages

Each stage produces a concrete artifact and **does not advance silently** — engineer approval gates every transition. Skip the ceremony for trivial fixes (one-line bug, doc typo); use it for anything that benefits from being reviewed against an explicit plan.

Read each stage file when you're at that step, not before:

- **`auto-dev/01-brief.md`** — enrich a sparse Linear ticket into Problem / Desired Outcome / Scope / Success Criteria.
- **`auto-dev/02-impl.plan.md`** — produce `auto-dev/plans/YYYY-MM-DD-PIN-####-short-name.md` with files-to-modify table, unit-test list, manual scenarios, and an implementation checklist.
- **`auto-dev/03-implementation.md`** — execute the plan on a feature branch; mark off the checklist; append `LEARNINGS & CHANGES` where the implementation diverged.
- **`auto-dev/04-testing.md`** — full vitest + cargo test pass plus manual click-through; Linear comment summarizing what was tested.
- **`auto-dev/05-impl-review.md`** — self-review against the plan; output `auto-dev/plans/<plan-filename>-impl-review.md` with verdict + findings (and fix sub-plans if any) before BugBot sees it.
- **`auto-dev/06-PR.md`** — open the PR with a Conventional-Commits title, run the `@cursor review` BugBot loop until only Low-severity findings remain, merge. Mirror plugin-script changes into `/web` at merge time per the cross-repo loop in `00-autodev-overview.md`.

## Releases

- **`auto-dev/release-runbook.md`** — how to cut a public macOS release and what to do when CI breaks.

## Active plans

Implementation plans live in `auto-dev/plans/`. Current focus is the PIN-5775 phase 1 filestore local-first work:

- `auto-dev/plans/2026-04-29-PIN-5775-phase1-filestore-local-first-plan.md` — the plan
- `auto-dev/plans/2026-04-29-PIN-5775-phase1-filestore-local-first-plan-impl-review.md` — stage-05 review output
- `auto-dev/plans/2026-04-29-PIN-5775-phase1-manual-testing-checklist.md` — stage-04 manual scenarios
- `auto-dev/plans/2026-04-29-PIN-5775-architecture-fix-summary.md` — architecture notes

Sync-engine architecture and channel strategy: `auto-dev/plans/2026-04-25-bidirectional-sync-plan.md`.
