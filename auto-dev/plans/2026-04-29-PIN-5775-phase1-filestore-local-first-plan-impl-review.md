# PIN-5775: Phase 1 — Filestore local-first sync — Implementation review

**Date:** 2026-04-29
**Parent plan:** `2026-04-29-PIN-5775-phase1-filestore-local-first-plan.md`
**Branch:** `ben/pin-5775-phase1-filestore-local-first`
**Reviewer:** self (autonomous Phase 1 run while engineer was unavailable)

---

## Verdict

**Status:** Pass with caveats.

Code-level scope of the plan is implemented and unit-tested. All three connect paths in `App.tsx` are rewired around the new `cloud.json` bind marker; the filestore engine is filtered to `openit-*` and renames its single default to `openit-library`; the frontend display-strips the prefix. 80 cargo tests, 93 vitest tests, tsc clean.

The caveats are real but flagged in the brief and the plan, not new risks:

1. **No manual click-through verification.** Implementation was done while the engineer was offline; `npm run tauri dev` scenarios MS-1 through MS-7 in the plan must be exercised before merge. Unit + type tests catch logic-level errors but not behaviour drift in the actual connect / sync flow.
2. **V1 cloud-bound users get re-bound to `~/OpenIT/local/` on next launch.** Their existing data under `~/OpenIT/<oldOrgId>/` stays on disk but is no longer auto-opened. The brief explicitly accepted this orphaning ("Migrating legacy `~/OpenIT/<orgId>/` folders. Those become orphans.") and the V1 deployment surface is small.

---

## Findings

### 1. `lastSyncAt` is never updated after a successful pull

**Severity:** Low
**Error type:** omission

The plan called for `cloud.json.lastSyncAt` to refresh on each engine's reconciler success. The Tauri command `project_update_last_sync_at` is implemented and tested, but no caller invokes it.

**Impact:** `lastSyncAt` stays `null` forever. There is no current UI surface that reads it, so this is purely informational data lost. SC list is not blocked.

**Disposition:** Deliberately deferred — wiring it into filestore's poll callback would write to disk every 60s, and there's no consumer yet. Phase 2 (or whichever phase first surfaces "Last synced X ago" in the UI) is the right place to add it. Documented here so it isn't forgotten.

### 2. V1 → Phase 1 silent re-bind

**Severity:** Medium (user impact, not correctness)
**Error type:** omission

A user with valid V1 creds and `lastRepo = "~/OpenIT/<oldOrgId>/"` will, on next launch, fall through the cloud-relaunch branch's "no matching cloud.json" path and land in the first-run-with-creds branch, which re-binds them to `~/OpenIT/local/`. Their old folder's contents are preserved on disk but are no longer the active project.

**Impact:** Mildly surprising for V1 testers. Their work is technically still recoverable (`~/OpenIT/<oldOrgId>/` → manually rsync into `~/OpenIT/local/`), but no UX guides them through it.

**Disposition:** Accepted per the brief's explicit "those become orphans" stance. PR description will call this out for any V1 tester reviewing.

### 3. `projectBindToCloud` failure is non-fatal everywhere it's called

**Severity:** Low
**Error type:** omission (intentional)

In all three `App.tsx` call sites, a bind failure (most likely "folder already bound to a different org") is caught and logged — sync runs against the existing binding rather than the new one. There's no UI surface for "your folder is bound elsewhere; what do you want to do?"

**Disposition:** The brief deferred the first-bind confirm dialog and the "switching cloud orgs" UX to later phases. Logging-and-continuing is the conservative behaviour for Phase 1 — better than blocking the user with no resolution path. Document in PR description.

### 4. `projectBootstrap` still takes `orgName` and `orgId`, even though both are now always `LOCAL_ORG_NAME` / `LOCAL_ORG_ID`

**Severity:** Low
**Error type:** systematic (slightly)

After Phase 1, every cloud-path caller passes the same hardcoded local org constants to `projectBootstrap`. The function's `org_id`-derived path logic is effectively dormant for cloud users — the org parameter is now vestigial. A future phase can either (a) split into `project_ensure_local_layout()` + a separate path resolver, or (b) refactor the signature to accept an explicit folder.

