// Filestore sync wrapper. Phase 2 of V2 sync (PIN-5775) collapsed the
// orchestrator-level machinery (status, listeners, conflict tracking,
// in-flight resolve dedup, auto-create defaults, polling loop, lastSyncAt
// stamping, hasServerShadowFiles walker, etc.) into the shared
// `createCollectionEntitySync` helper in `syncEngine.ts`. This file is
// now ~150 LOC of filestore-specific glue:
//
//   - The CollectionSyncConfig (REST type, default names, adapter factory).
//   - The push impl (filestore-specific upload, sanitised-filename
//     reconciliation, post-push remote_version refresh).
//   - Re-exports under the names call sites already use.
//
// Sibling: kbSync.ts uses the same helper with KB config.

import {
  entityListLocal,
  fsStoreInit,
  fsStoreUploadFile,
  kbListRemote,
} from "./api";
import { type DataCollection } from "./skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import {
  filestoreAdapter,
  type FilestoreCollection,
} from "./entities/filestore";
import {
  loadCollectionManifest,
  saveCollectionManifest,
} from "./nestedManifest";
import {
  classifyAsShadow,
  createCollectionEntitySync,
  type CollectionSyncStatus,
} from "./syncEngine";

export type { FilestoreCollection };

/// Phase 1 of V2 sync (PIN-5775): all filestore collections we manage
/// carry the `openit-` prefix on the cloud. The remote listing is
/// filtered to this prefix before any sync logic runs so users with
/// unrelated filestores on their Pinkfish account aren't touched.
export const OPENIT_FILESTORE_PREFIX = "openit-";

/// Strip the `openit-` prefix for display in the UI / log lines. Returns
/// the input unchanged when the prefix is absent.
export function displayFilestoreName(name: string): string {
  return name.startsWith(OPENIT_FILESTORE_PREFIX)
    ? name.slice(OPENIT_FILESTORE_PREFIX.length)
    : name;
}

/// Single source of truth for the OpenIT-managed filestore collections.
/// Both `getDefaultFilestores` (caller-facing) and the engine handle's
/// `defaultNames` below are derived from this list — they used to drift
/// independently, which silently broke auto-create on the cloud for any
/// new entries. Keep this list and only this list authoritative.
///
///   - `openit-library`     — shared admin docs (admin-curated).
///   - `openit-attachments` — intake-server uploads (per-ticket).
///   - `openit-skills`      — admin-side skill markdown (PIN-5829).
///   - `openit-scripts`     — admin-side runnable scripts (PIN-5829).
const DEFAULT_FILESTORES: ReadonlyArray<{ name: string; description: string }> = [
  { name: "openit-library", description: "Shared document storage for OpenIT" },
  { name: "openit-attachments", description: "OpenIT filestore: attachments" },
  { name: "openit-skills", description: "OpenIT filestore: admin skills" },
  { name: "openit-scripts", description: "OpenIT filestore: admin scripts" },
];

export function getDefaultFilestores(_orgId: string) {
  return DEFAULT_FILESTORES.map((d) => ({ ...d }));
}

/// Dedupe helper retained as an export so existing tests pin the
/// behaviour. Same logic now lives inside the orchestrator's
/// `dedupeOpenit` and runs from there at runtime; this is the test
/// surface.
export function dedupeOpenitByName(
  all: DataCollection[],
): FilestoreCollection[] {
  const byName = new Map<string, FilestoreCollection>();
  for (const c of all) {
    if (!c.name.startsWith(OPENIT_FILESTORE_PREFIX)) continue;
    const candidate = {
      id: String(c.id),
      name: c.name,
      description: c.description,
    };
    const existing = byName.get(c.name);
    if (!existing || candidate.id < existing.id) {
      byName.set(c.name, candidate);
    }
  }
  return Array.from(byName.values());
}

export type ConflictFile = {
  filename: string;
  reason: "local-and-remote-changed";
};

export type FilestoreSyncStatus = CollectionSyncStatus<FilestoreCollection>;

// Map a collection name to its local subdirectory. Mirror of the same
// logic in `entities/filestore.ts` — push and pull need to agree.
function collectionLocalDir(collectionName: string): string {
  const folder = collectionName.startsWith(OPENIT_FILESTORE_PREFIX)
    ? collectionName.slice(OPENIT_FILESTORE_PREFIX.length)
    : collectionName;
  return `filestores/${folder}`;
}

// ---------------------------------------------------------------------------
// Engine handle — created once at module init. Status / lifecycle / pull /
// shadow walker / discovery all delegate into this.
// ---------------------------------------------------------------------------

