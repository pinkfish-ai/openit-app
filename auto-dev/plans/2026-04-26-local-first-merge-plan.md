# Local-first stack — merge plan

How to verify and land the 5 stacked PRs that ship local-first end-to-end. Written 2026-04-27 while the stack is still all-OPEN — pin this doc on a screen during merge so the order doesn't drift.

## The stack

| PR | Title | Base | Owns |
|---|---|---|---|
| #24 | Phase 1 — plugin reframe | main | Plugin CLAUDE.md / triage skill / answer-ticket rewrites |
| #25 | Phase 2 — bundle plugin | #24 | Tauri bundling, bundled-fallback sync, schemas, agent template |
| #26 | Phase 3a — local bootstrap | #25 | No-creds entry path, connection-state plumbing, push graceful-degrade |
| #27 | Phase 4 — incoming banner | #26 | Incoming-ticket detection + banner + multi-shape `/triage` |
| #28 | Phase 5 — intake form | #27 | Localhost axum HTTP server + URL pill |
| #29 | Tests catchup + BugBot doc | #28 | Test backfill across phases 2-5, fs_tree fix, doc edit |

PR #23 (the planning docs) is independent — base `main`, lands whenever.

## Pre-merge checklist (do once, on the tip)

The tip of the stack — `feat/local-first-tests-catchup` (PR #29) — is the only branch that contains all 5 phases integrated. Everything below should pass there before we start landing.

- [ ] **All BugBot reviews show only Low-severity findings (or are clean).** Reply or fix-and-resolve every Low thread per `auto-dev/04-PR.md`.
- [ ] **Test suites green:**
  - `cd src-tauri && cargo test --lib` → all passing (currently 42)
  - `npm test` → all passing (currently 51)
  - `npx tsc --noEmit` → clean for project files (generated firebase-helpers warnings are pre-existing)
- [ ] **End-to-end smoke (manual):**
  ```
  rm -rf ~/OpenIT/local
  # clear keychain entries for ai.pinkfish.openit (Keychain Access app)
  git checkout feat/local-first-tests-catchup
  npm run tauri:dev
  ```
  Verify in order:
  - [ ] App boots straight to chat (no onboarding, no OAuth modal).
  - [ ] `~/OpenIT/local/` exists with `databases/openit-tickets-local/_schema.json`, `databases/openit-people-local/_schema.json`, `agents/openit-triage-local.json` (slug substituted), `.claude/skills/triage/SKILL.md`, etc.
  - [ ] Header shows the intake URL pill — click copies the URL.
  - [ ] Open the URL in a browser → form renders → submit a ticket.
  - [ ] IncomingTicketBanner appears within ~500ms.
  - [ ] Click "Triage in Claude" → Claude reads the row, doesn't create a duplicate, runs the flow, status leaves `incoming`. Banner clears.
  - [ ] `VITE_DEV_LOCAL_ONLY=true npm run tauri:dev` with stored creds present → behaves identically to the no-creds path (sync engines stay dormant).
- [ ] **Cloud regression spot-check:** with real creds, an existing cloud-keyed project (e.g. `~/OpenIT/653713545258/`) still relaunches into cloud mode and pulls.

If any of those fail, fix on the tip branch first, then start the merge.

## Merge order

Strictly bottom-up. Each PR's diff naturally collapses to its own contribution once its parent merges, so no manual rebases are needed unless GitHub flags conflicts.

1. **#24** → main. Plugin source files only — low risk, no engine changes.
2. **#25** → main. Once #24 is in, #25's diff shrinks to just the bundling + Rust commands + TS routing.
3. **#26** → main.
4. **#27** → main.
5. **#28** → main.
6. **#29** → main.

After each merge:
- Pull main locally (`git checkout main && git pull`).
- Refresh the next PR in the GitHub UI — confirm it now targets `main` cleanly with the expected diff size.
- If GitHub reports a merge conflict, rebase the next branch on `main` (`git checkout feat/local-first-phase-X && git rebase main`) and force-push.

## Watch-outs

- **Don't squash-merge into an earlier PR's branch.** Always merge each PR into `main`. Squashing into a stack member reshuffles SHAs and breaks downstream rebases.
- **PR #29 holds tests for #25-#28.** If we landed #25-#28 without #29, those phases would briefly live in `main` without their test coverage. Acceptable risk during the merge window (~30 min) but worth knowing. If we want strict per-PR test coverage, redistribute #29's tests into the phase PRs first (~30 min rebase work).
- **The fs_tree dotdir test fix** lives in #29 (commit `d3b72ae`). Until #29 lands, `cargo test --lib` on `main` will fail on `fs_tree::tests::fs_list_keeps_dot_claude_but_hides_other_dot_dirs` — the test was already broken on main before we started; #28's slugify dead-test removal exposed it. If anything else lands on main between #28 and #29, that branch will see the failing test.
- **Don't force-push main.** If something goes sideways mid-merge, prefer a forward-fix PR over rewinding history.

## After everything is in

- [ ] Verify `feat/local-first-tests-catchup` matches `main`, then delete the 5 feature branches (locally + remote).
- [ ] PR #23 (the planning docs) is independent of this stack — merge whenever.
- [ ] Bump the manifest in `/web` if the cloud-served plugin should match the bundled one.
- [ ] Phase 3b (UX polish) and Phase 6 (Connect-to-Pinkfish) become the next stack — see the tracker on `docs/local-first-plan` for the open scope.
