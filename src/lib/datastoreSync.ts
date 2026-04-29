// Datastore sync wrapper. Phase 3 of V2 sync (PIN-5779) collapsed the
// orchestrator-level machinery into the shared `createCollectionEntitySync`
// helper in `syncEngine.ts` — same one filestore + KB use. This file is
// now ~200 LOC of datastore-specific glue:
//
//   - The CollectionSyncConfig (REST type, default names, adapter
//     factory, datastore-specific create-body shape, local-folder
//     discovery for cloud auto-create, schema-write hook).
//   - The push impl (per-collection full reconcile — POST new, PUT
//     changed, DELETE missing, plus schema-push and local-side row
//     validation against `_schema.json`).
//   - Re-exports under the names call sites already use.
//
// Sibling: filestoreSync.ts and kbSync.ts use the same helper with
// their own configs.

import {
  datastoreListLocal,
  entityWriteFile,
  fsList,
  fsRead,
} from "./api";
import { loadCollectionManifest, saveCollectionManifest } from "./nestedManifest";
import {
  type CollectionSchema,
  type DataCollection,
  type MemoryBqueryResponse,
  type MemoryItem,
  fetchImportStatus,
  getCollection,
  importCsv,
} from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { makeSkillsFetch } from "../api/fetchAdapter";
import {
  DATASTORE_DIR_PREFIX,
  datastoreAdapter,
} from "./entities/datastore";
import { fetchDatastoreItems } from "./entities/datastoreApi";
import { validateRow } from "./datastoreSchema";
import {
  classifyAsShadow,
  createCollectionEntitySync,
  type CollectionSyncStatus,
  type DiscoveredCollection,
} from "./syncEngine";

const OPENIT_PREFIX = "openit-";

/// Hardcoded defaults — auto-created on connect when no `openit-*`
/// datastore exists yet. Both structured. The schema is bundled
/// locally in `scripts/openit-plugin/schemas/{tickets,people}._schema.json`
/// and synced to disk by `skillsSync` before this runs, so by the
/// time we create the cloud collection the local `_schema.json` is
/// already on disk and gets picked up via `discoverLocalDatastores`.
///
/// We deliberately do NOT pass a cloud `templateId` here — that would
/// have the cloud seed sample rows server-side. Sample rows are
/// instead bundled locally (`seed/tickets/`, `seed/people/`) and
/// pushed up through the normal sync path on first connect, which
/// keeps "what ships with OpenIT" wholly under our control.
///
/// Custom user-named datastores (created via dashboard OR by dropping
/// a folder under `databases/` locally) get auto-created via
/// `discoverLocalCollections` below.
const DEFAULT_DATASTORES = [
  {
    name: "openit-tickets",
    description: "IT ticket tracking",
  },
  {
    name: "openit-people",
    description: "Contact/people directory",
  },
] as const;

/// Local-only system folders under `databases/` that are NOT mirrored
/// to cloud. `conversations` is the existing one (chat thread logs).
const SYSTEM_FOLDERS = new Set(["conversations"]);

/// Strip the `openit-` prefix for display in the UI / log lines.
/// Returns the input unchanged when the prefix is absent.
export function displayDatastoreName(name: string): string {
  return name.startsWith(OPENIT_PREFIX) ? name.slice(OPENIT_PREFIX.length) : name;
}

export type DatastoreSyncStatus = CollectionSyncStatus<DataCollection>;

export type DatastoreConflict = {
  collectionName: string;
  key: string;
  reason: "local-and-remote-changed";
};

// ---------------------------------------------------------------------------
// Local-folder discovery
//
// Scans `${repo}/databases/` for subfolders not yet on cloud. Each one
// becomes a candidate for auto-create:
//   - If `_schema.json` is present and parses → STRUCTURED with that
//     schema.
//   - Else → UNSTRUCTURED.
//
// Skips system folders (today: `conversations`) and any folders whose
// `openit-<name>` form already matches an existing cloud collection.
// ---------------------------------------------------------------------------