**Disposition:** Out of scope for Phase 1. Cleaning up the signature is a refactor that touches the local-only path too, and warrants its own PR.

### 5. Defensive-programming audit — clean

Walked the diff:

- **HTTP calls:** No new outbound HTTP calls in this PR. The existing `listFilestoreCollections` / create-collection paths already check `response.ok` and handle 409s — untouched.
- **Header consistency:** N/A — no new fetch sites.
- **Null safety:** `projectGetCloudBinding` returns `null` for unbound; `App.tsx` uses `binding && binding.orgId === creds.orgId` correctly.
- **Error paths:** `projectBindToCloud` errors on different-org rebind. All three call sites catch + log non-fatal. Comment at each site explains the conservative-behaviour choice.
- **Fallback values:** `cloud.json` parse failure surfaces as an error (not a silent default). `read_cloud_binding_from_disk` distinguishes "file missing" (Ok(None)) from "file present but unparseable" (Err) — important for downstream callers that need to know whether the folder was ever bound.
- **Third-party API assumptions:** N/A.
- **Cross-call-site impact:** searched for all callers of `projectBootstrap` and `getDefaultFilestores`; updated the cloud paths and left the local-only path intact. The old V1 export `openit-docs-<orgId>` had no callers outside `getDefaultFilestores` — confirmed via grep.

### 6. Test-quality audit — clean

- **Outcome assertions:** the cloud-binding tests assert on file contents (round-trip JSON), the filestore tests assert on resolved collection sets, not on internal flags.
- **No error guards in tests.** Each test either asserts the expected outcome or explicitly checks an error-expected case (e.g. `bind_rejects_different_org_id`). No `try { ... } catch { return }` patterns.
- **Edge cases:** empty input, missing file, V1 legacy duplicates, no-prefix collections, prefix-only-name (degenerate), and idempotency are all covered.
- **No tests on the wiring in App.tsx.** `App.tsx` changes are exercised via the manual scenarios — vitest mocking the Tauri command surface for `App.tsx` would mostly assert on the mock, not the behaviour. PR description flags MS-1 through MS-7 as required pre-merge.

### 7. Diff hygiene — clean

`git diff main --stat`:

```
auto-dev/plans/2026-04-29-PIN-5775-phase1-filestore-local-first-plan.md  | 263 +++++++
auto-dev/plans/archive/2026-04-28-PIN-5775-v2-sync-DRAFT.md              | 245 ++++++ (renamed)
src-tauri/src/lib.rs                                                     |   3 +
src-tauri/src/project.rs                                                 | 224 +++++
src/App.tsx                                                              |  68 ++--
src/lib/api.ts                                                           |  47 ++
src/lib/filestoreSync.ts                                                 |  37 ++-
src/lib/filestoreSync.test.ts                                            | 117 ++++
src/shell/Shell.tsx                                                      |   6 +-
```

No out-of-scope changes. No leftover scaffolding (`TODO`, `FIXME`, `console.log` debug). No commented-out code. `cargo fmt` and `tsc` clean.

---

## Notes

- **Scope reviewed:** every file touched by the three commits on this branch.
- **Not validated:** the actual end-to-end behaviour of the connect / sync flow in a running Tauri app. MS-1 through MS-7 in the plan are the gating manual scenarios.
- **`LEARNINGS & CHANGES`** in the plan was not appended — implementation matched the plan closely, with the deliberate deferral of `lastSyncAt` wiring being the only meaningful divergence (captured as Finding #1 above instead of a plan amendment).

---

## Recommended next step

Open the PR (draft, since manual scenarios are pending), trigger BugBot, and surface the three deferred items in the PR description so reviewers (and the engineer when they're back) see them up front:

1. Manual scenarios MS-1 through MS-7 still need to be exercised before merge.
2. `lastSyncAt` is implemented but not wired (Finding #1).
3. V1 → Phase 1 re-bind is silent (Finding #2).

If BugBot surfaces correctness issues, fix them in commits named `Re: <BugBot finding title>` per `auto-dev/06-PR.md`. If the only remaining findings are Low-severity stylistic / preference flags after one or two iterations, reply with rationale, resolve, and pause for the engineer's manual sign-off before merge.
