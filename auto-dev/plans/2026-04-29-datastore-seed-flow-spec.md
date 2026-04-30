# Datastore + seed flow — behavior spec

Plain-language description of how OpenIT's databases (tickets, people, conversations) and bundled seed data should behave end-to-end, assuming the cloud API fixes from `2026-04-29-datastore-cloud-fixes.md` are in place. No implementation details — just the contract we're shipping in this PR.

## What ships in the bundle

OpenIT ships with three things that land on disk on first launch:

1. **Schemas** for the two structured default datastores: `databases/tickets/_schema.json` and `databases/people/_schema.json`. These define the field shape (subject, asker, status, etc.; firstName, lastName, email, etc.). Always overwritten by the bundled version on every launch — they're plugin contract, not user data.

2. **Sample data** ("seed") so a brand-new install has something to look at:
   - 5 sample tickets in `databases/tickets/`
   - 5 sample people in `databases/people/`
   - 2 sample KB articles in `knowledge-bases/default/`
   - 8 conversation messages across the 5 tickets in `databases/conversations/<ticketId>/msg-*.json`
   - Every sample is named/prefixed with "Sample —" so it's obvious.

3. **CLAUDE.md** at repo root — the admin's editing surface. Treated specially (see below).

## CLAUDE.md handling

Sync writes the bundled CLAUDE.md, but never clobbers admin edits:

- First launch → write bundled, record content hash.
- Subsequent launch → if on-disk hash matches recorded hash, write fresh bundled (admin hasn't touched it).
- Subsequent launch → if on-disk hash differs from recorded hash, leave it alone (admin has edited).

## Seed application

Seed is **per-target**. Each of `tickets`, `people`, `knowledge`, `conversations` decides independently whether to seed:

- Seed target X only if BOTH:
  - Local folder for X is empty (only `_schema.json` or dotfiles).
  - Cloud has no `openit-X` collection yet.
- Otherwise skip — local data wins, or cloud data wins, but we never layer samples on top of real rows.

No persisted "seed-applied" flag is needed — the disk + cloud state ARE the gate. A user who deletes a sample doesn't get it back (folder no longer empty). A user reconnecting against an existing cloud doesn't get samples (cloud already has data).

## Cloud collection creation

Each default cloud collection is created the first time the engine resolves and finds it missing:

- `openit-tickets` — structured, schema = our bundled tickets schema.
- `openit-people` — structured, schema = our bundled people schema.
- `openit-conversations` — unstructured (no schema; freeform JSON rows).
- `openit-default` (KB) — already created by the existing KB engine; unchanged.

Creation is idempotent: if the collection already exists on cloud (from a prior run, multi-device, etc.), the engine reuses it.

## Push/pull lifecycle

After collections exist, the engine reconciles every sync tick:

- **Pull** the cloud row set into local files.
- **Push** local additions/updates/deletes to cloud.
- **Conflict** (same row changed locally and remotely between syncs) surfaces in the conflict banner; admin resolves manually.

Row identity:

- **Tickets** — filename `<ticketId>.json`, cloud key = filename. ticketId is the link to conversations.
- **People** — filename `<email-or-id>.json`, cloud key = filename.
- **Conversations** — filename `<msgId>.json` inside `databases/conversations/<ticketId>/`. Cloud key = `<msgId>` (msg ids are globally unique by construction); the row's `ticketId` field carries the linkage. Pull re-creates the per-ticket subfolder structure from each row's `ticketId` content.

System folders that don't sync: none in this scope. (Previously `databases/conversations/` was excluded; that exclusion goes away.)

## End-to-end scenarios

### A. Brand-new install, no cloud

1. Bootstrap creates `~/OpenIT/local/` with empty `databases/{tickets,people,conversations}/`, `knowledge-bases/default/`, etc.
2. Schemas written.
3. Local-only seed: all four targets are empty → seed lands. Local has 5+5 rows, 2 KB articles, 5 conversation threads with 8 turns.
4. Admin uses OpenIT locally. No cloud calls.

### B. Brand-new install, then connect to a fresh org

1. Same as A through step 3.
2. Admin clicks Connect.
3. Cloud-aware seed pre-check: cloud has none of `openit-{tickets,people,conversations,default}`. Local already has seed (from step 3). Decision: don't re-seed, but local data is ready to push.
4. Engine creates the three datastore collections + KB collection on cloud.
5. Push uploads local rows up. Cloud now mirrors local.
6. Multi-device user: on a second machine, the same flow runs but cloud has data → seed skipped → engine pulls cloud rows down. Both machines now in sync.

### C. Brand-new install, connect to an existing org with data

1. Same as A through step 3.
2. Admin clicks Connect.
3. Cloud-aware seed pre-check: cloud has `openit-tickets` (or `openit-people`, or `openit-default`) already. Decision: skip seed for the targets the cloud has. Folders may end up empty if all four cloud collections exist already — that's fine, pull will populate them.
4. Engine pulls cloud rows down. Local now mirrors cloud. No samples.

### D. Reconnect after a wipe

1. `rm -rf ~/OpenIT/local`. Restart.
2. Same as A through step 3 (fresh bootstrap, schemas, seed).
3. Engine starts. Cloud already has the collections from a previous session.
4. Pull pulls existing cloud rows. Push pushes the seed (since cloud is missing those rows? — see edge case 5).

### E. Wipe cloud, keep local

1. Admin deletes `openit-tickets` on cloud. Local untouched.
2. Restart. Local has tickets, cloud has none.
3. Cloud-aware seed pre-check: cloud doesn't have `openit-tickets`, but local folder isn't empty. Decision: skip seed (local has data — gate fails).
4. Engine creates fresh `openit-tickets` cloud collection. Push uploads existing local rows.

### F. Edit a sample, then reconnect

1. Admin edits "Sample — Alice Sample" → "Alice Real".
2. Pushes to cloud. Cloud has the edited row.
3. On reconnect (or next sync tick), pull from cloud doesn't re-overwrite the local edit (the row came from cloud, hasn't changed since last sync).
4. The "Sample —" prefix in cloud is still there for un-edited samples — only the edited one updated.

