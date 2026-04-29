# Stage 05 — Implementation review

Self-review the completed implementation against the plan. Catch what you can yourself before BugBot catches it for you.

This stage produces a written review document. Don't bury the review in chat or in PR comments — write it down in `plans/`.

---

## Where the review lives

Same directory as the plan, with `-impl-review` appended:

```
auto-dev/plans/<plan-filename-without-.md>-impl-review.md
```

Example:
- Plan: `2026-04-28-PIN-5775-v2-sync-local-as-source-of-truth.md`
- Review: `2026-04-28-PIN-5775-v2-sync-local-as-source-of-truth-impl-review.md`

---

## Review document structure

```markdown
# PIN-XXXX: <Short title> — Implementation review

**Date:** YYYY-MM-DD
**Parent plan:** `<plan-filename>.md`
**Branch:** ben/pin-XXXX-short-name

---

## Verdict

**Status:** Pass | Changes requested

<1–2 paragraph summary: does this satisfy the plan? Are there residual risks? Anything still missing?>

---

## Findings

### 1. <Short finding title>

**Severity:** High | Medium | Low
**Error type:** omission | systematic | incoherent

<What's wrong, why it matters, what part of the implementation or test is inconsistent with the plan or success criteria.>

<Repeat for each finding, ordered by severity.>

If there are no findings, say so explicitly and add a short note about residual risks or testing gaps.

---

## Notes

- <Scope of the review — what was looked at, what wasn't>
- <Anything deliberately deferred or out of scope>

---

## Recommended next step

<Usually: open a fix sub-plan and re-run stage 03/04 against it, OR proceed to stage 06 (PR) if the review passes.>
```

---

## Review process

### 1. Read the diff against the plan

```bash
git diff main...HEAD
```

Read every hunk. Compare against the plan's "Files to modify" table, "Unit tests" list, and implementation checklist. Anything in the diff that's NOT in the plan is suspect — either the plan was incomplete (update LEARNINGS) or the change is out of scope (consider reverting).

### 2. Check against success criteria

Re-read the brief from stage 01. For every "When [condition], [expected behavior]" criterion, identify the test or manual scenario that verifies it. If a criterion has no corresponding test or scenario, that's a finding.

### 3. Defensive-programming audit

For every new or modified function in the diff, verify:

- **HTTP calls:** every outbound HTTP call checks `response.ok` (or status code) before reading the body. No silent 4xx/5xx consumption. Look for `await fetch(...).then(r => r.json())` patterns — they swallow non-2xx responses as JSON parse errors.
- **Header consistency:** every service-to-service call uses `makeSkillsFetch` with the right auth mode (`bearer` vs `auth-token`). No raw `fetch(url, { headers: { Authorization: ... } })` in adapters — that path silently bypasses retry, error normalization, and creds refresh.
- **Null/undefined safety:** every new call to a potentially-undefined dependency uses the same guard pattern as existing callers. Optional-chain (`?.`) and default-value patterns must match the file's existing style.
- **Error paths:** for multi-step flows ("call A to get X, then call B with X"), verify what happens when A succeeds but B fails. The user should see a meaningful error, not a partial-success indicator with stale data.
- **Fallback values:** for fields sourced from external systems (e.g., a manifest field that may be missing), verify a fallback exists if the primary field is empty.
- **Third-party API assumptions:** for every new call to an external API, verify the endpoint actually supports the parameters being passed. Check the official docs — don't assume based on how a sibling endpoint works. Silently-ignored parameters cause data correctness bugs that tests won't catch.

### 4. Test quality audit

- **No error guards in tests.** Verify tests don't contain guards that catch errors and silently return early. A test that logs a warning and `return`s when the system is broken is worse than no test — it makes a broken deployment look like a passing test.
- **Outcome assertions, not just mechanism assertions.** A good test verifies the user-facing outcome ("after sync, the cloud has these N items"), not just internal flags ("`pushedFlag === true`"). Internal-state-only tests are easy to write but miss the actual regression class they should be catching.
- **Edge cases per plan.** The plan should list specific edge cases per file. If any are missing tests, that's a finding.

### 5. Diff hygiene

- **Minimal diff.** Changes should not touch files outside the feature's scope. Tangential cleanups belong in separate PRs. If you "while I was here, fixed that other thing too" — flag it as a finding and either revert the unrelated change or open a separate ticket.
- **No dead code.** Every new export must have a caller. Every new constant must have a use site. Use `grep` to verify, don't just assume the compiler will catch it (TypeScript happily ignores unused exports).
- **No leftover scaffolding.** Search the diff for `TODO`, `FIXME`, `XXX`, `console.log`, `console.debug`, `dbg!`, commented-out code blocks. Any of these in a "ready to PR" state is a finding.
- **Simplicity.** If the codebase already has a pattern for the behavior, use it rather than introducing a novel alternative. A second pattern-of-the-week is harder to maintain than reuse.

### 6. Plan consistency

If the implementation diverged from the plan in any meaningful way:

- **Inconsistent with good reason** → add a note to the plan's `LEARNINGS & CHANGES` section explaining what changed and why. The plan stays accurate as the historical contract.
- **Inconsistent and needs fixing** → write a fix sub-plan in the same directory: `<plan-filename>-fix-1.md`, then loop back to stage 03 against that sub-plan.

#### Fix sub-plan template

```markdown
# Fix: <Short title>

**Date:** YYYY-MM-DD
**Parent plan:** `<plan-filename>.md`

---

## Problem

<Describe the problem clearly.>

**Error type:** omission | systematic | incoherent

- **Omission** — Something missing (test, edge case, requirement)
- **Systematic** — Wrong pattern, duplication, wrong abstraction
- **Incoherent** — Contradictory or inconsistent logic

---

## Fix

<Checklist + implementation details>

---

## Outcome

*Complete this section after the fix is implemented and impl-review passes.*

- [ ] Passed impl-review on first try (no fix-2 needed)
- [ ] Required additional fix sub-plan (fix-2 or later)
```

When fix-1 spawns fix-2, return to fix-1's outcome section and check the second box. This is the audit trail.

### 7. Final type-check + lint

Last sweep before declaring impl-review pass:

```bash
npx tsc --noEmit
npx vitest run
cd src-tauri && cargo build
```

Plus biome / prettier if configured. Anything red is a finding.

---

## Update the Linear ticket

Comment with:
- Verdict (Pass / Changes requested)
- One-line summary of findings (count + severity breakdown)
- Link to the impl-review document in the repo

If verdict is "Changes requested" and you've spawned a fix sub-plan, link to that too.

---

## Phase transition checklist (before moving to stage 06 — PR)

- [ ] Impl-review document written in `auto-dev/plans/<plan-filename>-impl-review.md`
- [ ] Verdict is **Pass**, OR all findings have been addressed via a fix sub-plan that itself passed review
- [ ] LEARNINGS & CHANGES section in the plan reflects every meaningful divergence
- [ ] Final type-check + tests + cargo build are clean
- [ ] Diff is minimal — no out-of-scope changes
- [ ] Linear ticket has impl-review summary comment
- [ ] Engineer approval to proceed to PR

Verdict "Pass" is the gate to opening the PR. If you can't honestly say it passes, don't.
