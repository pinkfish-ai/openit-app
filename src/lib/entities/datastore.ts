// Datastore adapter for syncEngine. Each row in an `openit-*` datastore
// collection becomes one file `databases/<colName>/<key>.json`.
//
// Differences from KB/filestore that the adapter resolves:
//  - Many collections per repo (KB/filestore have one). `listRemote` flattens
//    across all of them, paginating each.
//  - `manifestKey` is `<colName>/<key>`, not the filename. (Long-standing
//    convention so the manifest is unambiguous when a key collides across
//    collections.)
//  - Content is JSON in the API response (not a signed URL); `fetchAndWrite`
//    serializes inline rather than downloading.
//
// Schema files (`_schema.json`) are NOT handled here — the bootstrap path
// (`syncDatastoresToDisk`) writes them once on connect with content-equality
// checks. Schemas have no `updatedAt`, so they don't fit the engine's
// version-diff model.

import {
  datastoreListLocal,
  datastoreStateLoad,
  datastoreStateSave,
  entityDeleteFile,
  entityWriteFile,
  type KbLocalFile,
} from "../api";
import { type DataCollection, type MemoryItem } from "../skillsApi";
import { type PinkfishCreds } from "../pinkfishAuth";
import { type EntityAdapter, type LocalItem, type RemoteItem } from "../syncEngine";
import { fetchDatastoreItems } from "./datastoreApi";

const PAGE = 1000;
/// Defend against a backend that always claims `hasNextPage=true`. 100k rows
/// is well past any realistic openit-* collection; if we hit it, log and
/// flag pagination as failed so the engine skips its server-delete pass.
const PAGINATION_SAFETY_CAP = 100_000;

function manifestKey(colName: string, key: string): string {
  return `${colName}/${key}`;
}

function rowKey(item: MemoryItem): string {
  return (item.key ?? item.id ?? "").toString();
}

function shadowFilename(key: string): string {
  return `${key}.server.json`;
}

function isShadow(filename: string): boolean {
  return filename.includes(".server.");
}

function rowContent(item: MemoryItem): string {
  return typeof item.content === "object"
    ? JSON.stringify(item.content, null, 2)
    : (item.content as unknown as string);
}

export function datastoreAdapter(args: {
  creds: PinkfishCreds;
  collections: DataCollection[];
}): EntityAdapter {
  const { creds, collections } = args;
  return {
    prefix: "datastore",

    loadManifest: (repo) => datastoreStateLoad(repo),
    saveManifest: (repo, m) => datastoreStateSave(repo, m),

    async listRemote(_repo) {
      const items: RemoteItem[] = [];
      let paginationFailed = false;

      for (const col of collections) {
        let offset = 0;
        let collected = 0;
        while (true) {
          let resp;
          try {
            resp = await fetchDatastoreItems(creds, col.id, PAGE, offset);
          } catch (e) {
            console.error(`[datastore] list ${col.name} failed:`, e);
            paginationFailed = true;
            break;
          }
          for (const r of resp.items) {
            const key = rowKey(r);
            if (!key) continue;
            const filename = `${key}.json`;
            const subdir = `databases/${col.name}`;
            const colName = col.name;
            const item = r;
            items.push({
              manifestKey: manifestKey(colName, key),
              workingTreePath: `${subdir}/${filename}`,
              updatedAt: item.updatedAt ?? "",
              fetchAndWrite: (repo) =>
                entityWriteFile(repo, subdir, filename, rowContent(item)),
              writeShadow: (repo) =>
                entityWriteFile(repo, subdir, shadowFilename(key), rowContent(item)),
            });
          }
          const hasMore = resp.pagination?.hasNextPage === true;
          if (!hasMore || resp.items.length === 0) break;
          offset += resp.items.length;
          collected += resp.items.length;
          if (collected >= PAGINATION_SAFETY_CAP) {
            console.warn(
              `[datastore] ${col.name}: stopped paginating at ${collected} items; skipping server-delete pass`,
            );
            paginationFailed = true;
            break;
          }
        }
      }

      return { items, paginationFailed };
    },

    async listLocal(repo) {
      const out: LocalItem[] = [];
      for (const col of collections) {
        let files: KbLocalFile[];
        try {
          files = await datastoreListLocal(repo, col.name);
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.filename === "_schema.json") continue;
          // The filename on disk is `<key>.json` (or `<key>.server.json` for
          // shadows). Strip the suffix and any `.server` segment to recover
          // the raw key for the manifest lookup.
          const base = f.filename.replace(/\.json$/, "");
          const isShadowFile = isShadow(f.filename);
          const key = isShadowFile ? base.replace(/\.server$/, "") : base;
          out.push({
            manifestKey: manifestKey(col.name, key),
            workingTreePath: `databases/${col.name}/${f.filename}`,
            mtime_ms: f.mtime_ms,
            isShadow: isShadowFile,
          });
        }
      }
      return out;
    },

    /// Server-deleted row → drop the manifest entry AND remove the JSON
    /// file from disk. Matches the user-expected "if I delete on Pinkfish,
    /// it should disappear locally" model. The engine only invokes this
    /// when pagination is fully consumed, so we won't false-positive on a
    /// truncated remote list.
    async onServerDelete({ repo, manifestKey, manifest, touched }) {
      const slash = manifestKey.indexOf("/");
      if (slash < 0) {
        delete manifest.files[manifestKey];
        return true;
      }
      const colName = manifestKey.slice(0, slash);
      const key = manifestKey.slice(slash + 1);
      const subdir = `databases/${colName}`;
      const filename = `${key}.json`;
      try {
        await entityDeleteFile(repo, subdir, filename);
        delete manifest.files[manifestKey];
        touched.push(`${subdir}/${filename}`);
      } catch (e) {
        console.error(`[datastore] failed to delete local ${manifestKey}:`, e);
      }
      return true;
    },
  };
}