### G. Delete a sample, restart

1. Admin deletes `databases/people/sample-person-3.json`. Push propagates the delete to cloud.
2. Restart.
3. Seed pre-check: local people folder isn't empty (4 remaining). Cloud doesn't have sample-person-3. Decision: don't re-seed (local has data — gate fails). The deleted sample stays gone.

### H. Click a ticket whose conversation isn't synced yet

1. Admin clicks `csv-import-...-3` (a ticket that came from a pre-PR sync, no associated conversation).
2. Conversation-thread view opens. Local has no `databases/conversations/csv-import-...-3/` subfolder.
3. View renders **empty thread** ("No turns yet") instead of an error. Admin can still see ticket metadata and add a reply.

### I. Two devices, near-simultaneous edits

1. Device A edits `sample-ticket-2.json` (changes status). Device B edits the same file (changes priority).
2. Both push. Cloud accepts whichever arrives first; the loser sees a conflict on next pull.
3. Conflict banner surfaces; admin picks one or merges. Existing flow.

### J. Concurrent / double-fired startup

1. App starts in dev (React StrictMode runs effects twice).
2. The startup effect is guarded — it runs exactly once per real mount. No parallel `customCreate` calls.
3. Same protection covers HMR reloads and accidental double-clicks on Connect.

## UI rendering rules

The Cards UI (Inbox, People) and the table view both render rows via **schema-aware lookup**:

- Try semantic field IDs first (`displayName`, `email`, `subject`, `status` — what bundled schemas use).
- Fall back to label-based schema lookup (find the field whose `label` matches "Name"/"Email"/"Subject"/etc., read `row[field.id]`).
- If still nothing, render the row's key/id as the title.

This means rows whose IDs got renamed by the cloud (legacy data) still render. Same for any future schema migration.

## Files / folders the user sees

| Path | Source | Sync? |
|---|---|---|
| `databases/tickets/<id>.json` | local + cloud | yes (structured) |
| `databases/tickets/_schema.json` | bundle | overwritten on launch |
| `databases/people/<id>.json` | local + cloud | yes (structured) |
| `databases/people/_schema.json` | bundle | overwritten on launch |
| `databases/conversations/<ticketId>/<msgId>.json` | local + cloud | yes (unstructured) |
| `knowledge-bases/default/<file>.md` | local + cloud | yes (KB engine) |
| `agents/*.json`, `workflows/*.json` | bundle / admin | yes (existing engines) |
| `filestores/library/*` | admin | yes (existing) |
| `filestores/attachments/<ticketId>/*` | local + cloud (attachments engine) | yes |
| `CLAUDE.md` | bundle, admin-editable | special: hash-guarded write |
| `.openit/cloud.json` | runtime | local-only |
| `.openit/claude-md-hash` | runtime | local-only |
| `.openit/plugin-version` | runtime | local-only |
| `.claude/**` | bundle | overwritten on launch |

The file explorer shows `databases/conversations/` (no longer hidden as a system folder).

## Sample data — what's in it

Realistic-but-clearly-labeled IT scenarios so admins see the schema in action:

