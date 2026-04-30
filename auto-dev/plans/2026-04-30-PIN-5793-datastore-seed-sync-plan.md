# PIN-5793: Datastore + seed flow (rewrite) — Implementation plan

**Ticket:** [PIN-5793](https://linear.app/pinkfish/issue/PIN-5793/openit-v2-sync-datastore-seed-flow-rewrite-supersedes-pin-5779)
**Date:** 2026-04-30
**Repo:** `openit-app` (primary)
**Predecessor:** PIN-5775 (V2 sync umbrella; Phase 1 PR #63, Phase 2 PR #66 merged)
**Supersedes:** PIN-5779 (canceled — too twisted around cloud bugs that have since been fixed)

---

## 1. Technical investigation

### Current state on `main`

- `src/lib/datastoreSync.ts` (685 LOC) auto-creates only the two hardcoded structured defaults `openit-tickets` / `openit-people` (line 184: `isStructured: true`). Resolver matches by exact name (line 139–141); anything else is invisible to the engine.
- `src/lib/entities/datastore.ts` writes one file per row at `databases/<colName>/<key>.json` — flat-per-collection. No nested-layout support.
- `intake.rs` (lines 2024–2082) writes conversation turns to `databases/conversations/<ticketId>/<msgId>.json` — these never round-trip with cloud today.
- `src/shell/FileExplorer.tsx` lines 485–499 hide `databases/conversations/` from the tree (gated on `!showSystemFiles`) because no engine path serves it.
- `cloud.json.lastSyncAt` is wired for filestore + KB but skipped for datastore (Phase 2 deferral).
- `scripts/openit-plugin/schemas/{tickets,people}._schema.json` exist on disk and are listed in `manifest.json`. The `people` schema uses `displayName` — abandoned branch's seed uses `firstName`/`lastName`, so the schema needs updating.
- `scripts/openit-plugin/seed/` does not exist on `main`.
- `src/lib/skillsSync.ts::routeFile` (lines 111–155) already maps `schemas/<col>._schema.json` → `databases/<col>/_schema.json`. Needs extension for `seed/<target>/<file>` patterns.

### Cloud-side state

Per engineer (2026-04-30): cloud datastore fixes #1 (`POST /datacollection/` honors caller `schema` when `templateId` absent) and #2 (`PUT /datacollection/{id}/schema` accepts `text` / `datetime` / `enum` / `string[]`) are landed on `dev20`. Single-call structured create works. Race-on-name (#3) likely fixed too — verify at integration-test time, only re-introduce in-process race-guard if duplicates appear.

### What's cherry-pickable from `ben/pin-5779-phase3-datastore`

Verbatim:
- `scripts/openit-plugin/schemas/people._schema.json` (replaces main version with `firstName`/`lastName` split)
- `scripts/openit-plugin/seed/**` (5 tickets + 5 people + 8 conversation messages + 2 KB articles = 20 files)
- `integration_tests/datastore-sync.test.ts` (139 LOC)
- New helpers in `integration_tests/utils/pinkfish-api.ts` (createCollection / deleteCollection / listDatastoreItems / putCollectionSchema)

**Not** carrying forward:
- `src/lib/datastoreSchema.ts` (107 LOC, `localSchemaToCloud` — obsolete with cloud fix #2)
- `customCreate` / `sanitizeSchemaForPut` paths in `datastoreSync.ts` (obsolete with cloud fix #1)
- `src/lib/seedDriver.ts` (211 LOC class — collapsed to a ~50-LOC `seedIfEmpty` helper)
- `src/lib/useOnceEffect.ts` (deferred — only re-introduce if integration tests show duplicate-create at startup)
- `src/shell/Workbench.tsx` listing-view changes (deferred per brief — UI surface, not sync)
- `scripts/openit-plugin/skills/databases.md` (deferred per brief — plugin docs, not sync)
- `entityRouting.ts::readField` schema-aware fallback (deferred — cloud honors bundled IDs, semantic lookup `row[fieldId]` is sufficient)
- CLAUDE.md hash-guard (deferred per brief)

## 2. Proposed solution

**Approach.** Extend `datastoreSync.ts` in place (keep its 685-LOC orchestrator structure; add ~150 LOC of branching). Cherry-pick bundled assets and integration test verbatim. Add a thin `seedIfEmpty` helper. **No** consolidation refactor onto `createCollectionEntitySync`. **No** `seedDriver` class. **No** UI tile / listing view / Claude skill.

### Files to modify

| File | Change |
| --- | --- |
| `src/lib/datastoreSync.ts` | (a) `resolveProjectDatastores` discovers all `openit-*` datastores by prefix, not name-match. (b) `DEFAULT_DATASTORES` extended with `openit-conversations` (`isStructured: false`, no template). (c) Auto-create writes use natural single-call POST with caller schema (cloud fixes #1+#2 in). (d) `writeDatastoreSchemas` skips `isStructured === false`. (e) `pushAllToDatastoresImpl` walks nested subfolders for `openit-conversations`. (f) Pull-success callback updates `cloud.json.lastSyncAt`. |
| `src/lib/entities/datastore.ts` | Conversations adapter wrinkle: when `col.name === "openit-conversations"`, `listRemote` writes rows to `databases/conversations/<row.content.ticketId>/<rowKey>.json`; `listLocal` walks one level deeper for that collection. Manifest key remains `openit-conversations/<msgId>` — msgId is globally unique by construction. |
| `src/lib/skillsSync.ts` | Extend `routeFile` to map `seed/{tickets,people,knowledge,conversations}/<...>` → workspace path. The seed-gate (folder-empty + cloud-empty) lives in `seedIfEmpty`, NOT in `routeFile` — `routeFile` just describes the destination. |
| `src/lib/seed.ts` (new, ~60 LOC) | `seedIfEmpty(repo, creds)`: for each target (`tickets` / `people` / `knowledge` / `conversations`), gate on `(local target folder is empty)` AND `(cloud has no openit-<X> collection)`. Iterate `manifest.files` matching `seed/<target>/...`, fetch via `fetchSkillFile`, write via `entity_write_file`. Engine's bootstrap-adopt + push pipeline take it from there. |
| `src/lib/datastoreSync.ts::startDatastoreSync` | After the first successful pull, call `seedIfEmpty` once. No auto-push — user clicks Commit (or `sync-push.mjs` runs) per existing v1 push contract. |
| `src/shell/FileExplorer.tsx` | Drop the `databases/conversations/` exclusion (lines 485–499). Conversations always visible. |
| `scripts/openit-plugin/schemas/people._schema.json` | Cherry-pick from abandoned branch (`firstName`/`lastName` split). |
| `scripts/openit-plugin/seed/**` (new, 20 files) | Cherry-pick from abandoned branch. |
| `scripts/openit-plugin/manifest.json` | Add `seed/{tickets,people,knowledge,conversations}/...` entries to `files`. Bump `version`. |
| `integration_tests/datastore-sync.test.ts` (new) | Cherry-pick from abandoned branch (139 LOC). |
| `integration_tests/utils/pinkfish-api.ts` | Cherry-pick the additional helpers (createCollection / deleteCollection / listDatastoreItems / putCollectionSchema) if not already present. |

### Unit tests

| File | Test |
| --- | --- |
| `src/lib/seed.test.ts` (new) | `seedIfEmpty` gate logic: folder-empty + cloud-empty → seed; folder-non-empty → skip; cloud-has-collection → skip. Mock `fsList` and the cloud-resolve. |
| `src/lib/skillsSync.test.ts` (already exists) | Add cases: `seed/tickets/foo.json` → `databases/tickets/foo.json`, `seed/conversations/T1/M1.json` → `databases/conversations/T1/M1.json`, `seed/knowledge/x.md` → `knowledge-bases/default/x.md`. |
| `src/lib/entities/datastore.test.ts` (new) | Conversations adapter mapping: a row with `content.ticketId = "T1"` and key `"M1"` from `openit-conversations` writes to `databases/conversations/T1/M1.json`; round-trip preserves `ticketId` + msgId. |

`datastoreSync.ts` itself: prefix-discovery + isStructured branching are exercised by the integration test against real backend (mock-equivalents drift on cloud-shape changes — that's exactly what burned the abandoned branch).

### Manual scenarios (stage 04)

I'll run as many as possible without the engineer present; the rest are flagged in the stage-04 Linear comment.

1. **Brand-new install + connect to fresh org.** Wipe `~/OpenIT/local`, `npm run tauri dev`, click Connect against a clean test org. Expect: 5 tickets / 5 people / 8 conv messages / 2 KB articles end up on `dev20`; local mirrors; no phantom rows; `databases/conversations/` visible.
2. **Reconnect against same org.** Disconnect/reconnect — no duplicate rows, no contamination.
3. **Edit a row locally.** Edit `databases/openit-tickets/sample-ticket-1.json`, click Sync-tab Commit, verify push.
4. **Edit a row on cloud.** Update via Pinkfish dashboard, wait 60s, verify pull.
5. **Two-side conflict.** Edit same row both sides → expect `.server.json` shadow + ConflictBanner.
6. **Conversations round-trip.** Add `databases/conversations/sample-ticket-1/msg-NEW.json`, sync-push, verify on cloud. Edit msg on cloud, wait poll, verify local update.

(Most are also covered by the integration test.)

### Cross-repo plugin steps

This change touches `scripts/openit-plugin/` (schemas + seed + manifest version). At PR merge:

1. Copy `scripts/openit-plugin/{schemas,seed,manifest.json}` from this repo into `/web/packages/app/public/openit-plugin/` (mirror paths).
2. Push `/web`. Existing OpenIT installs get the bundle on next plugin sync.

## 3. Implementation checklist

### Step 1 — Cherry-pick assets
- [ ] Replace `scripts/openit-plugin/schemas/people._schema.json` with abandoned-branch version.
- [ ] Add `scripts/openit-plugin/seed/{tickets,people,conversations,knowledge}/**` (20 files).
- [ ] Update `manifest.json` to list seed paths + bump version.
- [ ] Cherry-pick `integration_tests/datastore-sync.test.ts` and any missing helpers in `integration_tests/utils/pinkfish-api.ts`.

### Step 2 — Plugin route + seed helper
- [ ] Extend `skillsSync.ts::routeFile` for `seed/<target>/...` patterns.
- [ ] Add `src/lib/seed.ts` with `seedIfEmpty(repo, creds)`.

### Step 3 — Datastore engine: multi-collection + flavors + lastSyncAt
- [ ] `resolveProjectDatastores` switches to `openit-*` prefix discovery (keeps the org-scoped cache + cooldown + 409-conflict refetch).
- [ ] Add `openit-conversations` to `DEFAULT_DATASTORES` (`isStructured: false`, no `templateId`).
- [ ] Drop the hardcoded `isStructured: true` in the create POST body — set per-default.
- [ ] `writeDatastoreSchemas` short-circuits collections where `isStructured === false`.
- [ ] After first successful pull, call `seedIfEmpty(repo, creds)`.
- [ ] On every successful pull, write `cloud.json.lastSyncAt` (one line — match what filestore/KB do).

### Step 4 — Conversations adapter wrinkle
- [ ] `entities/datastore.ts::listRemote`: when `col.name === "openit-conversations"`, derive `subdir` as `databases/conversations/<row.content.ticketId>` instead of `databases/openit-conversations`.
- [ ] `entities/datastore.ts::listLocal`: for that collection, walk one level deeper (per-ticket subdir → row files).
- [ ] `pushAllToDatastoresImpl`: same nested-folder walk for the conversations collection; ensure pushed content includes `ticketId` (use folder name as fallback if missing).

### Step 5 — UI surface
- [ ] FileExplorer: remove the `databases/conversations/` exclusion (lines 485–499).

### Step 6 — Tests
- [ ] Unit: `seed.test.ts`, conversations-adapter case in `datastore.test.ts`, new routes in `skillsSync.test.ts`.
- [ ] Integration: `npm run test:integration` (datastore-sync) against `dev20`.
- [ ] Full suite: `cargo test`, `cargo build`, `cargo fmt --check`, `npx tsc --noEmit`, `npx vitest run`.

### Step 7 — Manual + PR
- [ ] Manual click-through scenarios above (those I can run without the engineer; flag the rest in stage-04 comment).
- [ ] Self-review (stage 05) → `auto-dev/plans/2026-04-30-PIN-5793-datastore-seed-sync-plan-impl-review.md`.
- [ ] PR with conventional-commits title + `@cursor review` loop until findings are Low-only.

---

## A note on minimalism

The abandoned branch was +4500 LOC. This plan deliberately ships a fraction of that:
- ~250 LOC of new/modified TypeScript (the four code files above)
- ~50 LOC of new tests
- 20 cherry-picked seed files (no logic)
- 1 integration test (139 LOC, cherry-picked)

Anything bigger would re-create the sediment we just unwound.
