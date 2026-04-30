// KB adapter for syncEngine. Phase 2 of V2 sync (PIN-5775) makes this
// per-collection: the adapter is constructed for one `KbCollection` and
// routes its IO through `knowledge-bases/<displayName>/`. Multiple
// adapters run side-by-side in the orchestrator, one per `openit-*` KB
// on the cloud. Mirrors `entities/filestore.ts`.

import {
  entityDeleteFile,
  entityListLocal,
  entityWriteFile,
  kbDownloadToLocal,
  kbListRemote,
} from "../api";
import {
  displayKbName,
  OPENIT_KB_PREFIX,
  type KbCollection,
} from "../kb";
import { loadCollectionManifest, saveCollectionManifest } from "../nestedManifest";
import { derivedUrls, getToken, type PinkfishCreds } from "../pinkfishAuth";
import {
  canonicalFromShadow,
  classifyAsShadow,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type RemoteItem,
} from "../syncEngine";

/// Local on-disk parent for every KB collection. Per-collection subdirs
/// hang off this — `knowledge-bases/default`, `knowledge-bases/runbooks`,
/// etc. Mirrors `filestores/` for filestore.
export const KB_DIR_PREFIX = "knowledge-bases";

/// Backward-compat alias. `kbSync.buildKbConflictPrompt` and other
/// callers import this name; keeping it as an alias avoids touching
/// every site.
export const kbServerShadowFilename = shadowFilename;

/// Conflict-aggregator prefix for one KB collection. Mirrors
/// filestore's per-collection prefix shape — identifies the collection
/// in the cross-entity conflict bus so the engine never merges
/// conflicts from two collections into one slot.
export function kbAggregatePrefix(collection: KbCollection): string {
  return `${KB_DIR_PREFIX}/${displayKbName(collection.name)}`;
}

// Ensure a KB subdirectory exists by writing a placeholder file, then
// deleting it. Mirrors the filestore adapter's `ensureDirectoryExists`.
async function ensureDirectoryExists(repo: string, dir: string): Promise<void> {
  const placeholder = ".placeholder";
  try {
    await entityWriteFile(repo, dir, placeholder, "");
    await entityDeleteFile(repo, dir, placeholder);
  } catch (e) {
    console.warn(`[kb] failed to ensure directory exists: ${dir}`, e);
  }
}

export function kbAdapter(args: {
  creds: PinkfishCreds;
  collection: KbCollection;
}): EntityAdapter {
  const { creds, collection } = args;
  const folderName = collection.name.startsWith(OPENIT_KB_PREFIX)
    ? collection.name.slice(OPENIT_KB_PREFIX.length)
    : collection.name; // Fallback for non-openit collections (defensive).
  const DIR = `${KB_DIR_PREFIX}/${folderName}`;
  const PREFIX = DIR;

  return {
    prefix: PREFIX,

    loadManifest: (repo) => loadCollectionManifest(repo, "kb", collection.id),
    saveManifest: (repo, m) =>
      saveCollectionManifest(repo, "kb", collection.id, collection.name, m),

    async listRemote(_repo, _manifest) {
      const token = getToken();
      if (!token) throw new Error("not authenticated");
      const urls = derivedUrls(creds.tokenUrl);
      const rows = await kbListRemote({
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
      });
      const items: RemoteItem[] = [];
      for (const r of rows) {
        if (!r.filename || !r.signed_url) continue;
        const downloadUrl = r.signed_url;
        const filename = r.filename;
        items.push({
          manifestKey: filename,
          workingTreePath: `${DIR}/${filename}`,
          updatedAt: r.updated_at ?? "",
          fetchAndWrite: async (repo) => {
            await ensureDirectoryExists(repo, DIR);
            return kbDownloadToLocal(repo, filename, downloadUrl, DIR);
          },
          writeShadow: async (repo) => {
            await ensureDirectoryExists(repo, DIR);
            return kbDownloadToLocal(
              repo,
              kbServerShadowFilename(filename),
              downloadUrl,
              DIR,
            );
          },
        });
      }
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      const files = await entityListLocal(repo, DIR);
      // Sibling-aware shadow classification. Use the full filename set
      // so a legit `a.server.conf` appears in siblings and a follow-on
      // `a.server.server.conf` shadow maps back to it correctly.
      const canonicalSiblings = new Set(files.map((f) => f.filename));
      return files.map<LocalItem>((f) => {
        const shadow = classifyAsShadow(f.filename, canonicalSiblings);
        return {
          manifestKey: shadow ? canonicalFromShadow(f.filename) : f.filename,
          workingTreePath: `${DIR}/${f.filename}`,
          mtime_ms: f.mtime_ms,
          isShadow: shadow,
        };
      });
    },

    /// Server-deleted file → drop the manifest entry AND remove from
    /// disk. KB has historically deleted the local file when the server
    /// did; preserved here for parity with filestore.
    async onServerDelete({ repo, manifestKey, manifest, touched, local }) {
      const stillOnDisk = local.some(
        (f) => !f.isShadow && f.manifestKey === manifestKey,
      );
      if (!stillOnDisk) {
        delete manifest.files[manifestKey];
        return true;
      }
      try {
        await entityDeleteFile(repo, DIR, manifestKey);
        touched.push(`${DIR}/${manifestKey}`);
      } catch (e) {
        console.error(`[kb:${collection.id}] failed to delete local ${manifestKey}:`, e);
      }
      delete manifest.files[manifestKey];
      return true;
    },
  };
}
