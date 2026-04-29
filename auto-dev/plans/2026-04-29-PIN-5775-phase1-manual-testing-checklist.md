# PIN-5775: Phase 1 — Manual Testing Checklist

**Branch:** `ben/pin-5775-phase1-filestore-local-first`
**Date:** 2026-04-29
**Purpose:** Verify the 7 manual scenarios before merge

## Setup

Before starting any scenario, ensure:
1. You have clean dev20 credentials (test org)
2. Tauri dev server is running: `npm run tauri dev`
3. Console/DevTools are open (`View` → `Developer` → `Toggle DevTools`)
4. You can inspect the `.openit/` folder and `~/OpenIT/` directory structure

---

## Scenario MS-1: Fresh install → opens ~/OpenIT/local/

**Precondition:** No `~/OpenIT/` directory; first-time user.

**Steps:**
1. Delete `~/OpenIT/` if it exists: `rm -rf ~/OpenIT/`
2. Start the app: `npm run tauri dev`
3. Watch the initial bootstrap

**Expected:**
- App opens to a blank state
- Folder `~/OpenIT/local/` is created with standard subdirs:
  - `filestores/library/` (empty)
  - `filestores/attachments/` (empty)
  - `.openit/` (contains `state.json`, no `cloud.json` yet)
- DevTools log shows `[filestoreSync] start – {repo: "/Users/benrigby/OpenIT/local"}`

**Pass/Fail:** ☐ Pass | ☐ Fail
**Notes:**

---

## Scenario MS-2: Click connect, complete OAuth. Same folder bound, .openit/cloud.json written

**Precondition:** MS-1 passed, app is running local-only.

**Steps:**
1. Click "Connect to Pinkfish" button
2. Complete OAuth flow (may open browser, or inline modal)
3. Watch the app after connect completes

**Expected:**
- App stays in the same folder: `~/OpenIT/local/` (no switch to `/OpenIT/<orgId>/`)
- `.openit/cloud.json` is created with:
  ```json
  {
    "orgId": "653713545258",
    "orgName": "dev20",
    "connectedAt": "2026-04-29T...",
    "lastSyncAt": null
  }
  ```
- DevTools shows `[filestoreSync] start` log for the same repo path
- Sync UI shows the bound org name ("dev20" or whatever your test org is)
- No duplicate collection creation attempts in logs

**Pass/Fail:** ☐ Pass | ☐ Fail
**Notes:**

---

## Scenario MS-3: Pre-existing openit-library on remote with files. Connect → pull down.

**Precondition:** 
- Clean state (no `~/OpenIT/local/`)
- Pre-populate remote with a test file in `openit-library`:
  - Log into dashboard or use API to create collection `openit-library` if it doesn't exist
  - Upload a test file (e.g., `test-file.txt`) to it

**Steps:**
1. Start fresh app: `npm run tauri dev`
2. Click "Connect to Pinkfish"
3. Complete OAuth
4. Wait for sync to complete (check DevTools for `[filestoreSync] ✓` log)

**Expected:**
- App creates `~/OpenIT/local/` with standard subdirs
- `filestores/library/test-file.txt` is pulled down from remote
- `.openit/fs-state.json` shows the file with `remote_version` set
- DevTools shows collection resolution and pull logs

**Pass/Fail:** ☐ Pass | ☐ Fail
**Notes:**

---

## Scenario MS-4: No openit-* on remote. Connect with local files → openit-library created; files pushed up.

**Precondition:**
- Clean state (no `~/OpenIT/local/`)
- Clean remote (no `openit-*` collections, or delete them first)
- Pre-populate local files before connect:
  - Create `~/OpenIT/local/filestores/library/local-file.txt` with some content
  - Create `~/OpenIT/local/.openit/` directory structure

**Steps:**
1. Manually create the local file structure before starting the app
2. Start app: `npm run tauri dev`
3. Click "Connect to Pinkfish"
4. Complete OAuth
5. Wait for sync (check DevTools for creation + push logs)

