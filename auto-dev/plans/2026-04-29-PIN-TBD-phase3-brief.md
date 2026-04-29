# PIN-TBD: Phase 3 — Datastore consolidation + custom-datastore overview tile — Brief (draft)

**Ticket:** [TBD — new sibling of PIN-5775, to be created in Linear]
**Date:** 2026-04-29
**Repo:** `openit-app` (primary)
**Predecessors:**
  - Phase 1 — `2026-04-29-PIN-5775-phase1-filestore-local-first-plan.md` (PR #63, merged)
  - Phase 2 — `2026-04-29-PIN-5775-phase2-kb-local-first-addendum.md` (PR #66)
**Status:** Draft for engineer review — stage 01 (Brief). Do not advance to stage 02 (Plan) until approved.

---

## Problem

Two gaps to close, both about datastore.

### Architecture gap

After Phase 2, lifecycle + status + per-collection conflict tracking + polling + `lastSyncAt` for filestore and KB live in one shared helper, `createCollectionEntitySync`, in `syncEngine.ts`. Each engine wrapper is ≤ 270 LOC of engine-specific glue.

Datastore syncs bidirectionally and works correctly today — but its orchestrator is a hand-written ~600-LOC parallel to the one Phase 2 just centralized. That's a maintenance tax: a bug fix in the shared helper doesn't reach datastore; an investigation of "why is sync hanging?" has to look in two places. The current `datastoreSync.ts` reimplements: status object, listener pattern, polling loop, in-flight resolve dedup, auto-create defaults loop with 409 handling, conflict tracking, push lifecycle. All of those are now centralized in `createCollectionEntitySync` for filestore + KB.

### UX gap

The Workbench overview pulls the two default datastores (`openit-tickets`, `openit-people`) up as dedicated tiles. If a user creates a custom `openit-*` datastore — either by hand on the Pinkfish dashboard, or via a future Skill that adds one — there's no surface for it on the overview. It exists as a folder under `databases/` and is reachable via the FileExplorer tree, but not discoverable.

This is a Phase-2-shaped gap: Phase 2 made the sync engine multi-collection-aware for KB, but the overview still treated it as if there were one canonical KB. Datastore has the same issue, with the wrinkle that the two defaults already get special-tile treatment. The fix needs to preserve the defaults as primary fast-paths.

## Desired Outcome

**For users:**
- Editing a row under `databases/<colName>/<key>.json` syncs to Pinkfish on the next poll. (Already works — Phase 3 doesn't change this.)
- A custom datastore the user creates (e.g. `openit-projects`) is discoverable from the overview without cluttering the workspace for users who only have the defaults.
- The all-datastores listing view, when present, shows row count + last-sync timestamp per datastore, and clicking an entry opens the existing FileExplorer at `databases/<colName>/`.

**For the codebase:**
- `datastoreSync.ts` collapses to ~150 LOC of engine-specific glue: REST endpoints, schema-write side-effect, push impl. All lifecycle / status / polling / conflict tracking goes through the shared helper.
- If datastore's rows+schema shape genuinely doesn't fit `createCollectionEntitySync`, a sibling helper (`startRowCollectionEntitySync`) lives next to it in `syncEngine.ts` following the same naming family — same outer surface, different inner mechanics.
- One source of truth for the orchestrator concerns. After Phase 3, the only engines NOT on a shared helper are agents and workflows (read-only via `startReadOnlyEntitySync` from R4). Making them writeable is a separate phase.

## Scope

### In

1. **Datastore consolidation onto the shared engine helper.** Refactor `datastoreSync.ts` (685 LOC today) to use `createCollectionEntitySync` (or a new sibling). Status, listeners, polling loop, in-flight resolve, auto-create, conflict tracking, `lastSyncAt` all delegate. Engine-specific glue: REST `?type=datastore` discovery, `_schema.json` per-collection bootstrap (today runs as a side-effect inside `startDatastoreSync`), push (full reconcile per collection — POST new, PUT changed, DELETE missing).

2. **`_schema.json` bootstrap stays datastore-specific.** Schemas have no `updatedAt` and don't fit the engine's version-diff model. Whatever shape datastore lands on, the schema-write side-effect runs once on connect (current behaviour). Either as a hook in the orchestrator's `start` lifecycle, or as a pre-pull step in the wrapper.

3. **Custom-datastore overview tile + listing view.** Today the Workbench overview has dedicated tiles for `tickets` and `people` and no surface for any other `openit-*` datastore. Add a conditional **"Databases"** tile that:
   - Renders only when at least one non-default datastore is present (any `openit-*` datastore other than `openit-tickets` / `openit-people`).
   - Click opens an all-datastores listing view — every `openit-*` datastore including the defaults, with row counts and last-sync timestamps.
   - Each entry routes into the existing FileExplorer at `databases/<colName>/`.
   - Default tiles stay as the primary fast-paths; the new tile is for discoverability of customs without cluttering the overview when the user has only the defaults.

4. **Plugin script support.** `sync-resolve-conflict.mjs` accepts `datastore` for the flat manifest. If datastore migrates to a nested per-collection manifest in this phase, the script gets updated to navigate the new shape (same change Phase 2 made for KB and filestore). If datastore stays on the flat manifest, no script changes.

5. **Integration tests** covering datastore's full bidirectional flow against the live Pinkfish org. Mirror the Phase 2 KB integration tests in `integration_tests/`.

### Out (deferred to later phases)

- **Agents → bidirectional + Workflows → bidirectional.** Phase 4. They're currently read-only (R4) and the V2 "local as source of truth" promise isn't fully delivered until those land too. Each has its own non-trivial considerations (workflow draft-vs-release, agent push side effects) that warrant their own brief.
- **Plugin overlay revision-gating.** Orthogonal concern, own phase.
- **First-bind confirm dialog / "switch cloud orgs" UX.** UI work, separate ticket.
- **V1 → V2 folder migration UX.** Surface area is "what to do when `lastRepo` points at an orphaned `~/OpenIT/<oldOrgId>/`." Separate ticket.
- **Plan-limit pre-flight (SC-6).** Separate ticket.
- **Auto-push on file change.** Phase 2 push remains commit-button-gated; Phase 3 keeps that contract.
- **Push-in-poll-loop wiring.** Same call.
- **Rewriting plugin skills to be multi-collection-aware.** `answer-ticket`, `kb-search`, etc. hardcode `knowledge-bases/default/` paths. Skill-content audit, not sync-engine work — separate phase.
- **Custom-tile treatment for filestore + KB.** Phase 3 ships the datastore tile; if the same gap is felt for filestore / KB customs, address it separately. The FileExplorer's tree view already exposes them, so the urgency is lower.

## Success Criteria

### Datastore behaviour (no regression on existing flow)

- [ ] Edit a row file `databases/openit-tickets/<key>.json` locally → next poll pushes to Pinkfish. (Existing behaviour; verify it still works after the refactor.)
- [ ] Create a row on the Pinkfish dashboard → next poll pulls down to `databases/openit-tickets/<key>.json` locally.
- [ ] Both sides edit the same row → `.server.json` shadow lands, "Resolve in Claude" bubble names the right path, the resolve-script flow clears the conflict.
- [ ] Server-side delete propagates to local file removal (existing `onServerDelete` behaviour preserved).
- [ ] `_schema.json` per collection writes once on connect; content-equality skip prevents redundant rewrites on subsequent connects.
- [ ] `cloud.json.lastSyncAt` updates after a successful datastore pull (the Phase 2 deferral now extends to datastore).
- [ ] Pre-existing pagination + per-collection failure tracking (`unreliableKeyPrefixes`) is preserved.

### Custom-datastore overview UX

- [ ] User with only the two default datastores sees the existing two tiles and NO "Databases" tile. Overview is unchanged.
- [ ] User with a custom datastore (e.g. `openit-projects`) sees the existing two default tiles AND a new "Databases" tile.
- [ ] Click the "Databases" tile → listing view of every `openit-*` datastore, with row count + last-sync timestamp per entry.
- [ ] Click an entry in the listing → opens the FileExplorer at `databases/<colName>/`.
- [ ] When the user deletes a custom datastore on the cloud, the next poll removes it from the listing and (if it was the only custom one) hides the "Databases" tile on next overview render.

### Architecture

- [ ] `datastoreSync.ts` is ≤ 200 LOC of engine-specific glue (today: 685).
- [ ] Status / lifecycle / polling / conflict tracking / in-flight resolve / auto-create / `lastSyncAt` all live in `syncEngine.ts` helpers, not in `datastoreSync.ts`.
- [ ] If a sibling helper is needed for the row+schema shape, it follows the same naming family (`startRowCollectionEntitySync` or similar) and the same return-handle conventions as `createCollectionEntitySync` and `startReadOnlyEntitySync`.
- [ ] One source of truth for the manifest shape per engine. Datastore either migrates to the nested format or has a documented reason for staying flat.

### Tests

- [ ] Vitest unit tests cover datastore adapter routing, resolver helpers (prefix filter, dedupe).
- [ ] Integration tests in `integration_tests/datastore-sync.test.ts` cover datastore's discovery, pull, push, conflict, server-delete flows against the live Pinkfish API.
- [ ] Phase 1 + Phase 2 manual scenarios still pass — no regression on filestore + KB.
- [ ] `cargo test`, `cargo build`, `cargo fmt --check`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:integration` all clean.

---

## Open questions for the engineer (resolve before stage 02)

1. **Datastore shape — fits the helper, or sibling needed?** Datastore today uses ONE adapter for ALL collections (line 65 of `entities/datastore.ts`: `prefix: "datastore"`). `createCollectionEntitySync` assumes per-collection adapters. Two paths:
   - **Refactor to per-collection** — match filestore/KB shape. Bigger churn but full architectural consistency. Trade-off: the existing per-collection failure tracking via `unreliableKeyPrefixes` is non-trivial; would need to move that into the orchestrator or accept that each adapter handles its own pagination failure scope.
   - **Sibling helper** — `startRowCollectionEntitySync` keeps the single-adapter shape, takes the collection list, handles row-as-file routing internally. Smaller diff but a new helper to maintain.
   Recommendation: try the per-collection refactor first since it's the more consistent architecture; fall back to the sibling helper if the row+schema constraints prove too awkward. Either is fine.

2. **`_schema.json` write — orchestrator hook or wrapper-side step?** Today it runs as a side-effect inside `startDatastoreSync`. With the refactor, the schema write needs a place to live:
   - **Add `onAfterResolve(collections)` hook to the orchestrator's config** — generic enough that future engines could use it; small surface area.
   - **Run it in the wrapper, before calling `handle.start`** — the wrapper does its schema thing, then defers the rest to the helper. Simpler but breaks the "one start call kicks off everything" pattern.
   The hook is cleaner; recommendation is to add it.

3. **"Databases" tile — first-time discovery affordance?** When the conditional tile appears for the first time (because the user just created a custom datastore), should there be any UX cue (badge, tooltip, "new" pill) to signal it's appeared? Or is the tile simply being there enough? Lean toward "tile being there is enough" — overhead of cue logic isn't worth the discoverability lift; if engineers ask for it later, add then.

4. **Listing view — what does it look like?** The brief says "row count + last-sync timestamp per entry." Concretely:
   - A table with columns: name (display, prefix-stripped), row count, last sync? Inline edit / delete from the table?
   - A grid of cards mirroring the FileExplorer's collection cards (line 85 of FileExplorer.tsx)?
   Recommendation: card grid, reuse the FileExplorer's existing card component if possible. Keeps visual language consistent.

5. **"Databases" vs "Datastores" naming.** Workbench station IDs use `databases/` (the on-disk folder name). The cloud REST type is `datastore`. The user-facing UI today is inconsistent. Phase 3 picks one for the new tile + listing. Recommendation: **"Databases"** — reads more natural to non-engineers, matches the on-disk folder users see, less server-jargon-y. Optional follow-up: one-pass rename across UI strings in a separate small PR.

6. **Conditional tile placement.** Where does the "Databases" tile go in the Workbench station order? Today the order is `inbox / reports / people / knowledge / files / agents / cli`. A conservative choice: insert after `people`, so it groups visually near the existing datastore-rooted tiles.

7. **Linear ticket.** New sibling of PIN-5775? Confirm.

---

## Phase transition checklist (per `auto-dev/01-brief.md`)

- [ ] Linear ticket created with these four sections
- [ ] Engineer answers the seven open questions above
- [ ] Engineer approves the brief
- [ ] Predecessors (Phase 1, Phase 2) linked
- [ ] Deferred items captured as separate Linear tickets if warranted (specifically: Phase 4 — agents + workflows writeable)

When approved, advance to stage 02 (`auto-dev/02-impl.plan.md`) and produce `auto-dev/plans/YYYY-MM-DD-PIN-####-phase3-datastore-consolidation-plan.md`.

---

## Reference: state of the sync architecture going into Phase 3

```
syncEngine.ts (universal layer)
├── pullEntity / startPolling / withRepoLock / conflict bus  — primitives
├── startReadOnlyEntitySync   (R4)   ← agents (67 LOC), workflows (66 LOC)  [Phase 4 — make writeable]
└── createCollectionEntitySync (Phase 2)  ← filestore (266 LOC), kb (271 LOC)  [Phase 3 — add datastore]

nestedManifest.ts  ← per-collection manifest persistence, used by filestore + kb
                   [Phase 3 may extend this to datastore, or datastore keeps its flat shape]
```

After Phase 3, the only engines NOT on a shared orchestrator are agents and workflows. Phase 4 closes that gap.