async function discoverLocalDatastores(args: {
  repo: string;
  existingNames: Set<string>;
}): Promise<DiscoveredCollection[]> {
  const { repo, existingNames } = args;
  const databasesPath = `${repo}/${DATASTORE_DIR_PREFIX}`;

  let nodes;
  try {
    nodes = await fsList(databasesPath);
  } catch {
    // No `databases/` directory yet. That's fine — caller will handle
    // bootstrapping via the hardcoded defaults.
    return [];
  }

  // `fsList` walks recursively (depth 6), so `nodes` includes
  // grandchildren like `databases/tickets/<key>.json` and any nested
  // dir under an existing collection. Filter to DIRECT children of
  // `databases/` only — otherwise a subdir like
  // `databases/tickets/archived/` would pass the system-folder /
  // existing-names checks below and get auto-created on the cloud as
  // `openit-archived`. Same `directChildren` shape as Workbench.tsx.
  const databasesPrefix = `${databasesPath}/`;
  const directChildren = nodes.filter((n) => {
    if (!n.path.startsWith(databasesPrefix)) return false;
    const tail = n.path.slice(databasesPrefix.length);
    return tail.length > 0 && !tail.includes("/");
  });

  const out: DiscoveredCollection[] = [];
  for (const node of directChildren) {
    if (!node.is_dir) continue;
    const folderName = node.name;
    if (SYSTEM_FOLDERS.has(folderName)) continue;
    const cloudName = `${OPENIT_PREFIX}${folderName}`;
    if (existingNames.has(cloudName)) continue;

    // Look for `_schema.json` to decide structured vs unstructured.
    let schema: CollectionSchema | null = null;
    try {
      const raw = await fsRead(`${databasesPath}/${folderName}/_schema.json`);
      schema = JSON.parse(raw) as CollectionSchema;
    } catch {
      // Either no schema file or unparseable — treat as unstructured.
    }

    if (schema) {
      out.push({
        name: cloudName,
        body: {
          isStructured: true,
          schema,
        },
      });
    } else {
      out.push({
        name: cloudName,
        body: {
          isStructured: false,
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema bootstrap — fires once per `start()` after resolve+auto-create.
// Writes `_schema.json` per STRUCTURED collection (content-equality skip
// for already-current schemas).
// ---------------------------------------------------------------------------

async function writeStructuredSchemas(
  repo: string,
  collections: DataCollection[],
): Promise<void> {
  for (const col of collections) {
    if (!col.isStructured || !col.schema) continue;
    const folderName = displayDatastoreName(col.name);
    const subdir = `${DATASTORE_DIR_PREFIX}/${folderName}`;
    const content = JSON.stringify(col.schema, null, 2);
    const schemaPath = `${repo}/${subdir}/_schema.json`;
    let existing: string | null = null;
    try {
      existing = await fsRead(schemaPath);
    } catch {
      /* missing — write below */
    }
    if (existing !== content) {
      await entityWriteFile(repo, subdir, "_schema.json", content);
    }
  }
}

// ---------------------------------------------------------------------------
// Cloud-format schema conversion + CSV builder.
//
// Pinkfish's `/datacollection/` POST and `import-csv` endpoints expect a
// schema that uses `f_N` field IDs and a narrower type vocabulary than
// our on-disk `_schema.json` (which uses semantic ids like `displayName`
// and types like `text`/`datetime`/`enum`/`string[]`). These helpers do
// the round-trip mapping so the engine can ship a structured collection
// without losing data.
//
// Confirmed mappings (see `integration_tests/datastore-import-csv.test.ts`):
//   string  → string
//   text    → string
//   number  → number
//   boolean → boolean
//   datetime → string  (ISO-8601 round-trips fine; MDY/DMY parsing is
//                       opt-in and the cloud doesn't need it)
//   enum    → select   (with `options` derived from `values`)
//   string[] → DROPPED (PUT /datacollection/{id}/schema rejects array
//                       types; we drop them rather than crash)
// ---------------------------------------------------------------------------

type CloudSchema = {
  fields: Array<Record<string, unknown>>;
  nextFieldId: number;
};

type SchemaMapping = {
  cloud: CloudSchema;
  /// localFieldId → cloud column header label (used when emitting CSV
  /// columns). E.g. "displayName" → "Name".
  idToLabel: Record<string, string>;
  /// Cloud header label → local field id (reverse lookup so a CSV
  /// builder can find the row's value for a given column).
  labelToLocalId: Record<string, string>;
};

export function localSchemaToCloud(local: CollectionSchema | Record<string, unknown>): SchemaMapping {
  const localFields =
    ((local as Record<string, unknown>).fields as Array<Record<string, unknown>>) ?? [];
  const cloudFields: Array<Record<string, unknown>> = [];
  const idToLabel: Record<string, string> = {};
  const labelToLocalId: Record<string, string> = {};
  let counter = 1;
  for (const f of localFields) {
    const t = String(f.type ?? "");
    if (t.endsWith("[]")) continue;
    const localId = String(f.id);
    const label = String(f.label ?? localId);
    const fid = `f_${counter}`;
    counter += 1;
    idToLabel[localId] = label;
    labelToLocalId[label] = localId;

    let cloudType: string;
    const extra: Record<string, unknown> = {};
    if (t === "string" || t === "text" || t === "datetime") {
      cloudType = "string";
    } else if (t === "number") {
      cloudType = "number";
    } else if (t === "boolean") {
      cloudType = "boolean";
    } else if (t === "enum") {
      cloudType = "select";
      extra.options = (f.values as unknown[]) ?? (f.options as unknown[]) ?? [];
    } else {
      cloudType = "string"; // unknown type → best-effort
    }
    cloudFields.push({
      id: fid,
      label,
      type: cloudType,
      required: !!f.required,
      ...extra,
    });
  }
  return {
    cloud: { fields: cloudFields, nextFieldId: counter },
    idToLabel,
    labelToLocalId,
  };
}

function csvQuote(s: string): string {
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function serializeForCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.join("; ");
  return JSON.stringify(v);
}

function buildCsvFromRows(args: {
  rows: Array<Record<string, unknown>>;
  cloudFields: Array<Record<string, unknown>>;
  labelToLocalId: Record<string, string>;
}): string {
  const headers = args.cloudFields.map((f) => String(f.label));
  const lines: string[] = [headers.map(csvQuote).join(",")];
  for (const row of args.rows) {
    const cells = headers.map((h) => {
      const localId = args.labelToLocalId[h];
      const v = localId != null ? row[localId] : undefined;
      return csvQuote(serializeForCsv(v));
    });
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

/// Read every row JSON in `<repo>/databases/<folder>/` (skipping
/// `_schema.json` and dotfiles). Returns parsed objects in
/// filename-sorted order so CSVs are deterministic.
async function readLocalRows(
  repo: string,
  folderName: string,
): Promise<Array<{ key: string; row: Record<string, unknown> }>> {
  const out: Array<{ key: string; row: Record<string, unknown> }> = [];
  const dir = `${repo}/${DATASTORE_DIR_PREFIX}/${folderName}`;
  let nodes;
  try {
    nodes = await fsList(dir);
  } catch {
    return [];
  }
  const prefix = `${dir}/`;
  const files = nodes
    .filter((n) => n.path.startsWith(prefix))
    .filter((n) => !n.is_dir)
    .filter((n) => !n.name.startsWith("."))
    .filter((n) => n.name !== "_schema.json")
    .filter((n) => n.name.endsWith(".json"))
    .filter((n) => !n.path.slice(prefix.length).includes("/"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files) {
    try {
      const raw = await fsRead(f.path);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const key = f.name.replace(/\.json$/, "");
      out.push({ key, row: parsed });
    } catch (e) {
      console.warn(`[datastore] readLocalRows: failed to parse ${f.path}:`, e);
    }
  }
  return out;
}

/// Custom create for structured datastores. Reads the local schema,
/// converts it to cloud shape, builds a CSV from local rows, and
/// POSTs to `/datacollection/import-csv`. The endpoint creates the
/// collection AND populates rows in one shot — bypassing the cloud's
/// auto-template behavior that fires on a plain `POST /datacollection/`
/// with `isStructured + schema`.
///
/// Returns `null` (engine falls through to the standard POST) when:
///   - local `_schema.json` is missing or malformed
///   - access token isn't available
///
/// On success, returns the created collection's id + name. Engine then
/// runs its post-create refetch and pull as usual; the rows we just
/// uploaded will look like a normal cloud-side row set.
async function importCsvCustomCreate(args: {
  name: string;
  creds: PinkfishCreds;
  repo: string;
}): Promise<{ id: string; name: string; description?: string } | null> {
  const { name, creds, repo } = args;
  const folderName = displayDatastoreName(name);
  const schemaPath = `${repo}/${DATASTORE_DIR_PREFIX}/${folderName}/_schema.json`;
  let localSchema: CollectionSchema;
  try {
    localSchema = JSON.parse(await fsRead(schemaPath)) as CollectionSchema;
  } catch (e) {
    console.warn(
      `[datastore] importCsvCustomCreate: ${name} has no local schema, deferring to standard POST:`,
      e,
    );
    return null;
  }

  const token = getToken();
  if (!token) {
    console.warn("[datastore] importCsvCustomCreate: no access token, deferring");
    return null;
  }
  const urls = derivedUrls(creds.tokenUrl);

  const { cloud, labelToLocalId } = localSchemaToCloud(localSchema);
  const rows = (await readLocalRows(repo, folderName)).map((r) => r.row);
  const csv = buildCsvFromRows({
    rows,
    cloudFields: cloud.fields,
    labelToLocalId,
  });

  const description = (localSchema as { description?: string }).description ?? `OpenIT datastore: ${folderName}`;
  const importRes = await importCsv(urls.skillsBaseUrl, token.accessToken, {
    name,
    csv,
    schema: cloud,
    createdByName: "OpenIT",
  });
  console.log(
    `[datastore] import-csv ${name} → collection ${importRes.collectionId}, job ${importRes.jobId}`,
  );

  // Poll up to ~30s; non-fatal if we time out (rows will keep
  // importing server-side; engine's normal pull will see them on the
  // next tick).
  for (let i = 0; i < 30; i++) {
    try {
      const status = await fetchImportStatus(importRes.statusFileUrl);
      if (status.status === "completed") {
        console.log(
          `[datastore] import-csv ${name} done: inserted=${status.inserted ?? 0}, failed=${status.failed ?? 0}`,
        );
        break;
      }
      if (status.status === "failed") {
        console.warn(`[datastore] import-csv ${name} failed:`, status);
        break;
      }
    } catch (e) {
      console.warn(`[datastore] import-csv status poll threw:`, e);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { id: importRes.collectionId, name, description };
}

// ---------------------------------------------------------------------------
// Engine handle — created once at module init.
// ---------------------------------------------------------------------------

const handle = createCollectionEntitySync<DataCollection>({
  entityName: "datastore",
  displayName: "datastore",
  collectionType: "datastore",
  defaultNames: DEFAULT_DATASTORES.map((d) => d.name),
  describeDefault: (name) => {
    const def = DEFAULT_DATASTORES.find((d) => d.name === name);
    return def?.description ?? `OpenIT datastore: ${displayDatastoreName(name)}`;
  },
  localFolderRoot: DATASTORE_DIR_PREFIX,
  buildAdapter: ({ creds, collection }) => datastoreAdapter({ creds, collection }),
  fromDataCollection: (c) => c,
  pushOne: pushAllToDatastoreImpl,
  onAfterResolve: writeStructuredSchemas,
  discoverLocalCollections: discoverLocalDatastores,
  buildCreateBody: ({ name, creds, discovery }) => {
    // Both hardcoded defaults and user-created folders flow through
    // here. The discovery body fragment (built by
    // `discoverLocalDatastores`) carries `isStructured` + the local
    // schema when present. Defaults always have a bundled schema on
    // disk, so they end up structured automatically — no templateId
    // shortcut needed (and we explicitly avoid it: cloud-side
    // templates seed sample data we don't want).
    const def = DEFAULT_DATASTORES.find((d) => d.name === name);
    const description =
      def?.description ?? `OpenIT datastore: ${displayDatastoreName(name)}`;
    return {
      name,
      type: "datastore",
      description,
      createdBy: creds.orgId,
      createdByName: "OpenIT",
      triggerUrls: [],
      ...(discovery?.body ?? { isStructured: false }),
    };
  },
});

export const subscribeDatastoreSync = handle.subscribe;
export const getDatastoreSyncStatus = handle.getStatus;
export const stopDatastoreSync = handle.stop;

/// Re-exports under the existing public names so call sites (App,
/// Shell, pushAll, FileExplorer) compile unchanged.
export async function startDatastoreSync(args: {
  creds: PinkfishCreds;
  repo: string;
  onLog?: (msg: string) => void;
}): Promise<void> {
  await handle.start(args);
}

/// Resolve every openit-* datastore collection for this org. Exposed
/// for tests + the FileExplorer's listing view.
export function resolveProjectDatastores(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<DataCollection[]> {
  return handle.resolveCollections(creds, onLog);
}

/// Manual single-shot pull across every collection. Used by Shell.tsx's
/// ↻ button and the pre-push pull in pushAll.ts. Returns the
/// pre-existing `DatastoreConflict` shape (collectionName + key) so
/// callers don't see the engine's bare-key form.
export async function pullDatastoresOnce(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<{
  ok: boolean;
  error?: string;
  pulled: number;
  conflicts: DatastoreConflict[];
}> {
  let pulledTotal = 0;
  try {
    const r = await handle.pullAllNow(args);
    pulledTotal = r.pulled;
  } catch (e) {
    return { ok: false, error: String(e), pulled: 0, conflicts: [] };
  }
  // Map the orchestrator's flat `status.conflicts` back into the
  // pre-Phase-3 DatastoreConflict shape. Each CollectionConflictFile
  // carries `collectionId`; look up the collection's display name via
  // the active-collections list. Collections that disappeared mid-cycle
  // (rare; only on org switch) fall back to a blank name rather than
  // dropping the conflict.
  const status = handle.getStatus();
  const collectionNameById = new Map<string, string>();
  for (const c of status.collections) {
    collectionNameById.set(c.id, displayDatastoreName(c.name));
  }
  const collected: DatastoreConflict[] = status.conflicts.map((c) => ({
    collectionName: collectionNameById.get(c.collectionId) ?? "",
    key: c.filename,
    reason: c.reason,
  }));
  return { ok: true, pulled: pulledTotal, conflicts: collected };
}

/// Push every locally-edited datastore. Iterates over status.collections
/// and calls handle.pushOne per collection (orchestrator wraps with the
/// per-collection lock + status transitions). Single result aggregates
/// counts across all collections.
export async function pushAllToDatastores(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine?: (line: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, onLine } = args;
  const collections = handle.getStatus().collections;
  let pushed = 0;
  let failed = 0;
  for (const collection of collections) {
    try {
      const r = await handle.pushOne({ creds, repo, collection, onLine });
      pushed += r.pushed;
      failed += r.failed;
    } catch (e) {
      onLine?.(`✗ datastore: push (${displayDatastoreName(collection.name)}) failed: ${String(e)}`);
      failed += 1;
    }
  }
  return { pushed, failed };
}

// Pre-existing helper retained for callers that need to fetch a
// schema by id (e.g. on-demand display). Untouched by the refactor.
export async function fetchDatastoreSchema(
  creds: PinkfishCreds,
  collectionId: string,
): Promise<CollectionSchema | undefined> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);
  const collection = await getCollection(urls.skillsBaseUrl, token.accessToken, collectionId);
  return collection.schema;
}

export { fetchDatastoreItems };

// ---------------------------------------------------------------------------
// Push implementation — per-collection. Schema-push first (if dirty),
// then row reconcile (POST new, PUT changed, DELETE missing). Local-side
// row validation against `_schema.json` blocks malformed rows with a
// clear inline message.
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

async function pushSchemaIfDirty(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: DataCollection;
  onLine?: (line: string) => void;
}): Promise<{ ok: boolean; error?: string }> {
  const { creds, repo, collection, onLine } = args;
  if (!collection.isStructured) return { ok: true }; // nothing to push
  const folderName = displayDatastoreName(collection.name);
  const schemaPath = `${repo}/${DATASTORE_DIR_PREFIX}/${folderName}/_schema.json`;

  let local: CollectionSchema | null = null;
  try {
    const raw = await fsRead(schemaPath);
    local = JSON.parse(raw) as CollectionSchema;
  } catch {
    return { ok: true }; // no local schema file — skip
  }
  if (!local) return { ok: true };
  // Skip if already in sync with the remote schema we have in hand.
  if (collection.schema && jsonEqual(local, collection.schema)) {
    return { ok: true };
  }

  // PUT /datacollection/{id}/schema. Body wraps in { schema }.
  const token = getToken();
  if (!token) return { ok: false, error: "not authenticated" };
  const urls = derivedUrls(creds.tokenUrl);
  const fetchFn = makeSkillsFetch(token.accessToken);
  const url = new URL(
    `/datacollection/${encodeURIComponent(collection.id)}/schema`,
    urls.skillsBaseUrl,
  );
  try {
    const resp = await fetchFn(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: local }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      onLine?.(`✗ datastore: schema push (${folderName}) failed: HTTP ${resp.status}: ${text}`);
      return { ok: false, error: `HTTP ${resp.status}: ${text}` };
    }
    onLine?.(`✓ datastore: schema push (${folderName})`);
    // Patch the in-memory collection so subsequent comparisons match
    // and `validateRow` sees the new schema for any rows pushed in this
    // same cycle.
    collection.schema = local;
    return { ok: true };
  } catch (e) {
    onLine?.(`✗ datastore: schema push (${folderName}) failed: ${String(e)}`);
    return { ok: false, error: String(e) };
  }
}

async function pushAllToDatastoreImpl(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: DataCollection;
  onLine?: (line: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, collection, onLine } = args;
  const folderName = displayDatastoreName(collection.name);
  const dir = `${DATASTORE_DIR_PREFIX}/${folderName}`;

  // 1. Schema push first. If it fails (server rejection), skip row
  //    pushes for this collection this cycle — don't compound the
  //    failure.
  const schemaResult = await pushSchemaIfDirty(args);
  if (!schemaResult.ok) {
    return { pushed: 0, failed: 1 };
  }

  const token = getToken();
  if (!token) {
    onLine?.(`✗ datastore push (${folderName}): not authenticated`);
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);
  const fetchFn = makeSkillsFetch(token.accessToken);

  // 2. Row reconcile.
  let remote: MemoryItem[];
  try {
    const resp = await fetchDatastoreItems(creds, collection.id, 1000, 0);
    remote = resp.items;
  } catch (e) {
    onLine?.(`✗ datastore: list (${folderName}) failed: ${String(e)}`);
    return { pushed: 0, failed: 1 };
  }
  const remoteByKey = new Map<string, MemoryItem>();
  for (const r of remote) {
    const k = (r.key ?? r.id ?? "").toString();
    if (k) remoteByKey.set(k, r);
  }

  // SAFETY: only run the deletion phase if the local collection dir
  // actually exists. An empty `localFiles` from a missing dir would
  // be misread as "user deleted everything" and nuke remote.
  let localFiles: { key: string; absPath: string }[] = [];
  let localDirExists = true;
  try {
    const nodes = await datastoreListLocal(repo, folderName);
    const candidates = nodes
      .filter((n) => n.filename.endsWith(".json") && n.filename !== "_schema.json")
      .map((n) => n.filename);
    const siblings = new Set(candidates);
    localFiles = nodes
      .filter(
        (n) =>
          n.filename.endsWith(".json") &&
          n.filename !== "_schema.json" &&
          !classifyAsShadow(n.filename, siblings),
      )
      .map((n) => ({
        key: n.filename.replace(/\.json$/, ""),
        absPath: `${repo}/${dir}/${n.filename}`,
      }));
  } catch {
    localDirExists = false;
  }
  const localKeys = new Set(localFiles.map((f) => f.key));

  let pushed = 0;
  let failed = 0;
  // Load THIS collection's bucket from the nested manifest. The pull
  // path saves via `saveCollectionManifest("datastore", collection.id, …)`;
  // using the raw `datastoreStateLoad/Save` here would deserialize the
  // nested file as a flat KbState (empty `files`), then the
  // post-push save would overwrite the entire nested manifest with a
  // flat one — destroying every other collection's bucket.
  const persisted = await loadCollectionManifest(
    repo,
    "datastore",
    collection.id,
  );
  const pushedKeys = new Set<string>();

  for (const { key, absPath } of localFiles) {
    let parsed: unknown;
    try {
      const raw = await fsRead(absPath);
      parsed = JSON.parse(raw);
    } catch (e) {
      onLine?.(`✗ datastore: ${folderName}/${key}.json — invalid JSON: ${String(e)}`);
      failed += 1;
      continue;
    }

    // Schema validation for structured collections.
    if (collection.isStructured && collection.schema) {
      const v = validateRow(parsed, collection.schema);
      if (!v.ok) {
        for (const err of v.errors) {
          onLine?.(`✗ datastore: ${folderName}/${key}.json — ${err}`);
        }
        failed += 1;
        continue;
      }
    }

    const existing = remoteByKey.get(key);
    try {
      if (!existing) {
        const url = new URL("/memory/items", urls.skillsBaseUrl);
        url.searchParams.set("collectionId", collection.id);
        const resp = await fetchFn(url.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, content: parsed }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        onLine?.(`  + ${folderName}/${key}.json (created)`);
        pushed += 1;
        pushedKeys.add(key);
      } else if (!jsonEqual(parsed, existing.content)) {
        const url = new URL(
          `/memory/items/${encodeURIComponent(existing.id)}`,
          urls.skillsBaseUrl,
        );
        url.searchParams.set("collectionId", collection.id);
        const resp = await fetchFn(url.toString(), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: parsed }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        onLine?.(`  ✓ ${folderName}/${key}.json (updated)`);
        pushed += 1;
        pushedKeys.add(key);
      }
    } catch (e) {
      onLine?.(`✗ datastore: ${folderName}/${key}.json — ${String(e)}`);
      failed += 1;
    }
  }

  // Deletion phase — only when the local dir actually exists.
  if (localDirExists) {
    for (const r of remote) {
      const k = (r.key ?? r.id ?? "").toString();
      if (!k || localKeys.has(k)) continue;
      try {
        const url = new URL(
          `/memory/items/id/${encodeURIComponent(r.id)}`,
          urls.skillsBaseUrl,
        );
        url.searchParams.set("collectionId", collection.id);
        const resp = await fetchFn(url.toString(), { method: "DELETE" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        onLine?.(`  − ${folderName}/${k}.json (deleted on remote)`);
        pushed += 1;
      } catch (e) {
        onLine?.(`✗ datastore: delete ${folderName}/${k} — ${String(e)}`);
        failed += 1;
      }
    }
  } else {
    onLine?.(`▸ datastore: ${folderName} has no local dir yet — skipping deletion phase`);
  }

  // Post-push reconcile — refresh remote_version for keys we just
  // touched. Pagination cap matches the cap used in listRemote.
  if (pushedKeys.size > 0) {
    const RECONCILE_PAGE = 1000;
    const RECONCILE_MAX = 100_000;
    const remaining = new Set(pushedKeys);
    try {
      let offset = 0;
      let seen = 0;
      while (remaining.size > 0) {
        const resp: MemoryBqueryResponse = await fetchDatastoreItems(
          creds,
          collection.id,
          RECONCILE_PAGE,
          offset,
        );
        for (const item of resp.items) {
          const k = (item.key ?? item.id ?? "").toString();
          if (!remaining.has(k)) continue;
          // The orchestrator's saveCollectionManifest writes against
          // the per-collection bucket; we update via the engine path
          // to keep the abstraction clean.
          persisted.files[k] = {
            remote_version: item.updatedAt ?? "",
            pulled_at_mtime_ms: Date.now(),
          };
          remaining.delete(k);
        }
        const hasMore = resp.pagination?.hasNextPage === true;
        if (!hasMore || resp.items.length === 0) break;
        offset += resp.items.length;
        seen += resp.items.length;
        if (seen >= RECONCILE_MAX) {
          console.warn(
            `[datastoreSync] post-push reconcile for ${folderName}: hit ${RECONCILE_MAX}-item cap; ${remaining.size} key(s) left unreconciled`,
          );
          break;
        }
      }
    } catch (e) {
      console.warn(`[datastoreSync] post-push reconcile for ${folderName} failed:`, e);
    }
  }
  // Save THIS collection's bucket back into the nested manifest. The
  // helper does a load-modify-write under a per-(repo, entity) lock so
  // concurrent collection pushes never overlap on the shared
  // .openit/datastore-state.json file.
  await saveCollectionManifest(
    repo,
    "datastore",
    collection.id,
    collection.name,
    persisted,
  );

  return { pushed, failed };
}
