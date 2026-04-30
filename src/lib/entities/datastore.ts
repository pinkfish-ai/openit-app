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
  datastoreStateLoad,
  datastoreStateSave,
  entityDeleteFile,
  entityListLocal,
  entityWriteFile,
  fsList,
  type KbLocalFile,
} from "../api";
import { type DataCollection, type MemoryItem } from "../skillsApi";
import { type PinkfishCreds } from "../pinkfishAuth";
import {
  classifyAsShadow,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type RemoteItem,
} from "../syncEngine";
import { fetchDatastoreItems } from "./datastoreApi";
import {
  CONVERSATIONS_COLLECTION_NAME,
  localSubdirFor,
} from "../datastorePaths";

const PAGE = 1000;
/// Defend against a backend that always claims `hasNextPage=true`. 100k rows
/// is well past any realistic openit-* collection; if we hit it, log and
/// flag pagination as failed so the engine skips its server-delete pass.
const PAGINATION_SAFETY_CAP = 100_000;

/// Manifest key for a row. Flat collections use `<colName>/<key>`.
/// Conversations pass a sortField so two tickets that share a msgId
/// stay distinct in the manifest, mirroring the on-disk path
/// `databases/conversations/<key>/<sortField>.json`.
function manifestKey(colName: string, key: string, sortField?: string): string {
  if (sortField !== undefined) return `${colName}/${key}/${sortField}`;
  return `${colName}/${key}`;
}

function rowKey(item: MemoryItem): string {
  return (item.key ?? "").toString();
}

function rowSortField(item: MemoryItem): string {
  return (item.sortField ?? "").toString();
}