- **Tickets**: password reset, VPN drops, Figma access, dead laptop, Slack password — covering channels (chat/slack/email), statuses (open/escalated/resolved/closed), priorities, KB references.
- **People**: 5 contacts with role, department, channels — first/last name split.
- **KB articles**: "Resetting your Slack password", "Granting access to a shared Figma project" — both written as if the answer-once loop captured them.
- **Conversations**: per-ticket threads. Open/escalated tickets have just the asker turn; resolved/closed ones have asker + agent reply (so the admin sees what a complete thread looks like).

Sample IDs reference each other where appropriate — `sample-ticket-3.kbArticleRefs` points at `sample-article-2.md`, etc. — so clicking through a sample feels like real data.

## Out of scope for this PR

- Per-row schema validation on push (server-side or client-side beyond what's already there).
- Cloud-side admin-UI rendering fidelity for `text`/`datetime`/`enum`/`string[]` (depends on cloud fixes #2 from the cloud-fixes doc).
- Custom user-named structured datastores (folders the admin drops under `databases/` with a `_schema.json`). The discovery hook supports this but the seed flow doesn't apply.
- Semantic merge of conflicting rows (current behavior: surface to admin).

---

## Appendix: notes for the rewrite

### Pre-existing landmines (independent of this work)

These bit me repeatedly and aren't the new code's fault — fix them once and keep them fixed:

1. **React StrictMode double-fires `useEffect`** in dev. The startup effect (bootstrap → seed → engine start) is non-idempotent — every cloud `POST /datacollection/` runs twice and creates duplicates. Guard the startup effect with a one-shot ref. A custom hook (`useOnceEffect`) reads cleanly. Don't try to make the body idempotent — too many side effects.

2. **`autoCommitDriver` regex grabs `.placeholder`**. The engine's `ensureCollectionDir` writes-then-deletes `databases/<col>/.placeholder` to ensure the dir exists. The fs-watcher fires on the write, autoCommit captures `.placeholder` as a "ticketId" (its regex is `<prefix>/([^/]+)`), debounces 1.5s, and by then the file's gone — git stderr says `fatal: pathspec '...' did not match any files`. Logged as a `console.warn` so it _looks_ fatal but isn't. Filter out segments starting with `.` in the autoCommit predicate. Tiny fix, big sanity improvement.

3. **`writeStructuredSchemas` overwrites local `_schema.json` from cloud**. After the first successful pull, our rich-typed bundled schema gets clobbered by whatever the cloud returns (`f_N` IDs after a sanitized PUT). Either: don't overwrite when local already has a schema, or store cloud schema in a sidecar file (`.openit/cloud-schema-cache/<col>.json`) and keep the bundled one as canonical. Pick before pulling once.

4. **fs-watcher recursive `fs_list` walks 6 levels deep**. Several places (Workbench tile counts, `discoverLocalDatastores`, conversation thread resolver) need to filter to direct children manually. Easy to forget.

### Cloud-side things to know

5. **POST `/datacollection/` does not enforce name uniqueness**. Two parallel POSTs both succeed with the same name. Even with the StrictMode guard, any in-flight collision (e.g. user clicks Connect twice) duplicates. Race-guard inside `customCreate` with a `Map<name, Promise<id>>` so concurrent calls dedupe in-process. Belt and suspenders.

6. **POST `/datacollection/` with `isStructured: true` + `schema` ignores the schema and inserts 10 phantom template rows.** This is the cloud bug that drove the entire 2-step minimal-POST + PUT-schema dance. Once cloud fix #1 in `2026-04-29-datastore-cloud-fixes.md` lands, you can do a single-call structured create and skip all the workaround code. Until then: minimal POST, then PUT.

7. **PUT `/datacollection/{id}/schema` accepts a narrower vocabulary than POST**. Rejects `text`, `datetime`, `enum`, `string[]`. Requires `nextFieldId` counter. Requires `f_N`-style field IDs (we proved this empirically). Sanitization map: `text→string`, `datetime→string`, `enum→select` (with `options` from `values`), drop `string[]` entirely, give every field a sequential `f_<N>` id, set `nextFieldId: <N+1>`. Until cloud fix #2 lands, every structured create needs this translation step.

8. **`POST /memory/items` honors caller-supplied `key` field**. Use this. It's the only structured-row write path that lets us keep `<filename>` = `<row.key>` = `<conversations subfolder name>` semantically aligned.

9. **`POST /datacollection/import-csv` does NOT honor caller keys** — it always assigns `csv-import-<ts>-<rand>-<idx>`. This is what blew up the original "create + populate atomically" approach. Don't go there again unless cloud fix #4 lands. `/memory/items` per-row is fine.

### Code worth keeping (cherry-pick after fresh start)

These pieces work and are integration-tested. Worth pulling forward verbatim:

- **`integration_tests/datastore-create-no-template.test.ts`** — proves the auto-template bug, all 5 variations. After cloud fix #1, this file becomes a regression guard (flip the `toBeGreaterThan(0)` assertions back to `toBe(0)`).
- **`integration_tests/datastore-import-csv.test.ts::CONCURRENT CREATE`** — demonstrates the race in #5. Keep as a regression guard for the StrictMode fix.
- **`integration_tests/utils/pinkfish-api.ts`** — `createCollection`, `deleteCollection`, `listDatastoreItems`, `putCollectionSchema`, `importCsv`, `fetchImportStatus`. Solid base for any future API work.
- **`src/lib/useOnceEffect.ts`** — generic, useful beyond this PR.
- **`src/shell/entityRouting.ts::readField` + `readFieldArray`** — schema-aware lookups. Worth keeping for any UI surface that reads structured rows. Handles both semantic IDs and label-based fallback.
- **The CLAUDE.md hash-guard pattern** in `src/lib/skillsSync.ts` — `sha256Hex` + `claude-md-hash` sentinel + skip-on-divergence. Carries over to any other admin-editable bundled file.
- **The 12 seed files in `scripts/openit-plugin/seed/{tickets,people,knowledge}/`** plus the conversation seeds — content is fine, just re-route them however the new layout needs.

### Suggested implementation order for the rewrite

If the cloud fixes are in:

1. Bundle the seed files (move/keep what's there).
2. Wire seed routes in skillsSync (the `routeFile` extension is small).
3. Build `seedDriver` with the per-target gate (folder-empty AND cloud-missing). Pure logic, easy to unit-test.
4. Add `openit-conversations` (unstructured) and `openit-tickets`/`openit-people` (structured with rich schemas) to `DEFAULT_DATASTORES`. With cloud fix #1, the standard `buildCreateBody` is enough — no `customCreate` needed.
5. `useOnceEffect` on the startup effect.
6. Schema-aware `readField` on the people / tickets cards.
7. Drop the `databases/conversations/` exclusion in FileExplorer + `SYSTEM_FOLDERS`.
8. Test scenarios A–J from this doc end-to-end.

If the cloud fixes aren't in yet:

1. All of the above, but add the `customCreate` 2-step + `sanitizeSchemaForPut` helper. It's ~80 LOC, well-isolated. Mark it deletable post-fix.
2. Custom adapter for `openit-conversations` since the standard adapter assumes flat layout. ~150 LOC.

### What NOT to do (lessons from the failed branch)

- **Don't use `import-csv` for structured create.** It overrides keys and the resulting collection's row IDs don't match local filenames. We tried this for half a day; it's a dead end until cloud fix #4.
- **Don't try to make the engine's auto-create body smart enough to dodge the auto-template.** It can't — the cloud applies the template based purely on `isStructured + schema` presence in POST. Workaround is necessarily 2-step or unstructured.
- **Don't flatten the conversations local layout** to make engine sync easier. It breaks `intake.rs`, the slack listener, the conversation-thread viewer, and several Viewer click handlers. The custom adapter is less code than the cascade of writer changes.
- **Don't try to detect "we already started" in the engine itself.** The engine is shared; per-instance start guards belong in App.tsx.
- **Don't trust 'this is rendered fine in Table view' for Cards view.** Table iterates the schema and looks up by `field.id`; Cards code historically hardcodes semantic IDs. Different code paths, both need schema-awareness.

### Open questions for the rewrite

- **Conversation row keys**: `<msgId>` alone (ticketId in content) or `<ticketId>__<msgId>` composite? Composite simplifies cloud-side filtering by ticket; bare msgId keeps cloud rows symmetric across all collection types. Recommendation: composite, because the conversation viewer pulls "all messages for ticket X" and a key-prefix filter on cloud beats fetching everything and content-filtering.
- **Schema source of truth on roundtrip**: do we keep our bundled schema canonical (and treat cloud schema as opaque) or accept that cloud's `f_N`-rewritten schema becomes the truth after first sync? Recommendation: keep bundled canonical, store cloud's view in `.openit/cloud-schema-cache/` if needed for diff/conflict UI.
- **Seed data versioning**: today the bundle has a fixed seed. If we ever change a sample (typo fix, new field), do we re-seed for users who deleted the old version? Recommendation: never re-seed once any user activity has touched the target folder. Current per-target empty-folder gate already enforces this.
