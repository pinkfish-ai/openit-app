# PIN-5847: Filestore + KB upload via `/upload-request` signed URL — Implementation plan

**Ticket:** [PIN-5847](https://linear.app/pinkfish/issue/PIN-5847/filestore-kb-sync-accumulates-uuid-prefixed-duplicates-on-every-push)
**Date:** 2026-04-30
**Repo:** `openit-app` (primary)
**References:** `/firebase-helpers` (the two upload endpoints), `/web` (no plugin-script change here)
**Predecessor:** PIN-5827 (kept local filenames clean via `cloud_filename` indirection — superseded by this plan, which removes the indirection entirely)

---

## 1. Technical investigation

### Symptom

Every `Sync` click against a connected cloud accumulates a UUID-prefixed copy of every pushed file. After three clicks against the same unchanged `hello-world.md`, both the cloud collection and the local working tree contain four files: `hello-world.md` plus three `<uuid>-hello-world.md` siblings. KB and all four filestore variants (library, skills, scripts, attachments) are affected. Datastore push is unaffected.

### Root cause — confirmed by integration test

The Tauri backend uploads via multipart `POST /filestorage/items/upload` (`src-tauri/src/kb.rs:303-307`). The integration test at `integration_tests/filename-diag.test.ts` uploads `hello-world.mjs` three times in a row and observes:

- Upload 1 → `2ee5fdf7-6335-4063-a7d5-269a0c347b32-hello-world.mjs`
- Upload 2 → `a9468af9-6b47-43e9-bf9d-41d96ffb4023-hello-world.mjs`
- Upload 3 → `cbf46a98-4e36-447f-acfc-3bf1cebbb810-hello-world.mjs`

Three distinct ids, three distinct UUID-prefixed filenames, three Firestore docs. The `/upload` endpoint does not dedupe by filename and rewrites the name with a fresh UUID on every call.

The pull then writes those UUID-prefixed remote files to disk because the manifest is keyed by the local filename (or a single `cloud_filename` value that only maps the most recent upload), so all but one remote item is treated as new on every poll.

### The right endpoint already exists

`POST /filestorage/items/upload-request` (file-storage.controller.ts:366) takes JSON `{filename, content_type, size_prelim, metadata}` and returns:

- `id` — server-generated Firestore doc id
- `filename` — sanitized via `formatFileName` (spaces → hyphens, no UUID)
- `uploadUrl` — signed GCS PUT URL valid for ~15 min
- `filepath` — `file-storage/<collectionId>/<filename>`

Server-side flow (`file-storage.controller.ts:405-484`):
1. Sanitize filename via `formatFileName`.
2. Look up an existing Firestore doc with the same `filename` + `collectionId`.
3. If found → reuse its id (overwrite existing). If not → create.
4. Issue signed PUT URL for `file-storage/<collectionId>/<sanitized-filename>`.
5. Client PUTs bytes directly to GCS, which overwrites the same object key.

Same name → same GCS path → same Firestore doc. The "overwrite when name is same" rule is already wired; we just need to use this endpoint.

Verified live: uploading `Screenshot 2026-04-30 at 2.08.55 PM.png` returned `Screenshot-2026-04-30-at-2.08.55-PM.png` (no UUID), and re-listing the collection showed exactly one row.

### Why the existing `cloud_filename` indirection doesn't save us

PIN-5827 added `cloud_filename` to the filestore manifest so a UUID-prefixed remote name could map back to a clean local name on pull. But each multipart push still creates a new server item with a new UUID, so the manifest's `cloud_filename` only ever bridges the most recent upload — the older UUID-prefixed remote rows fall through `cloudToLocal.get(...) ?? cloudFilename` and pull treats them as fresh items (`src/lib/entities/filestore.ts:92-102`). The indirection becomes load-bearing for the mismatch, but doesn't prevent accumulation. KB never had the indirection at all (`src/lib/entities/kb.ts:88-95`), which is why the screenshot showed it growing fastest there.

### Cross-repo reach

- Pure client-side change. `/upload-request` already lives on the server unchanged.
- `scripts/openit-plugin/` is not touched, so no `/web` mirror step.
- No generated client regen needed — we hand-write the new Tauri commands directly.

---

## 2. Proposed solution

### Approach

Adopt the three-rule contract for **filestore only**:

1. **Upload using local filename** — push sends the file's on-disk name as-is.
2. **Download using remote filename** — pull writes whatever the server returns.
3. **Overwrite when name is same** — `/upload-request` + signed PUT does this server-side.

That collapses the filestore manifest to `{ filename → { remote_version, pulled_at_mtime_ms } }`. No `cloud_filename` field, no reverse map, no rename.

**KB stays on the multipart `/upload` endpoint.** That path runs the vector-store indexing pipeline (`uploadFilesToVectorStore`) which the signed-PUT path skips — switching KB to `/upload-request` would store articles in GCS without indexing them, so KB search would silently break. The KB UUID-prefix issue still exists and is tracked as a separate server-side fix; this PR doesn't try to address KB push semantics. Existing KB UUID duplicates can still be cleaned up by the cleanup script (it walks `knowledge-bases/default/` too).

### Files to modify

| File | Change |
| --- | --- |
| `src-tauri/src/kb.rs` | New `kb_upload_via_signed_url` and `fs_store_upload_via_signed_url` commands: POST `/filestorage/items/upload-request` with JSON body, then PUT bytes to the returned `uploadUrl`. Old multipart commands (`kb_upload_file`, `fs_store_upload_file`) stay registered — KB push still uses multipart for vector-store indexing. |
| `src-tauri/src/lib.rs` | Register the two new Tauri commands. |
| `src/lib/api.ts` | New `kbUploadFileSigned` / `fsStoreUploadFileSigned` TS bindings. `cloud_filename` field on `KbFileState` kept but documented as legacy (so existing on-disk manifests deserialize cleanly). |
| `src/lib/filestoreSync.ts` | Switch `pushAllToFilestoreImpl` to `fsStoreUploadFileSigned`. Drop the `cloud_filename` capture and the post-push `kbListRemote` reconcile. Add `commitTouched` after manifest save so freshly-pushed files don't false-fire as untracked on the next Sync. |
| `src/lib/kbSync.ts` | **No behavior change** — KB stays on `kbUploadFile` (multipart). Only the inline comment is updated to record why. |
| `src/lib/entities/filestore.ts` | Drop the `cloudToLocal` reverse map. Remote filename → manifestKey verbatim. |
| `src/lib/syncEngine.ts` | Drop the three `cloud_filename` carry-through spreads (re-fetch, fast-forward, conflict-clear). Field is no longer set anywhere, so the carries are dead code. JSDoc on `EntityAdapter.listRemote` updated. |
| `src/lib/syncEngine.test.ts` | Two PIN-5827 carry-through tests inverted: now assert `cloud_filename` is dropped (not preserved) on fast-forward and re-fetch. |
| `src/lib/entities/filestore.test.ts` | "maps cloud_filename → local filename" test inverted to "uses verbatim remote filename as manifestKey". |
| `integration_tests/upload-request-contract.test.ts` (renamed from `filename-diag.test.ts`) | Diagnostic logs replaced with assertions: clean filename round-trip, three same-name uploads → 1 row, all three uploads return the same id. |
| `integration_tests/utils/pinkfish-api.ts` | New `uploadFilestoreFileSigned` helper for the contract test. |
| `scripts/cleanup-uuid-duplicates.mjs` (new) | One-shot cleanup. Walks `filestores/{library,attachments,skills,scripts}/` and `knowledge-bases/default/`. For each `<uuid>-<rest>` row with a `<rest>` sibling: deletes the duplicate locally, calls `DELETE /filestorage/items/<id>` for the remote row. Dry-run by default (`--apply` to actually delete). Skips orphan UUID files (no canonical sibling) — manual rename required. |

### Unit tests

| File | Test |
| --- | --- |
| `src/lib/filestoreSync.ts` | New: pushing the same file twice without local edits results in exactly one upload call (mtime-equal + tracked → skip). |
| `src/lib/kbSync.ts` | Same as above for KB. |
| `src/lib/entities/filestore.ts` | Update existing `listRemote` test to drop the `cloud_filename` reverse-map case; assert remote filename is used verbatim. |
| `src/lib/nestedManifest.ts` | Test that loading an old manifest with `cloud_filename` set doesn't crash and the field is silently dropped on next save. |
| `integration_tests/upload-request-contract.test.ts` | (renamed diag) Assert: (a) `/upload-request` returns clean filename, (b) three same-name uploads → 1 list row, (c) GCS PUT with bytes succeeds and the file is retrievable via the list endpoint's signed URL. |

No test for the new Tauri command directly — it's a thin HTTP wrapper, exercised via the integration test path end-to-end.

### Manual scenarios

1. **Clean-slate populate-then-connect**: clean slate → "Create sample dataset" → connect to cloud → click Sync. Expected: cloud has exactly the 22 sample files, no UUID-prefixed names. Re-click Sync 3 more times. Expected: list count unchanged, no new local files.
2. **Edit and push**: edit a KB article locally, click Sync. Expected: cloud row's content updates, count stays at 1.
3. **Pull existing duplicates**: on a repo that already has UUID-prefixed siblings, run the cleanup script. Expected: prefixed files removed locally, remote duplicates deleted, canonical files untouched.
4. **Multi-collection**: push files into all four filestores (library/skills/scripts/attachments) plus KB. Expected: each collection ends up with exactly one row per local file.
5. **Round-trip across machines**: push from machine A, pull on machine B. Expected: B's working tree has exactly the same filenames as A.

---

## 3. Implementation checklist

### Step 1 — Foundation

Land the new upload primitive end-to-end. The rest of the plan rebases on this.

- [ ] Add `kb_upload_via_signed_url` Tauri command in `src-tauri/src/kb.rs` (POST /upload-request, PUT bytes to signed URL).
- [ ] Add `kbUploadFileSigned` TS binding in `src/lib/api.ts`.
- [ ] Standalone integration test asserting clean filename round-trip + same-name overwrite.

### Step 2 — Switch the sync engines

Cut over to the new primitive and delete the workarounds.

- [ ] Replace multipart upload in `kbSync.ts::pushAllToKbImpl` with the signed call.
- [ ] Replace multipart upload in `filestoreSync.ts::pushAllToFilestoreImpl` with the signed call.
- [ ] Drop `cloud_filename` machinery from `entities/filestore.ts` (reverse map) and `filestoreSync.ts` (capture + reconcile).
- [ ] Drop the `kbListRemote` post-push reconcile from `kbSync.ts` (no longer needed).
- [ ] Add `commitTouched` post-push to `filestoreSync.ts` (mirror what KB has at line 266-270).
- [ ] Update `nestedManifest.ts` `TrackedFile` type — drop `cloud_filename`, ignore on legacy load.

### Step 3 — Cleanup

The world doesn't reset on its own. Provide a tool for repos that already accumulated duplicates.

- [ ] Write `scripts/cleanup-uuid-duplicates.mjs` (local + remote).
- [ ] Document run instructions in `auto-dev/plans/2026-04-30-PIN-5847-upload-request-signed-url-plan.md` (this file) under "Migration".
- [ ] Run cleanup on the dev `~/OpenIT/local` to verify it removes the existing duplicates without losing data.

### Step 4 — Tests + manual sign-off

- [ ] vitest run — full suite green, including the new signed-upload tests.
- [ ] cargo test — Rust side green.
- [ ] Manual scenarios 1–5 above.
- [ ] Linear comment on PIN-5847 with results.

### Step 5 — Stop. Engineer review and approval before stage 03.

---

## Migration

For repos with accumulated duplicates:

```bash
# From ~/OpenIT/local (or whatever your repo is)
node ~/Documents/GitHub/openit-app/scripts/cleanup-uuid-duplicates.mjs
```

The script:
1. Walks the four filestore subdirs + the KB default folder.
2. Identifies files matching `<32-hex-with-dashes>-<rest>` where a sibling `<rest>` exists locally with matching content.
3. Deletes the prefixed local file (uncommitted) and the corresponding remote row (`DELETE /filestorage/items/<id>`).
4. Logs each action; idempotent.

If the canonical file does NOT exist (i.e. the repo only has the UUID-prefixed copy), the script keeps the prefixed file and warns — manual rename is required since we can't safely auto-pick which UUID copy is canonical.

---

## A note on minimalism

This plan deletes more code than it adds. The `cloud_filename` indirection, the post-push reconciles in both push impls, and the reverse map in the filestore adapter all go away once we trust the server's `/upload-request` contract. The whole sync stack collapses to "push your filename, pull whatever name comes back, manifest by filename."