// shadow naming + detection both live in syncEngine.ts; imported above.

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

    async listRemote(_repo, _manifest) {
      const items: RemoteItem[] = [];
      // Per-collection failure tracking: when collection A fails (network,
      // safety-cap, etc.), only A's manifest keys should be excluded from
      // the engine's server-delete pass. Other collections that listed
      // successfully still reconcile their server-deleted rows correctly.
      const unreliableKeyPrefixes: string[] = [];

      for (const col of collections) {
        let offset = 0;
        let collected = 0;
        let colFailed = false;
        while (true) {
          let resp;
          try {
            resp = await fetchDatastoreItems(creds, col.id, PAGE, offset);
          } catch (e) {
            console.error(`[datastore] list ${col.name} failed:`, e);
            colFailed = true;
            break;
          }
          for (const r of resp.items) {
            const key = rowKey(r);
            if (!key) continue;
            const isConversations = col.name === CONVERSATIONS_COLLECTION_NAME;
            // Conversations: cloud row's (key, sortField) maps directly
            // onto the on-disk (folder, file) — `key=ticketId,
            // sortField=msgId`. Flat collections: file is keyed by `key`.
            let subdir: string;
            let filename: string;
            let mKey: string;
            if (isConversations) {
              const sortField = rowSortField(r);
              if (!sortField) {
                // sortField is required on the read model
                // (firebase-helpers MemoryItem.sortField). Missing means
                // the cloud returned a malformed row — log and skip
                // rather than file under a nonsense path.
                console.warn(
                  `[datastore] openit-conversations row key=${key} has no sortField; skipping pull`,
                );
                continue;
              }
              subdir = `${localSubdirFor(col.name)}/${key}`;
              filename = `${sortField}.json`;
              mKey = manifestKey(col.name, key, sortField);
            } else {
              subdir = localSubdirFor(col.name);
              filename = `${key}.json`;
              mKey = manifestKey(col.name, key);
            }
            const item = r;
            items.push({
              manifestKey: mKey,
              workingTreePath: `${subdir}/${filename}`,
              updatedAt: item.updatedAt ?? "",
              fetchAndWrite: (repo) =>
                entityWriteFile(repo, subdir, filename, rowContent(item)),
              writeShadow: (repo) =>
                entityWriteFile(repo, subdir, shadowFilename(filename), rowContent(item)),
              // Cheap content access for engine's content-equality
              // check at bootstrap-adoption — datastore content is
              // already in the list response, no extra HTTP needed.
              inlineContent: async () => rowContent(item),
            });
          }
          const hasMore = resp.pagination?.hasNextPage === true;
          if (!hasMore || resp.items.length === 0) break;
          offset += resp.items.length;
          collected += resp.items.length;
          if (collected >= PAGINATION_SAFETY_CAP) {
            console.warn(
              `[datastore] ${col.name}: stopped paginating at ${collected} items; skipping server-delete pass for this collection`,
            );
            colFailed = true;
            break;
          }
        }
        if (colFailed) {
          // Use the same `<colName>/` prefix the manifestKey helper produces.
          // Engine's server-delete loop excludes any mKey starting with this.
          unreliableKeyPrefixes.push(`${col.name}/`);
        }
      }

      // paginationFailed stays false — the per-scope flag is the right
      // tool here. (If we want to keep `true` as "nothing in items can
      // be trusted", that case is covered by listRemote throwing
      // upstream of pullEntity, not by this branch.)
      return { items, paginationFailed: false, unreliableKeyPrefixes };
    },

    async listLocal(repo) {
      const out: LocalItem[] = [];
      for (const col of collections) {
        const colDir = localSubdirFor(col.name);

        // openit-conversations: nested per-ticket layout. Walk
        // `databases/conversations/<ticketId>/` for each ticket and
        // collect every msg-*.json as a row.
        if (col.name === CONVERSATIONS_COLLECTION_NAME) {
          let topNodes;
          try {
            topNodes = await fsList(`${repo}/${colDir}`);
          } catch {
            continue;
          }
          for (const top of topNodes) {
            if (!top.is_dir) continue;
            const ticketId = top.name;
            let inner: KbLocalFile[];
            try {
              inner = await entityListLocal(repo, `${colDir}/${ticketId}`);
            } catch {
              continue;
            }
            // Skip `_schema.json` defensively — conversations is unstructured
            // and shouldn't have one in the per-ticket folder, but a stray
            // one shouldn't get picked up as a row and pushed to cloud.
            const filtered = inner.filter(
              (f) => f.filename.endsWith(".json") && f.filename !== "_schema.json",
            );
            const siblings = new Set(filtered.map((f) => f.filename));
            for (const f of filtered) {
              const base = f.filename.replace(/\.json$/, "");
              const isShadowFile = classifyAsShadow(f.filename, siblings);
              const msgId = isShadowFile ? base.replace(/\.server$/, "") : base;
              // ticketId = parent folder, msgId = filename stem.
              // Composite manifest key matches the cloud row's
              // (key, sortField), so cross-ticket msgId reuse is fine.
              out.push({
                manifestKey: manifestKey(col.name, ticketId, msgId),
                workingTreePath: `${colDir}/${ticketId}/${f.filename}`,
                mtime_ms: f.mtime_ms,
                isShadow: isShadowFile,
              });
            }
          }
          continue;
        }

        // Flat layout (tickets, people, custom datastores).
        let files: KbLocalFile[];
        try {
          files = await entityListLocal(repo, colDir);
        } catch {
          continue;
        }
        // Sibling-aware shadow classification, scoped per collection.
        // Use the full filename set (excluding _schema.json) so legit
        // shadow-shaped names still appear in siblings — a follow-on
        // double-shadow like `<key>.server.server.json` then maps back
        // to its canonical via canonicalFromShadow.
        const canonicalSiblings = new Set(
          files.filter((f) => f.filename !== "_schema.json").map((f) => f.filename),
        );
        for (const f of files) {
          if (f.filename === "_schema.json") continue;
          if (!f.filename.endsWith(".json")) continue;
          const base = f.filename.replace(/\.json$/, "");
          const isShadowFile = classifyAsShadow(f.filename, canonicalSiblings);
          const key = isShadowFile ? base.replace(/\.server$/, "") : base;
          out.push({
            manifestKey: manifestKey(col.name, key),
            workingTreePath: `${colDir}/${f.filename}`,
            mtime_ms: f.mtime_ms,
            isShadow: isShadowFile,
          });
        }
      }
      return out;
    },

    /// Server-deleted row → drop the manifest entry AND remove the JSON
    /// file from disk if it's still there. Matches the user-expected
    /// "if I delete on Pinkfish, it should disappear locally" model. The
    /// engine only invokes this when pagination is fully consumed, so we
    /// won't false-positive on a truncated remote list.
    ///
    /// Skipping `touched.push` when the file was already gone is critical:
    /// `git_commit_paths` runs a single `git add -- <paths>` and fails
    /// the entire batch if any path is unknown to git, which would
    /// silently drop legitimate pulled-file commits in the same cycle.
    async onServerDelete({ repo, manifestKey, manifest, touched, local }) {
      const slash = manifestKey.indexOf("/");
      if (slash < 0) {
        delete manifest.files[manifestKey];
        return true;
      }
      // Use the canonical local entry's actual workingTreePath (set by
      // listLocal) so this works for both flat and nested layouts. For
      // openit-conversations the file lives at
      // `databases/conversations/<ticketId>/<msgId>.json` — we can't
      // recompute that from the manifest key alone.
      const localEntry = local.find(
        (f) => !f.isShadow && f.manifestKey === manifestKey,
      );
      if (localEntry) {
        const path = localEntry.workingTreePath;
        const lastSlash = path.lastIndexOf("/");
        const subdir = lastSlash < 0 ? "" : path.slice(0, lastSlash);
        const filename = lastSlash < 0 ? path : path.slice(lastSlash + 1);
        try {
          await entityDeleteFile(repo, subdir, filename);
          touched.push(path);
        } catch (e) {
          console.error(`[datastore] failed to delete local ${manifestKey}:`, e);
        }
      }
      delete manifest.files[manifestKey];
      return true;
    },
  };
}