const handle = createCollectionEntitySync<FilestoreCollection>({
  entityName: "fs",
  displayName: "filestore",
  collectionType: "filestorage",
  defaultNames: DEFAULT_FILESTORES.map((d) => d.name),
  describeDefault: (name) =>
    `OpenIT filestore: ${displayFilestoreName(name)}`,
  localFolderRoot: "filestores",
  buildAdapter: ({ creds, collection }) => filestoreAdapter({ creds, collection }),
  fromDataCollection: (c) => ({
    id: String(c.id),
    name: c.name,
    description: c.description,
  }),
  initLocalRoot: fsStoreInit,
  pushOne: pushAllToFilestoreImpl,
});

export const subscribeFilestoreSync = handle.subscribe;
export const getFilestoreSyncStatus = handle.getStatus;
export const startFilestoreSync = handle.start;
export const stopFilestoreSync = handle.stop;

/// Manual single-shot pull for one collection. Used by Shell.tsx's ↻
/// button and the modal connect flow. Always resolves — never rejects —
/// to match the pre-engine contract.
export const pullOnce = handle.pullOne;

/// Resolve every openit-* filestore collection for this org. Exposed for
/// tests and pushAll.ts pre-push paths.
export function resolveProjectFilestores(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<FilestoreCollection[]> {
  return handle.resolveCollections(creds, onLog);
}

/// Push all local files in one collection to the remote. Goes through the
/// orchestrator's per-collection lock so it can't race a poll. The
/// engine-specific upload semantics live in `pushAllToFilestoreImpl`.
export const pushAllToFilestore = handle.pushOne;

// ---------------------------------------------------------------------------
// Push implementation — engine-specific upload + sanitised-filename
// reconciliation + post-push remote_version refresh.
// ---------------------------------------------------------------------------

async function pushAllToFilestoreImpl(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: FilestoreCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, collection, onLine } = args;

  const token = getToken();
  if (!token) {
    onLine?.("✗ filestore push: not authenticated");
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);

  const dir = collectionLocalDir(collection.name);
  const local = await entityListLocal(repo, dir);
  const persisted = await loadCollectionManifest(repo, "fs", collection.id);

  const siblings = new Set(local.map((f) => f.filename));
  const toPush = local.filter((f) => {
    if (classifyAsShadow(f.filename, siblings)) return false;
    const tracked = persisted.files[f.filename];
    if (!tracked) return true;
    if (f.mtime_ms == null) return true;
    return f.mtime_ms > tracked.pulled_at_mtime_ms;
  });

  if (toPush.length === 0) {
    onLine?.(`▸ filestore push (${collection.name}): nothing new to upload`);
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  const pushedNames = new Set<string>();

  for (const f of toPush) {
    try {
      onLine?.(`▸ uploading ${dir}/${f.filename}`);
      const result = await fsStoreUploadFile({
        repo,
        filename: f.filename,
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
        subdir: dir,
      });
      // The skills API may rewrite filenames on upload — most commonly
      // by prefixing a UUID (e.g. `chart.json` → `<uuid>-chart.json`).
      // Pre-PIN-5827 we renamed the local file to match; that doubled
      // the change set on every first push and broke any external
      // reference to the original path. Now we keep the local file at
      // the user's name and stash the server's canonical name as
      // `cloud_filename` in the manifest. listRemote uses that bridge
      // to recognize the round-trip without a duplicate download.
      const cloudFilename =
        result?.filename &&
        result.filename !== f.filename &&
        !result.filename.includes("/") &&
        !result.filename.includes("\\")
          ? result.filename
          : undefined;
      persisted.files[f.filename] = {
        remote_version: new Date().toISOString(),
        pulled_at_mtime_ms: f.mtime_ms ?? Date.now(),
        ...(cloudFilename ? { cloud_filename: cloudFilename } : {}),
      };
      pushedNames.add(cloudFilename ?? f.filename);
      pushed += 1;
    } catch (e) {
      failed += 1;
      onLine?.(`✗ ${dir}/${f.filename}: ${String(e)}`);
    }
  }

  // Reconcile remote_version after push: refresh from server's authoritative
  // updatedAt so the next pull doesn't false-flag a conflict.
  // The manifest is keyed by *local* filename now (PIN-5827), so look up
  // the tracked entry via cloud_filename when the server's name differs
  // from the local one.
  if (pushedNames.size > 0) {
    try {
      const remote = await kbListRemote({
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
      });
      const cloudToLocal = new Map<string, string>();
      for (const [localName, state] of Object.entries(persisted.files)) {
        cloudToLocal.set(state.cloud_filename ?? localName, localName);
      }
      for (const r of remote) {
        if (pushedNames.has(r.filename) && r.updated_at) {
          const localName = cloudToLocal.get(r.filename);
          const tracked = localName ? persisted.files[localName] : undefined;
          if (tracked) tracked.remote_version = r.updated_at;
        }
      }
    } catch (e) {
      console.warn("[filestore] post-push remote-version sync failed:", e);
    }
  }

  await saveCollectionManifest(
    repo,
    "fs",
    collection.id,
    collection.name,
    persisted,
  );
  return { pushed, failed };
}