**Expected:**
- Remote collection `openit-library` is created automatically
- `local-file.txt` is pushed up to the remote collection
- `.openit/fs-state.json` shows the file with `remote_version` set
- DevTools shows auto-create log: `[filestoreSync] Creating remote collection openit-library...`

**Pass/Fail:** ☐ Pass | ☐ Fail
**Notes:**

---

## Scenario MS-5: Mixed remote (openit-library + unrelated collections). Unrelated untouched; openit-library reconciles.

**Precondition:**
- Clean local state (`~/OpenIT/local/` with empty `filestores/`)
- Remote has:
  - `openit-library` with a test file
  - Unrelated collections (e.g., `customer-data`, `my-docs`, etc.) — existing ones from dashboard

**Steps:**
1. Start app: `npm run tauri dev`
2. Click "Connect to Pinkfish"
3. Complete OAuth
4. Wait for sync

**Expected:**
- Only `openit-library` is resolved and synced (file pulled down)
- Unrelated collections are NOT touched, NOT listed in logs, NOT synced
- `.openit/fs-state.json` contains only the one `openit-library` collection
- DevTools resolver log shows filtering: `[filestore] Found X filestore collections, Y with openit-* prefix`
- Unrelated collections not mentioned in sync logs

**Pass/Fail:** ☐ Pass | ☐ Fail
**Notes:**

---

## Scenario MS-6: Reconnect (same orgId, cloud.json present) → no folder switch, sync restarts immediately.

**Precondition:** MS-2 passed with `cloud.json` present.

**Steps:**
1. App is running, connected, bound to `~/OpenIT/local/`
2. Kill the app (or simulate by closing the window)
3. Restart: `npm run tauri dev`
4. App should restart automatically without user intervention

**Expected:**
- App reads `cloud.json` from `~/OpenIT/local/.openit/`
- Folder stays `~/OpenIT/local/` (no switch)
- Sync starts immediately without prompting for credentials or org selection
- DevTools shows `[app] startup state` with `hasCreds: true` and no re-bind attempt

**Pass/Fail:** ☐ Pass | ☐ Fail
**Notes:**

---

## Scenario MS-7: App relaunch with cloud.json present, verify binding is read and sync restarts.

**Precondition:** Same as MS-6 (cloud.json present from prior connection).

**Steps:**
1. Close app completely
2. Restart: `npm run tauri dev`
3. Observe startup logs

**Expected:**
- `cloud.json` is read from `~./OpenIT/local/.openit/cloud.json`
- `orgId` and `orgName` from the binding are used to initialize the sync
- Sync engines start without re-binding or folder switch
- DevTools log shows: `[filestoreSync] start – {repo: "/Users/benrigby/OpenIT/local"}` (same folder)
- No "connecting" modal appears unless creds expired

**Pass/Fail:** ☐ Pass | ☐ Fail
**Notes:**

---

## Summary

| Scenario | Status | Notes |
|----------|--------|-------|
| MS-1 (Fresh) | ☐ | |
| MS-2 (Connect) | ☐ | |
| MS-3 (Remote file pull) | ☐ | |
| MS-4 (Local file push) | ☐ | |
| MS-5 (Mixed collections) | ☐ | |
| MS-6 (Reconnect) | ☐ | |
| MS-7 (Relaunch) | ☐ | |

**Overall Result:** ☐ All Pass | ☐ Some Fail (see notes)

---

## Debugging Tips

- **DevTools Console:** Look for `[filestoreSync]` logs to see resolver, auto-create, and sync flow
- **File System:** Check `~/OpenIT/local/.openit/cloud.json` and `~openit/fs-state.json` (pretty-print with `cat <file> | jq .`)
- **Folder Structure:** Use `tree ~/OpenIT/local/` (or `find ~/OpenIT/local -type f` on macOS without tree)
- **Remote Dashboard:** Log into the test org's dashboard to verify collections were created and files uploaded
- **Logs Capture:** If a scenario fails, screenshot the DevTools console and the folder state for the PR description
