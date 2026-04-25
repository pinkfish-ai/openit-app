# PIN-5707: OpenIT — Datastores, Agents, Workflows, Filestores, Rich Viewers + KB File Filtering

**Ticket:** [PIN-5707](https://linear.app/pinkfish/issue/PIN-5707)
**Date:** 2026-04-24
**Prerequisite:** M0–M2 + KB sync already shipped (PRs #1–#6)

---

## Context

OpenIT currently syncs a single Pinkfish KB collection (named `openit-<slug>`) to a local `knowledge-base/` folder. This plan extends the same prefix-based auto-discovery pattern to five more resource types: **datastores** (with table view), **agents**, **workflows**, **filestores**, and adds **rich file viewers** (images, PDFs, Office docs). It also adds KB file-type filtering and adopts the same TypeSpec → OpenAPI → TypeScript client generation pipeline used by the web project.

**Discovery rule (applies to ALL entity types):** List all entities matching the `openit-` name prefix and show them in the explorer. The user (or Claude) may create additional `openit-*` entities at any time — OpenIT always shows every match, not just the defaults it created.

**Default datastores:** If no datastores with the `openit-` prefix exist, auto-create two:

| Name | Template ID | Purpose |
|---|---|---|
| `openit-tickets` | `case-management` | IT ticket tracking (Case Number, Subject, Status, Priority, etc.) |
| `openit-people` | `contacts` | Contact/people directory |

---

## File Explorer Layout (target)

```
README.md
▾ knowledge-base/          ← existing KB sync (now with file-type filtering)
▾ filestore/                ← NEW — same sync pattern as KB
    doc1.pdf
▾ databases/                ← NEW — virtual folder, not on disk
  ▾ openit-tickets/         ← auto-created (case-management template)
      CS0001237.json        ← first 100 rows as virtual files
      CS0001241.json
      [ Load more ]         ← button if >100 rows
  ▾ openit-people/          ← auto-created (contacts template)
      John Smith.json
▾ agents/                   ← NEW — virtual folder
    IT Support Agent.json   ← one entry per openit-* agent
▾ workflows/                ← NEW — virtual folder
    Daily Ticket Triage.json  ← one entry per openit-* workflow
```

## Viewer Behavior

| Click target | Viewer shows |
|---|---|
| Database **collection folder** | Full table view (all columns from schema, rows in table) |
| Database **row file** | Raw JSON (default) + **Table** tab showing single-row table |
| Agent entry | Agent summary (name, description, instructions, connections, resources) |
| Workflow entry | Workflow summary (name, description, inputs, connections, resources — same as web workflow main page) |
| Filestore file | Same as KB — rendered/raw toggle for md, raw for everything else |
| **Image** (jpg/png/gif/webp) | Inline `<img>` with zoom/fit controls |
| **PDF** | Rendered pages via `react-pdf` with page navigation |
| **Word** (docx) | Rendered via Office Online iframe (`view.officeapps.live.com`) |
| **Excel** (xlsx) | Client-side parsed via ExcelJS, rendered as table with sheet tabs |
| **PowerPoint** (pptx) | Rendered via Office Online iframe |
| **Text/code** | Syntax-highlighted raw text |

---

## Implementation Steps

### Step 1: Tauri HTTP plugin + generated API clients

**Goal:** Use the same TypeSpec → OpenAPI → TypeScript client pipeline as the web project, so OpenIT shares the same typed API surface.

**1a. Install Tauri HTTP plugin** (bypasses WebView CORS):
```bash
# JS side
npm install @tauri-apps/plugin-http
# Rust side (Cargo.toml)
tauri-plugin-http = "2"
```
Register in `src-tauri/src/lib.rs` via `.plugin(tauri_plugin_http::init())`. Add HTTP permissions in `src-tauri/capabilities/default.json` for `skills.pinkfish.ai`, `skills-stage.pinkfish.ai`, `mcp.*.pinkfish.*`, `proxy.pinkfish.ai`.

**1b. Generate TypeScript API clients:**
- Add `scripts/generate-api.sh` — same flow as `web/scripts/generate-typescript-api.sh`
- Source: TypeSpec in `../firebase-helpers/spec/` (datacollection, memory APIs live here)
- Output: `src/api/generated/firebase-helpers/` — same structure as web
- Uses `@openapitools/openapi-generator-cli` (dev dependency)
- Override the generated `runtime.ts` fetchApi to use `@tauri-apps/plugin-http`'s `fetch()`

**1c. Custom fetch adapter** (`src/api/fetchAdapter.ts`):
```typescript
import { fetch } from "@tauri-apps/plugin-http";
// Wraps Tauri's CORS-free fetch with the auth headers:
//   - Auth-Token: Bearer <jwt>  (for skills.pinkfish.ai)
//   - Authorization: Bearer <jwt> (for MCP/platform)
// Configured as the fetchApi in the generated Configuration
```

This gives us typed clients for `DataCollectionsApi`, `MemoryApi` — matching the web project exactly.

**Existing Rust HTTP commands** (`kb.rs`, `pinkfish.rs`) stay as-is for now — refactoring them to the plugin is a follow-up.

**Files:**
- `src-tauri/src/lib.rs` (register HTTP plugin)
- `src-tauri/Cargo.toml` (add `tauri-plugin-http`)
- `src-tauri/capabilities/default.json` (HTTP permissions)
- `scripts/generate-api.sh` (new)
- `src/api/generated/firebase-helpers/` (new, generated)
- `src/api/fetchAdapter.ts` (new)
- `package.json` (add @tauri-apps/plugin-http, openapi-generator-cli, generate script)

### Step 2: TypeScript API wrappers (thin layer over generated clients)

**New file: `src/lib/skillsApi.ts`**

Thin convenience layer over the generated `DataCollectionsApi` and `MemoryApi`:

```typescript
import { DataCollectionsApi, MemoryApi, Configuration } from "../api/generated/firebase-helpers";
import { makeConfig } from "../api/fetchAdapter";

export function getCollectionsApi(accessToken: string, skillsBaseUrl: string): DataCollectionsApi
export function getMemoryApi(accessToken: string, skillsBaseUrl: string): MemoryApi
```

### Step 3: Resource resolver modules

**New file: `src/lib/datastoreSync.ts`**

Mirrors the pattern in `src/lib/kb.ts` (`resolveProjectKb`):

```typescript
// List all Datastore-type collections, filter by openit-* prefix
// If none found, auto-create two:
//   { name: "openit-tickets", type: "datastore", isStructured: true, templateId: "case-management" }
//   { name: "openit-people",  type: "datastore", isStructured: true, templateId: "contacts" }
export async function resolveProjectDatastores(creds): Promise<DcCollection[]>

// List items for a collection with pagination
export async function listDatastoreItems(creds, collectionId, limit, offset): Promise<DcItemsResponse>
```

**New file: `src/lib/filestoreSync.ts`**

Same pattern as `kbSync.ts` but for Filestorage collections:

```typescript
// Mirrors kbSync: resolves openit-* filestores, pulls files to local filestore/ folder
export async function startFilestoreSync(args): Promise<void>
export async function stopFilestoreSync(): void
export function subscribeFilestoreSync(fn): () => void
```

Reuses existing `kb.rs` Rust commands (`kb_list_remote`, `kb_download_to_local`, `kb_upload_file`) since filestores use the same filestorage API — just pass the filestore collection ID instead of KB collection ID. The `kb_init`/`kb_list_local` etc. need parallel versions that use `filestore/` instead of `knowledge-base/` as the local dir.

**New file: `src/lib/agentSync.ts`**

```typescript
// List agents via MCP call (reuses existing pinkfishMcpCall), filter by openit-* prefix
export async function resolveProjectAgents(creds): Promise<Agent[]>
```

**New file: `src/lib/workflowSync.ts`**

```typescript
// List workflows via platform API (GET /agent-workflows), filter by openit-* prefix
// Workflow shape: { id, name, description, triggers, inputs }
export async function resolveProjectWorkflows(creds): Promise<Workflow[]>
```

Uses the generated platform API client (`AgentWorkflowsApi`) or falls back to `pinkfishMcpCall`.

### Step 4: File Explorer — virtual resource nodes

**Modified file: `src/shell/FileExplorer.tsx`**

Add three virtual folder sections below the real file tree:

- **`databases/`** — one child folder per resolved datastore. Under each folder, render first 100 rows as `<key>.json` entries. "Load more" button at bottom if `hasNextPage`.
- **`agents/`** — one entry per resolved agent.
- **`workflows/`** — one entry per resolved workflow.
- **`filestore/`** — real directory (synced files), same pattern as `knowledge-base/`.

Virtual nodes emit new ViewerSource kinds instead of file paths.

The explorer loads these on mount (and on auth changes) by calling the resolver modules from Step 3. Virtual folders are rendered after the real file tree, visually separated.

### Step 5: Viewer — table view + new source kinds

**Modified file: `src/shell/Viewer.tsx`**

Extend `ViewerSource` type:

```typescript
export type ViewerSource =
  | { kind: "file"; path: string }
  | { kind: "deploy"; lines: string[] }
  | { kind: "diff"; text: string }
  | { kind: "datastore-table"; collection: DcCollection; items: DcItem[]; hasMore: boolean }
  | { kind: "datastore-row"; collection: DcCollection; item: DcItem }
  | { kind: "agent"; agent: Agent }
  | { kind: "workflow"; workflow: Workflow }
  | null;
```

The existing `{ kind: "file" }` handler gains MIME-aware rendering (see Step 5b).

**New file: `src/shell/DataTable.tsx`**

Simple table component for structured datastore data:

- Renders column headers from `schema.fields[].label`
- Renders rows by parsing each item's `content` (JSON string) and extracting field values by `fields[].id` (e.g., `f_1`, `f_2`)
- Select-type fields render the value directly (read-only in OpenIT)
- Boolean fields render Yes/No
- Sortable by clicking column headers (client-side sort)
- Sticky header row
- "Load more" button calls `listDatastoreItems` with next offset

For `datastore-row` kind: same table component but with a single row, plus tabs: **Raw** (JSON) | **Table** (single-row table). Default to Raw.

For `datastore-table` kind: full table, no tabs.

For `workflow` kind: render a summary card showing name, description, inputs (with type badges), required connections, and resources — matching the web project's workflow main page layout.

### Step 5b: Rich file viewers

**Modified file: `src/shell/Viewer.tsx`**

The existing `kind: "file"` handler currently only knows markdown (rendered) vs raw text. Extend it to detect file type by extension and render accordingly:

| Extension | Renderer | Library |
|---|---|---|
| `.md`, `.mdx` | ReactMarkdown (existing) | `react-markdown` (already installed) |
| `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` | `<img>` tag with object-fit + zoom controls | Native |
| `.pdf` | `react-pdf` with page navigation | `react-pdf` (new dep) |
| `.docx`, `.pptx` | Office Online iframe (`view.officeapps.live.com/op/embed.aspx?src=<url>`) | Native iframe — requires a publicly accessible URL, so only works for files that have a signed URL from Pinkfish. For local-only files, fall back to raw/hex view with a "preview unavailable" message |
| `.xlsx` | ExcelJS client-side parse → table with sheet tabs | `exceljs` (new dep) |
| `.csv` | Parse and render as HTML table | Native (split by comma) |
| `.json` | Syntax-highlighted JSON with collapsible nodes | Native `<pre>` with formatting |
| Everything else | Raw text `<pre>` | Native |

**New file: `src/shell/viewers/ImageViewer.tsx`** — `<img>` with fit-to-pane + click-to-zoom
**New file: `src/shell/viewers/PdfViewer.tsx`** — `react-pdf` Document/Page with prev/next controls
**New file: `src/shell/viewers/SpreadsheetViewer.tsx`** — ExcelJS parse + table render with sheet tabs (also handles CSV)
**New file: `src/shell/viewers/OfficeViewer.tsx`** — iframe embed for docx/pptx (signed URL required)

The Viewer dispatches to the right sub-viewer based on extension. Binary files (images, PDFs, xlsx) are read via `fsReadBytes` (already exists in `api.ts`) and converted to object URLs or passed to the library.

### Step 6: Filestore Rust commands

**Modified file: `src-tauri/src/kb.rs`**

Add parallel commands for filestore local dir (`filestore/` instead of `knowledge-base/`):

```rust
const FS_DIR: &str = "filestore";
const FS_STATE_FILE: &str = ".openit/fs-state.json";

#[tauri::command] pub fn fs_store_init(repo: String) -> Result<String, String>
#[tauri::command] pub fn fs_store_list_local(repo: String) -> Result<Vec<KbLocalFile>, String>
#[tauri::command] pub fn fs_store_read_file(repo: String, filename: String) -> Result<String, String>
#[tauri::command] pub fn fs_store_write_file(repo: String, filename: String, content: String) -> Result<(), String>
#[tauri::command] pub fn fs_store_write_file_bytes(repo: String, filename: String, bytes: Vec<u8>) -> Result<(), String>
#[tauri::command] pub fn fs_store_state_load(repo: String) -> Result<KbState, String>
#[tauri::command] pub fn fs_store_state_save(repo: String, state: KbState) -> Result<(), String>
```

Same as `kb_*` commands but operating on `filestore/` and `.openit/fs-state.json`. Remote commands (`kb_list_remote`, `kb_download_to_local`, `kb_upload_file`) already take a `collection_id` param and can be reused.

### Step 7: KB file-type filtering

**Source of truth:** `firebase-helpers/functions/src/utils/llm-supported-types.ts`

The KB supports files that are either natively supported by an LLM or have an available preprocessor. Accepted extensions:

| Extension | MIME type | Source |
|---|---|---|
| `.pdf` | `application/pdf` | Native (Gemini, Claude) + preprocessor |
| `.txt` | `text/plain` | Native (Gemini) |
| `.md`, `.markdown` | `text/markdown` | Treated as text/plain |
| `.json` | `application/json` | Passthrough |
| `.csv` | `text/csv` | Preprocessor |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Preprocessor |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | Preprocessor |
| `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | Preprocessor |
| `.jpg`, `.jpeg` | `image/jpeg` | Native (Gemini, Claude, GPT) |
| `.png` | `image/png` | Native (Gemini, Claude, GPT) |
| `.gif` | `image/gif` | Native (Claude) |
| `.webp` | `image/webp` | Native (Gemini, Claude) |

**Where to filter:**

1. **Drag-and-drop handler** in `FileExplorer.tsx` (`onDrop`) — reject files with unsupported extensions, show a toast/inline message listing what was skipped and why.
2. **`kb.rs` Rust side** — add an `is_kb_supported(filename)` check in `kb_write_file` and `kb_write_file_bytes` as a safety net. Return an error string listing supported extensions if rejected.
3. **`kbSync.ts` push path** — skip unsupported files during `pushAllToKb` so they aren't uploaded even if they end up in the local `knowledge-base/` folder.

### Step 8: Wire into App.tsx

**Modified file: `src/App.tsx`**

On startup / after auth, alongside `startKbSync`:
- Call `startFilestoreSync` (same pattern as KB)
- Datastore and agent resolution happens lazily in the FileExplorer (not polling-based — fetched once on mount, refreshable)

### Step 9: Update Shell.tsx

**Modified file: `src/shell/Shell.tsx`**

The `onSelect` from FileExplorer expands from `(path: string) => void` to `(source: ViewerSource) => void` to handle virtual nodes.

---

## Files Summary

| File | Action |
|---|---|
| `src-tauri/Cargo.toml` | **Modify** — add `tauri-plugin-http` |
| `src-tauri/src/lib.rs` | **Modify** — register HTTP plugin + new filestore commands |
| `src-tauri/capabilities/default.json` | **Modify** — add HTTP permissions |
| `src-tauri/src/kb.rs` | **Modify** — add `fs_store_*` commands + `is_kb_supported` filter |
| `scripts/generate-api.sh` | **New** — TypeSpec → OpenAPI → TypeScript generation script |
| `src/api/generated/firebase-helpers/` | **New** — generated API clients |
| `src/api/fetchAdapter.ts` | **New** — Tauri HTTP plugin fetch wrapper with auth headers |
| `src/lib/skillsApi.ts` | **New** — convenience layer over generated clients |
| `src/lib/datastoreSync.ts` | **New** — resolve + list datastores by prefix, auto-create |
| `src/lib/filestoreSync.ts` | **New** — filestore sync (mirrors kbSync) |
| `src/lib/agentSync.ts` | **New** — resolve agents by prefix |
| `src/lib/workflowSync.ts` | **New** — resolve workflows by prefix |
| `src/shell/FileExplorer.tsx` | **Modify** — virtual folders + KB drop filter |
| `src/shell/Viewer.tsx` | **Modify** — new source kinds |
| `src/shell/DataTable.tsx` | **New** — table component for structured datastore |
| `src/shell/viewers/ImageViewer.tsx` | **New** — inline image with zoom |
| `src/shell/viewers/PdfViewer.tsx` | **New** — react-pdf page renderer |
| `src/shell/viewers/SpreadsheetViewer.tsx` | **New** — ExcelJS/CSV table renderer |
| `src/shell/viewers/OfficeViewer.tsx` | **New** — iframe embed for docx/pptx |
| `src/shell/Shell.tsx` | **Modify** — expanded onSelect callback |
| `src/App.tsx` | **Modify** — start filestore sync alongside KB |
| `src/lib/kbSync.ts` | **Modify** — skip unsupported files during push |
| `package.json` | **Modify** — add deps (plugin-http, openapi-generator-cli, react-pdf, exceljs) + generate script |

## Verification

1. `npm run tauri dev` — app launches
2. Connect Pinkfish creds → onboarding completes
3. File explorer shows `databases/`, `agents/`, `filestore/` sections
4. `databases/` auto-creates `openit-tickets` (case-management) and `openit-people` (contacts) if none exist with `openit-` prefix
5. Clicking a database collection folder → full table view in viewer with columns from schema
6. Clicking a row → raw JSON (default) with Table tab showing single-row table
7. "Load more" button works for >100 rows
8. `filestore/` syncs files same as KB (local `filestore/` dir ↔ Pinkfish filestore collection)
9. `agents/` lists all `openit-`-prefixed agents
10. `workflows/` lists all `openit-`-prefixed workflows, clicking shows summary card
11. Rich viewers: images render inline, PDFs show pages, xlsx renders as table
12. Dragging an unsupported file (e.g. `.exe`) into KB shows rejection message
13. Generated API types match the web project's generated types
