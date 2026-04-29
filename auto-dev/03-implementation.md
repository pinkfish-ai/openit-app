# Stage 03 — Implementation

Execute the plan. Code + unit tests live here; full testing pass + manual scenarios live in stage 04.

You're working from the plan written in stage 02 and approved by the engineer. The plan's checklist is the contract.

---

## Setup

### Branch

Work on a feature branch off `main`:

```bash
cd /Users/benrigby/Documents/GitHub/openit-app
git checkout -b ben/pin-XXXX-short-name
```

If you're extending an existing PR, check that branch out instead and note it in the plan header (`Branch: existing — building on PR #YY`).

### Test loop

You'll be running these constantly during implementation. Pin two terminal panes:

```bash
# Pane 1 — fast vitest watch on whatever file you're touching
npx vitest src/lib/<file>.test.ts

# Pane 2 — Tauri dev for occasional UI smoke
npm run tauri dev
```

---

## Implementation process

1. **Mark plan checklist as you go.** As each item completes, change `- [ ]` to `- [x]` in the plan file *immediately* — not in batches at the end. The plan doubles as a progress tracker; keeping it accurate matters when you hand off mid-session or come back the next morning.

2. **Document learnings in the plan.** When you discover something the plan didn't anticipate (a hidden invariant, a better approach, a structural surprise), add it to a `## LEARNINGS & CHANGES` section at the bottom of the plan file. This is the audit trail that lets stage 05 (impl review) cross-check the plan against the diff.

3. **Call-site audit.** When modifying a function signature, adding a field to a shared struct, or extending an interface, `grep` all callers and verify each one works with the change. Don't rely on the TS compiler alone — `any` typing or duck-typed callers can hide silent failures at runtime.

4. **Literal sweep when introducing a constant.** When you add an exported named constant for a previously-literal value (e.g. `OPENIT_PREFIX = "openit-"`), grep the whole package for the literal and replace every occurrence. An exported constant with zero references is dead code and BugBot will flag it.

5. **Write unit tests as you go.** For each new function, write at least one failure-mode test (missing config, nil dependency, empty response, network error). Happy-path-only tests leave error paths unvalidated — and the error paths are where bugs hide.

   - **Never add error guards that mask test failures.** Tests must fail when something is broken — never `catch` errors and `return` early, never check for error strings and skip assertions, never log a warning and move on. A test that silently passes when the system is broken is worse than no test.

6. **Cross-repo plugin work** — if the change touches `scripts/openit-plugin/`:
   - Edit in `openit-app/scripts/openit-plugin/<file>` (this is the dev source of truth)
   - Copy to your test org for end-to-end check: `cp scripts/openit-plugin/<file> ~/OpenIT/<orgId>/.claude/scripts/<file>`
   - **Don't reconnect the app mid-dev** — the manifest sync would overwrite your local copy with whatever's in `/web` (which is older).
   - The `/web` mirror happens at PR-merge time (stage 06), not now.

7. **API endpoint changes.** If you're calling a new endpoint or a new shape, verify the host + header + base path against `auto-dev/00-autodev-overview.md` § "Auth: one runtime token":
   - `app-api.<env>` → `Authorization: Bearer`
   - `skills*.pinkfish.ai` / `proxy*.pinkfish.ai` → `Auth-Token: Bearer`
   - The only authenticated-fetch path is `makeSkillsFetch` in `src/api/fetchAdapter.ts`. Don't add a parallel path.
   - If the endpoint is auto-generated under `src/api/generated/firebase-helpers/`, regenerate from `/firebase-helpers` rather than hand-editing.

8. **Remove debug logging.** Before each commit:
   ```bash
   git diff --cached | grep -E "console\.log|console\.debug|fmt\.Println|dbg!"
   ```
   If anything appears, remove it. `console.error` for genuine error paths is fine; `console.log("here")` is not.

9. **Verify no local config in diff.**
   ```bash
   git diff --cached -- '*.env*' 'src-tauri/.cargo/config.toml'
   ```
   Local-only config (your dev keychain cert path, env overrides, scratch tokens) must not ship.

10. **Pre-commit quality checks** (mandatory):

    ```bash
    npx tsc --noEmit
    ```

    For Rust changes:

    ```bash
    cd src-tauri && cargo build
    ```

    Plus `npx vitest run` against the files you touched. Fix every error before committing — CI will fail if you skip this.

11. **Commit.** Use Conventional-Commits format from the start, even on the feature branch. The PR squash-merge will use the latest commit message, but a clean per-step history is invaluable when bisecting later.

    ```
    feat(PIN-XXXX): <Description>
    fix(PIN-XXXX): <Description>
    refactor(PIN-XXXX): <Description>
    ```

    Description starts uppercase. Each commit should leave the repo in a tested, type-checking, runnable state.

---

## Handoff (mid-session interruption)

If you need to hand off work mid-stage (context limit, session ended), drop a handoff doc at `auto-dev/handoffs/<ticket-id>-handoff.md`:

- **Linear ticket** — URL
- **Branch** — branch name
- **Stage** — "03 — Implementation, in progress"
- **What's done** — commits already pushed, plan items checked off
- **What's pending** — exact next steps with file paths + line numbers
- **Known issues** — any debug logs left in that MUST be removed, half-finished refactors, etc.

This lets the next session pick up cold without re-deriving state.

---

## Update the Linear ticket

Add a brief comment when implementation is done:
- One-line summary of what was built
- Link to the branch
- Anything that diverged from the plan (and why) — should mirror the `LEARNINGS & CHANGES` section

---

## Phase transition checklist (before moving to stage 04)

- [ ] All plan checklist items marked `- [x]`
- [ ] Unit tests written for every new function (including failure modes)
- [ ] No debug `console.log` / `dbg!` / `fmt.Println` left in the diff
- [ ] No local config (`.env`, dev keychain config) staged
- [ ] `npx tsc --noEmit` clean
- [ ] `cargo build` clean (if Rust changed)
- [ ] `npx vitest run` passes against touched files
- [ ] Cross-repo plugin work mirrored into test org and verified (if scripts changed)
- [ ] Branch pushed
- [ ] Plan's `LEARNINGS & CHANGES` section captures any divergence from the plan
- [ ] Linear ticket has implementation-summary comment

Stage 04 is where the *full* test pass and manual click-through happen. Stage 03 ends when the code compiles, units pass, and the diff is clean.
