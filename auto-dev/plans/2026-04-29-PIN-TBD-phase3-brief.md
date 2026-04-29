# PIN-TBD: Phase 3 — Complete V2 local-first (agents + workflows writeable; datastore consolidation) — Brief (draft)

**Ticket:** [TBD — new sibling of PIN-5775, to be created in Linear]
**Date:** 2026-04-29
**Repo:** `openit-app` (primary)
**Predecessors:**
  - Phase 1 — `2026-04-29-PIN-5775-phase1-filestore-local-first-plan.md` (PR #63, merged)
  - Phase 2 — `2026-04-29-PIN-5775-phase2-kb-local-first-addendum.md` (PR #66, in review)
**Status:** Draft for engineer review — stage 01 (Brief). Do not advance to stage 02 (Plan) until approved.

---

## Problem

V2's pitch is *"local as source of truth — the cloud mirrors what's on disk."* After Phase 2, three of the five OpenIT entities deliver on that promise:

| Entity | Phase | Sync direction |
|---|---|---|
| Filestore | 1 | Bidirectional (local-first) ✅ |
| KB | 2 | Bidirectional (local-first) ✅ |
| Datastore | pre-V2 (R3) | Bidirectional ✅ — but uses its own bespoke orchestrator, not `createCollectionEntitySync` |
| Agents | R4 | **Read-only** ⚠️ — `startReadOnlyEntitySync` only |
| Workflows | R4 | **Read-only** ⚠️ — `startReadOnlyEntitySync` only |

For agents and workflows, the V2 promise is broken. A user can edit `agents/triage.json` locally — Claude Code's whole UX is "you author the agent's instructions in the file" — but that edit never reaches Pinkfish. On next poll, the local edit gets overwritten by the cloud version. For workflows the surface area is smaller (workflows are mostly authored via the Pinkfish dashboard's drag-drop), but the same one-way street applies: a local YAML tweak can't ship.

For datastore, the gap is architectural rather than user-facing. Datastore syncs bidirectionally and works correctly today — but its orchestrator is a hand-written ~600-LOC parallel to the one Phase 2 just centralized. That's a maintenance tax: a bug fix in the shared `createCollectionEntitySync` doesn't reach datastore; an investigation of "why is sync hanging?" has to look in two places.

Together: agents+workflows have a behaviour gap, datastore has an architecture gap. Phase 3 closes both.

## Desired Outcome

**For users:**
- Agents and workflows behave like every other entity. Edit `agents/triage.json` locally, the cloud picks it up on the next poll. Edit on the dashboard, it pulls down. Commit on the GUI Sync tab pushes ALL five entity types in one operation.
- Conflicts on agents / workflows surface in the same "Resolve in Claude" bubble as everything else, with the same `.server.json` shadow-merge UX.

**For the codebase:**
- All five sync wrappers (`filestoreSync.ts`, `kbSync.ts`, `datastoreSync.ts`, `agentSync.ts`, `workflowSync.ts`) collapse to thin ~60–100-LOC files calling into the shared engine helpers.
- One source of truth per concern: lifecycle and status in `createCollectionEntitySync` (or a sibling for the row-shaped engines), conflict bus in `syncEngine.ts`, manifests in `nestedManifest.ts`. Per-engine glue is engine-specific upload semantics + REST endpoint + display label.
- Datastore consolidates onto the shared helper — proves the abstraction generalises beyond filestore + KB or, if it doesn't, motivates a sibling `startRowCollectionEntitySync` in the same naming family.

## Scope

### In

1. **Agents → bidirectional.** Add a push path (`pushAllToAgents` per agent file). Wire onto the appropriate engine helper. `agentSync.ts` becomes a thin wrapper. Conflicts use the same `.server.json` shadow + cross-entity conflict bus.
2. **Workflows → bidirectional.** Same pattern as agents. Push path targets `POST /service/automations/{id}` (or whatever the dashboard's "save draft" endpoint is). Release stays manual via the existing dashboard UX — sync targets the workflow draft only.
3. **Datastore consolidation.** Refactor `datastoreSync.ts` to use the same shared engine helper as filestore + KB. If the shape fits, plug in. If it doesn't (rows + schema is different enough), extract a sibling `startRowCollectionEntitySync` rather than knob-fitting the existing helper.
4. **Single Sync-tab Commit pushes everything.** The Sync tab's commit handler currently pushes filestore, KB, and datastore. Phase 3 extends `pushAll.ts` to include agents + workflows. One click → all five entities.
5. **Plugin script support.** `sync-resolve-conflict.mjs` already accepts `agent` / `workflow` / `datastore` for flat manifests. Whatever new shape datastore adopts (nested or otherwise), the script keeps working.
6. **Integration tests** covering each engine's bidirectional flow against the live Pinkfish org.

### Out (deferred to later phases)

- **Plugin overlay revision-gating** — orthogonal concern, own phase.
- **First-bind confirm dialog / "switch cloud orgs" UX** — UI work, separate ticket.
- **V1 → V2 folder migration UX** — `~/OpenIT/<oldOrgId>/` → `~/OpenIT/local/`. Surface area is "what to do when `lastRepo` points at an orphaned folder." Separate ticket.
- **Plan-limit pre-flight (SC-6)** — separate ticket.
- **Auto-push on file change** — Phase 2 push remains commit-button-gated. Phase 3 keeps that contract; auto-push is a separate UX decision.
- **Push-in-poll-loop wiring** — same call.
- **Rewriting plugin skills to be multi-collection-aware beyond what Phase 2 already covered** — only `sync-resolve-conflict.mjs` was updated in Phase 2; other skills (`answer-ticket`, `kb-search`, etc.) hardcode `knowledge-bases/default/` paths. Updating those is a docs/skills-content phase, not a sync-engine phase.

## Success Criteria

### Behaviour

- [ ] Edit `agents/triage.json` locally → next poll pushes the change to Pinkfish. Verify via dashboard.
- [ ] Edit an agent on the Pinkfish dashboard → next poll pulls the change to `agents/<id>.json` locally.
- [ ] Both sides change between polls → `.server.json` shadow lands, "Resolve in Claude" bubble names the right path, the resolve-script flow clears the conflict.
- [ ] Same flow works for workflows under `workflows/<id>.json`.
- [ ] Same flow works for datastore rows under `databases/<colName>/<key>.json`.
- [ ] Sync tab Commit pushes all five entity types in one operation. Each surfaces a `▸ sync: <entity> pushing` log line and a `<n> ok, <m> failed` result.
- [ ] `cloud.json.lastSyncAt` updates after successful pulls of any entity (Phase 2 already covers filestore + KB; Phase 3 picks up agents / workflows / datastore).
- [ ] Local-only mode: editing any entity locally with no Pinkfish creds is fine. The sync is a no-op until creds are present.

### Architecture

- [ ] `agentSync.ts`, `workflowSync.ts`, `datastoreSync.ts` are each ≤ 150 LOC of engine-specific glue. (Today: 67, 66, 685.)
- [ ] No two engine wrappers contain duplicated lifecycle code (status object, listener pattern, polling loop, conflict tracking, `lastSyncAt` stamping). Every reuse goes through `syncEngine.ts` helpers.
- [ ] If a sibling helper is needed for the row-shaped datastore (`startRowCollectionEntitySync`), it lives next to `createCollectionEntitySync` in `syncEngine.ts` and follows the same naming + return-handle conventions.
- [ ] One source of truth for the manifest shape per engine. Datastore's manifest either migrates to the nested format or has a documented reason for staying flat; if it stays flat, `nestedManifest.ts` doesn't grow a "flat fallback" knob.

### Tests

- [ ] Vitest unit tests for new push paths (agents, workflows). Mock-based, like the Phase 2 KB tests.
- [ ] Integration tests in `integration_tests/` cover each entity's full bidirectional flow against the real Pinkfish API. Each test creates a row/file/agent/workflow, edits it on both sides, asserts the conflict shadow lands, runs the resolve script, asserts the post-resolve state is consistent.
- [ ] Phase 1 + Phase 2 manual scenarios still pass — no regression on filestore + KB.
- [ ] `cargo test`, `cargo build`, `cargo fmt --check`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:integration` all clean.

---

## Open questions for the engineer (resolve before stage 02)

1. **Workflow push semantics.** Workflows have a `releaseVersion` and a draft. Should sync target the draft only (current read path), and an explicit user action (button or dashboard) handle release? Or should sync push to release on every commit? The conservative choice is "draft-only push, release stays manual" — same shape as the read path.

2. **Agent push side effects.** Updating an agent on Pinkfish may invalidate active sessions, retraining, or trigger downstream notifications. Is `POST /service/useragents/{id}` safe to fire on every commit, or do we need rate-limiting / batching / "pause sync while editing"?

3. **Datastore shape — fits the helper, or sibling needed?** Datastore today uses ONE adapter for ALL collections (line 65 of `entities/datastore.ts`: `prefix: "datastore"`). `createCollectionEntitySync` assumes per-collection adapters. Two paths:
   - **Refactor to per-collection** — match filestore/KB shape. Bigger churn but full architectural consistency.
   - **Sibling helper** — `startRowCollectionEntitySync` keeps the single-adapter shape, takes the collection list, handles row-as-file routing. Smaller diff but a new helper to maintain.
   Either is fine; recommendation depends on whether there's any reason datastore needs to keep its single-adapter shape (probably not — but the existing per-collection failure tracking via `unreliableKeyPrefixes` is non-trivial).

4. **Should this be one ticket or three?**
   - Option A: one PIN-TBD covering all three sub-tracks. Pro: ships V2 completion as one coherent unit. Con: large PR, longer review.
   - Option B: three sibling tickets (agents writeable, workflows writeable, datastore consolidation), each its own PR. Pro: each one is small. Con: spreads the V2 narrative across three PRs.

5. **Conflict surface on flat-list entities.** Agents / workflows are a flat list (no per-collection subfolders). The cross-entity conflict bus already supports them via the `agent` / `workflow` prefix. Does the resolve-script + Resolve-in-Claude bubble need any updates beyond what Phase 2 already shipped, or do those work as-is once push exists?

6. **Linear ticket.** New sibling of PIN-5775? Or a tracking parent ticket with three child issues? See Q4 — depends on scope decision.

7. **What about plugin skills hardcoding paths?** `answer-ticket.md` says "Write to `knowledge-bases/default/<filename>.md` (unless the admin asked for a custom KB)." If the admin's workspace has only `openit-runbooks`, that skill would write to `knowledge-bases/default/` which doesn't exist. Out of scope per the brief but worth flagging — a future "skill content audit" phase makes sense.

---

## Phase transition checklist (per `auto-dev/01-brief.md`)

- [ ] Linear ticket created with these four sections
- [ ] Engineer answers the seven open questions above
- [ ] Engineer approves the brief
- [ ] If scope is split into 3 tickets (Q4), all three are created and linked
- [ ] Predecessors (Phase 1, Phase 2) linked
- [ ] Deferred items captured as separate Linear tickets if warranted

When approved, advance to stage 02 (`auto-dev/02-impl.plan.md`) and produce `auto-dev/plans/YYYY-MM-DD-PIN-####-phase3-...md`.

---

## Reference: what's already centralised after Phase 2

```
syncEngine.ts (universal layer)
├── pullEntity / startPolling / withRepoLock / conflict bus  — primitives
├── startReadOnlyEntitySync   (R4)   ← agents (67 LOC), workflows (66 LOC) [Phase 3 adds push to these]
└── createCollectionEntitySync (Phase 2)  ← filestore (266 LOC), kb (271 LOC) [Phase 3 may add datastore]

nestedManifest.ts  ← per-collection manifest persistence, used by filestore + kb
```

Phase 3 either (a) extends `createCollectionEntitySync` to cover datastore + push-on-the-read-only-path, or (b) adds 1–2 sibling helpers (e.g. `startRowCollectionEntitySync`, `startWriteableEntitySync`) that follow the same naming family. The right call depends on shape.
