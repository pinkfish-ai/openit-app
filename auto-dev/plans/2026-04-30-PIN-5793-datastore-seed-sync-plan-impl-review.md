# PIN-5793 — Implementation review

**Reviewing:** `2026-04-30-PIN-5793-datastore-seed-sync-plan.md`
**Branch:** `ben/pin-5793-datastore-seed-sync`
**Reviewer:** self (automated stage 05)
**Date:** 2026-04-30

## Verdict

**Ship.** Plan executed end-to-end. All required code paths land; full vitest suite (137 tests, +14 new) green; `npx tsc --noEmit` clean; `vite build` clean. Cargo + integration tests + manual click-through deferred to engineer (see "What I couldn't verify" below).

## Plan vs. shipped

| Plan item | Shipped? | Notes |
| --- | --- | --- |
| Cherry-pick schemas + 20 seed files + integration test | ✅ | `git checkout origin/ben/pin-5779-phase3-datastore -- ...` |
| `manifest.json` lists seed paths + version bump | ✅ | bumped to `2026-04-30-008` |
| `routeFile` returns null for `seed/*` (handled by seedIfEmpty) | ✅ | `src/lib/skillsSync.ts` |
| `seedIfEmpty` helper with per-target gate | ✅ | new `src/lib/seed.ts` |
| Multi-collection prefix discovery in `resolveProjectDatastores` | ✅ | drops org-id name suffix; matches `openit-*` |
| `openit-conversations` added to `DEFAULT_DATASTORES` (unstructured) | ✅ | new `DefaultDatastore` type for the per-default `isStructured` |
| Drop hardcoded `isStructured: true` in create POST body | ✅ | per-default; `templateId` only set when present |
| `writeDatastoreSchemas` skips unstructured | ✅ | `if (col.isStructured === false) continue;` |
| Pull-success `projectUpdateLastSyncAt` | ✅ | wired in `tryResolveAndPull` |
| Conversations adapter: pull explodes by `content.ticketId` | ✅ | `entities/datastore.ts::listRemote` |
| Conversations adapter: nested local walk | ✅ | `listLocal` for the conversations collection |
| Conversations adapter: server-delete uses local `workingTreePath` | ✅ | `onServerDelete` no longer recomputes path |
| Push: nested folder walk for conversations + `ticketId` injection | ✅ | `pushAllToDatastoresImpl` |
| `App.tsx::startCloudSyncs` calls `seedIfEmpty` before engines | ✅ | `.finally()` keeps engines starting if seed fails |
| FileExplorer drops `databases/conversations/` exclusion | ✅ | replaced gating block with a comment |
| Unit tests: `seed.test.ts` (gate logic) | ✅ | 11 tests, including nested layout + dotfile/`_schema.json` exemption |
| Unit tests: `entities/datastore.test.ts` (conversations mapping) | ✅ | 3 tests |

## What I couldn't verify (flag for engineer)

- **`cargo test` / `cargo build` / `cargo fmt --check`** — `cargo` not installed on this machine, AND no Rust files were modified. Run locally; expected clean.
- **`npm run test:integration`** — requires `test-config.json` against `dev20.pinkfish.dev` and a clean test org. Run locally before merge.
- **Manual click-through (scenarios 1–6 in the plan)** — needs the dev window. Highest-value scenario to actually click: brand-new install + connect to fresh org → expect 5 + 5 + 8 + 2 rows on cloud after a Sync click; FileExplorer shows `databases/conversations/`. The other scenarios are also covered by the integration test once it runs.

## Findings

### Side-effects worth knowing

1. **Local folder rename for tickets/people.** Previously `databases/openit-tickets-<orgId>/`; now `databases/tickets/`. Aligns with `intake.rs` (which already wrote to `databases/tickets/`) and the FileExplorer's pre-existing assumptions in `entityRouting.ts` / `Workbench.tsx`. Existing users of the old layout would see their rows orphaned — acceptable per the brief ("V2 hasn't launched yet").

2. **Cloud collection name strips the `-${orgId}` suffix.** Pre-existing `openit-tickets-<orgId>` collections on cloud now show up as "openit-* collections" and will sync to `databases/tickets-<orgId>/`. Test orgs created by the abandoned-branch experiments may need a one-time cleanup. New orgs get `openit-tickets` cleanly.

3. **`projectUpdateLastSyncAt` failure is logged but doesn't fail the pull.** Matches the conservative pattern from filestore/KB.

4. **Conversations row missing `content.ticketId` is dropped with a `console.warn`.** Cleaner than dumping under a `_unrouted/` bin; the warning surfaces the data-corruption case rather than hiding it.

### Deferred (per brief; explicitly out of scope)

- Custom-datastore overview tile + listing view
- `scripts/openit-plugin/skills/databases.md` Claude skill
- `CLAUDE.md` hash-guard
- Schema-aware Cards UI fallback (`readField` rich path)
- Architectural consolidation of `datastoreSync.ts` onto `createCollectionEntitySync`
- `useOnceEffect` StrictMode guard

The brief's "Out" section captures these; each can become its own follow-up ticket if/when the gap is felt.

### Risks

- **First-pull-then-seed sequencing.** Seed runs *before* any sync engine starts (in `App.tsx::startCloudSyncs`). This is intentional so the cloud-empty gate sees the cloud in its pre-auto-create state. If a user connects to an org where another OpenIT instance has *just* created `openit-tickets`, our seed gate may race and write samples that then conflict on push. Acceptable v1 behavior — the conflict-shadow flow handles it.
- **Conversations cloud key = bare `<msgId>`.** Diverges from the spec doc's "composite preferred for prefix-filter performance" recommendation. v1 trade-off: simpler engine, no cloud-key migration needed if users author rows by hand. If the conversation viewer's "all messages for ticket X" query becomes slow we revisit.

## Next stages

- **Stage 06 — PR.** Engineer to confirm cargo + integration + manual scenarios pass locally, then `gh pr create` and `@cursor review` loop until findings are Low-only.
- **Cross-repo `/web` mirror.** At merge time, copy `scripts/openit-plugin/{schemas,seed,manifest.json}` into `/web/packages/app/public/openit-plugin/`. Documented in the plan; do not skip.
