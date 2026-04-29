// Datastore adapter for syncEngine. Phase 3 of V2 sync (PIN-5779)
// makes this per-collection: the adapter is constructed for one
// `DataCollection` and routes its IO through `databases/<displayName>/`
// (where `displayName` is the collection name with the `openit-`
// prefix stripped). Mirrors `entities/filestore.ts` + `entities/kb.ts`.
//
// Pre-Phase-3 the adapter was singular-across-all-collections, with a
// `<colName>/<key>` manifestKey scheme + cross-cutting
// `unreliableKeyPrefixes` for partial-failure tracking. With per-
// collection adapters: manifestKey simplifies to bare `<key>`
// (collection is implicit in the bucket), pagination failure is
// per-adapter via `paginationFailed: true` (engine already aggregates),
// and the orchestrator's per-collection conflict-bus prefix isolates
// failures.

import {
  datastoreListLocal,
  entityDeleteFile,
  entityWriteFile,
  type KbLocalFile,
} from "../api";
import { type DataCollection, type MemoryItem } from "../skillsApi";
import { type PinkfishCreds } from "../pinkfishAuth";
import { loadCollectionManifest, saveCollectionManifest } from "../nestedManifest";
import {
  classifyAsShadow,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type RemoteItem,
} from "../syncEngine";
import { fetchDatastoreItems } from "./datastoreApi";

/// Local on-disk parent for every datastore collection. Per-collection
/// subdirs hang off this — `databases/tickets`, `databases/projects`,
/// etc. Mirrors `filestores/` and `knowledge-bases/`.
export const DATASTORE_DIR_PREFIX = "databases";

const OPENIT_PREFIX = "openit-";
const PAGE = 1000;
/// Defend against a backend that always claims `hasNextPage=true`. 100k
/// rows is well past any realistic openit-* collection; if we hit it,
/// log + flag pagination as failed so the engine skips its
/// server-delete pass for THIS collection.
const PAGINATION_SAFETY_CAP = 100_000;

/// Conflict-aggregator prefix for one datastore collection. Mirrors
/// filestore + KB's per-collection prefix shape — identifies the
/// collection in the cross-entity conflict bus.
export function datastoreAggregatePrefix(collection: DataCollection): string {
  const folder = collection.name.startsWith(OPENIT_PREFIX)
    ? collection.name.slice(OPENIT_PREFIX.length)
    : collection.name;
  return `${DATASTORE_DIR_PREFIX}/${folder}`;
}

function rowKey(item: MemoryItem): string {
  return (item.key ?? item.id ?? "").toString();
}

function rowContent(item: MemoryItem): string {
  return typeof item.content === "object"
    ? JSON.stringify(item.content, null, 2)
    : (item.content as unknown as string);
}

export function datastoreAdapter(args: {
  creds: PinkfishCreds;
  collection: DataCollection;
}): EntityAdapter {
  const { creds, collection } = args;
  const folderName = collection.name.startsWith(OPENIT_PREFIX)
    ? collection.name.slice(OPENIT_PREFIX.length)
    : collection.name; // Fallback for non-openit collections (defensive).
  const DIR = `${DATASTORE_DIR_PREFIX}/${folderName}`;
  const PREFIX = DIR;

  return {
    prefix: PREFIX,

    loadManifest: (repo) => loadCollectionManifest(repo, "datastore", collection.id),
    saveManifest: (repo, m) =>
      saveCollectionManifest(repo, "datastore", collection.id, collection.name, m),

    async listRemote(_repo) {
      const items: RemoteItem[] = [];
      let offset = 0;
      let collected = 0;
      let paginationFailed = false;

      while (true) {
        let resp;
        try {
          resp = await fetchDatastoreItems(creds, collection.id, PAGE, offset);
        } catch (e) {
          console.error(`[datastore:${collection.id}] list ${collection.name} failed:`, e);
          paginationFailed = true;
          break;
        }
        for (const r of resp.items) {
          const key = rowKey(r);
          if (!key) continue;
          const filename = `${key}.json`;
          const item = r;
          items.push({
            manifestKey: key,
            workingTreePath: `${DIR}/${filename}`,
            updatedAt: item.updatedAt ?? "",
            fetchAndWrite: (repo) =>
              entityWriteFile(repo, DIR, filename, rowContent(item)),
            writeShadow: (repo) =>
              entityWriteFile(repo, DIR, shadowFilename(filename), rowContent(item)),
            // Cheap content access for engine's content-equality check
            // at bootstrap-adoption — datastore content is already in
            // the list response, no extra HTTP needed.
            inlineContent: async () => rowContent(item),
          });
        }
        const hasMore = resp.pagination?.hasNextPage === true;
        if (!hasMore || resp.items.length === 0) break;
        offset += resp.items.length;
        collected += resp.items.length;
        if (collected >= PAGINATION_SAFETY_CAP) {
          console.warn(
            `[datastore:${collection.id}] ${collection.name}: stopped paginating at ${collected} items; flagging paginationFailed`,
          );
          paginationFailed = true;
          break;
        }
      }

      return { items, paginationFailed };
    },

    async listLocal(repo) {
      let files: KbLocalFile[];
      try {
        files = await datastoreListLocal(repo, folderName);
      } catch {
        return [];
      }
      // Sibling-aware shadow classification, scoped per collection. Use
      // the full filename set (excluding `_schema.json`) so a legit
      // `nginx.server.json` (no `nginx.json` sibling) appears in
      // siblings and a follow-on `nginx.server.server.json` shadow
      // maps back to canonical via canonicalFromShadow.
      const candidateNames = files
        .filter(
          (f) => f.filename.endsWith(".json") && f.filename !== "_schema.json",
        )
        .map((f) => f.filename);
      const siblings = new Set(candidateNames);
      const out: LocalItem[] = [];
      for (const f of files) {
        if (!f.filename.endsWith(".json")) continue;
        if (f.filename === "_schema.json") continue;
        const isShadowFile = classifyAsShadow(f.filename, siblings);
        const base = f.filename.replace(/\.json$/, "");
        const key = isShadowFile ? base.replace(/\.server$/, "") : base;
        out.push({
          manifestKey: key,
          workingTreePath: `${DIR}/${f.filename}`,
          mtime_ms: f.mtime_ms,
          isShadow: isShadowFile,
        });
      }
      return out;
    },

    /// Server-deleted row → drop the manifest entry AND remove the JSON
    /// file from disk if it's still there. Engine only invokes this
    /// when pagination is fully consumed, so a truncated remote list
    /// doesn't false-positive.
    ///
    /// Skipping `touched.push` when the file was already gone is
    /// critical: `git_commit_paths` runs `git add -- <paths>` and fails
    /// the entire batch on an unknown path, which would silently drop
    /// legitimate pulled-file commits in the same cycle.
    async onServerDelete({ repo, manifestKey, manifest, touched, local }) {
      const filename = `${manifestKey}.json`;
      const stillOnDisk = local.some(
        (f) => !f.isShadow && f.manifestKey === manifestKey,
      );
      if (stillOnDisk) {
        try {
          await entityDeleteFile(repo, DIR, filename);
          touched.push(`${DIR}/${filename}`);
        } catch (e) {
          console.error(
            `[datastore:${collection.id}] failed to delete local ${manifestKey}:`,
            e,
          );
        }
      }
      delete manifest.files[manifestKey];
      return true;
    },
  };
}
