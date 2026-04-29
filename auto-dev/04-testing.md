# Stage 03 — Testing

Write the tests, run them, run the manual scenarios, iterate until clean. Then ship.

Tests are written **during this stage** for the changes you made in the implementation. The plan from stage 02 should already enumerate which tests need to exist (per file) and which manual scenarios you'll click through.

---

## What to run

OpenIT is a Tauri app: TypeScript frontend + Rust backend + Node plugin scripts. Three layers, three test surfaces.

### TypeScript unit + integration tests (vitest)

Most of the code is here — sync engines, adapters, `pendingChanges`, fetch adapter, conflict reconciler, etc.

```bash
cd /Users/benrigby/Documents/GitHub/openit-app
npx vitest run
```

Run targeted tests during iteration:

```bash
npx vitest run src/lib/pendingChanges.test.ts
npx vitest run src/lib/syncEngine.test.ts
```

**Tests must pass cleanly before opening the PR.** Skipping a failing test or weakening an assertion to make it green is not acceptable — if the test caught a real regression, the implementation is wrong; if the expectation is now wrong, update the test deliberately and explain why in the commit.

### Plugin script tests

Plugin scripts under `scripts/openit-plugin/` have `*.test.ts` siblings (vitest). They exercise the script's logic in isolation.

```bash
npx vitest run scripts/openit-plugin/sync-resolve-conflict.test.ts
```

For end-to-end verification of a plugin script, copy it into a real test org and run it:

```bash
cp scripts/openit-plugin/<script>.mjs ~/OpenIT/<orgId>/.claude/scripts/<script>.mjs
cd ~/OpenIT/<orgId>
node .claude/scripts/<script>.mjs <args>
```

(Ben's working test org is `~/OpenIT/653713545258/`.)

**Don't reconnect OpenIT mid-dev** — the manifest sync would overwrite your local copy with whatever's currently in `/web` (which is older than your dev edit).

### Rust tests (cargo)

For Tauri command surface, git ops, project bootstrap, anything in `src-tauri/`:

```bash
cd src-tauri && cargo test
```

### Type-check + lint

Before opening a PR (and ideally before each commit):

```bash
npx tsc --noEmit
```

If the repo has biome configured, run it too. Otherwise the TS compiler is the primary lint gate.

---

## Manual scenarios

OpenIT is a UI-heavy app. **Tests-only doesn't qualify as completing this stage** — every plan must include manual scenarios that exercise the change end-to-end through the running app.

### Launch dev

```bash
npm run tauri dev
```

This opens the Tauri window with hot-reload for the frontend. Rust changes require a relaunch. Watch the terminal for stderr — Tauri command errors and unhandled promise rejections show up there.

### What to verify

For every changed feature:

1. **Golden path** — exercise the primary flow from the user's perspective. Does it produce the expected outcome?
2. **Edge cases** the plan calls out — empty state, network error, conflicting state, large data set, permission denied, etc.
3. **Regression check on adjacent features** — if you touched `pushAll`, click through KB sync AND filestore sync AND datastore sync, not just the one you changed.
4. **Cross-repo plugin path** (when scripts changed) — copy the script into your test org, reconnect or restart the app, verify the new behavior is what runs (not the bundled-but-stale version).
5. **Sync invariants** (when sync engines changed) — check `~/OpenIT/<orgId>/.openit/manifest*.json` after each scenario to confirm `pulled_at_mtime_ms` and `conflict_remote_version` are written correctly.

### Discovering bugs outside scope

While clicking through, you may find a bug related to but outside the ticket's scope. When this happens:

1. **Flag it explicitly** to the engineer — what you saw, where the broken code is, why it's not in scope.
2. **Get explicit approval** before fixing it in this branch. The engineer may want a separate ticket.
3. If approved → fix in this branch and note the additional fix in the Linear comment.
4. If not approved → file a new Linear ticket and move on.

Don't silently absorb unscoped bugs. It inflates the diff, risks new issues, and makes the PR harder to review.

---

## Cross-repo plugin: full loop check

If the change includes any file under `scripts/openit-plugin/`, the test loop is **not done** until you've verified:

1. The dev path works (vitest passes).
2. The script copies correctly into `~/OpenIT/<orgId>/.claude/scripts/<file>` and runs end-to-end against a real org.
3. The mirror plan (stage 02 Step 3 in the implementation checklist) is up-to-date — at PR-merge time, the script also lands in `/web/packages/app/public/openit-plugin/scripts/` with a manifest version bump.

The mirror itself happens in stage 04 (PR). But verify in stage 03 that the dev script is the version you actually want to ship.

---

## Iterate

For every fix:

1. Make the change
2. `npx vitest run` (targeted, then full)
3. `npx tsc --noEmit`
4. Re-run the affected manual scenario
5. Commit with a Conventional-Commits message scoped to the ticket — `<type>(PIN-XXXX): <description>`

If a test fails:
- Read the error. Don't assume it's flaky — flaky tests in this repo are vanishingly rare.
- Determine root cause: is the test wrong, or is the implementation wrong?
- Fix the right one. Don't weaken the assertion to make a real regression go away.

---

## Update the Linear ticket

Add a comment summarizing what was tested:
- Unit/integration test counts (e.g. "50 vitest, 12 cargo passing")
- Manual scenarios clicked through (one-line each)
- Anything you discovered out-of-scope and how it was triaged

Keep the comment punchy. The plan + the PR diff are the contracts; the comment is the headline.

---

## Phase transition checklist (before moving to stage 04)

- [ ] All vitest tests pass (`npx vitest run`)
- [ ] All cargo tests pass (`cd src-tauri && cargo test`)
- [ ] `npx tsc --noEmit` clean
- [ ] Every manual scenario from the plan was clicked through in `npm run tauri dev`
- [ ] If plugin scripts changed — verified end-to-end in a real test org's `.claude/scripts/`
- [ ] Out-of-scope discoveries flagged to the engineer (filed or approved)
- [ ] Linear ticket has a testing-summary comment
- [ ] Engineer approves moving to PR

A passing test suite is necessary, not sufficient. The manual scenarios are the real gate.
