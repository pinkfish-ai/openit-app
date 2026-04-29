// Filestore adapter for syncEngine. The remote API is the same `kb_list_remote`
// shape (skills `/datacollection/{id}/items`) but the working-tree dir is
// `filestores/<collection-name>/` and downloads use `fs_store_download_to_local`.
// Filestore had no shadow handling pre-engine; engine now provides it for
// free, with the shadow filename mirroring KB's `<base>.server.<ext>`
// convention.
//
// Layout (Phase 1, 2026-04-29): Each openit-* collection maps to a local folder.
// - openit-library → filestores/library/
// - openit-attachments → filestores/attachments/
// - (Phase 2: custom user-named collections)
//
// Each adapter gets its own prefix and manifest so multi-collection sync
// doesn't cross-pollinate files.

import {
  entityDeleteFile,
  entityListLocal,
  fsStoreDownloadToLocal,
  kbListRemote,
  entityWriteFile,
} from "../api";
import { derivedUrls, getToken, type PinkfishCreds } from "../pinkfishAuth";
import {
  canonicalFromShadow,
  classifyAsShadow,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type RemoteItem,
} from "../syncEngine";
import { loadCollectionManifest, saveCollectionManifest } from "../filestoreManifest";

const OPENIT_PREFIX = "openit-";

export type FilestoreCollection = {
  id: string;
  name: string;
  description?: string;
};

// Ensure a filestore subdirectory exists by writing a placeholder file,
// then delete it. This forces the backend to create the directory structure.
async function ensureDirectoryExists(repo: string, dir: string): Promise<void> {
  const placeholder = ".placeholder";
  try {
    await entityWriteFile(repo, dir, placeholder, "");
    await entityDeleteFile(repo, dir, placeholder);
  } catch (e) {
    console.warn(`[filestore] failed to ensure directory exists: ${dir}`, e);
  }
}

export function filestoreAdapter(args: {
  creds: PinkfishCreds;
  collection: FilestoreCollection;
}): EntityAdapter {
  const { creds, collection } = args;

  // Derive local folder name from collection name by stripping openit- prefix
  // openit-library → filestores/library
  // openit-attachments → filestores/attachments
  const collectionFolderName = collection.name.startsWith(OPENIT_PREFIX)
    ? collection.name.slice(OPENIT_PREFIX.length)
    : collection.name; // Fallback for non-openit collections (Phase 2)
  const DIR = `filestores/${collectionFolderName}`;

  return {
    prefix: DIR,

    loadManifest: (repo) => loadCollectionManifest(repo, collection.id),
    saveManifest: (repo, m) => saveCollectionManifest(repo, collection.id, collection.name, m),

    async listRemote(_repo) {
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
            return fsStoreDownloadToLocal(repo, filename, downloadUrl, DIR);
          },
          writeShadow: async (repo) => {
            await ensureDirectoryExists(repo, DIR);
            return fsStoreDownloadToLocal(
              repo,
              shadowFilename(filename),
              downloadUrl,
              DIR,
            );
          },
        });
      }
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      // List files from THIS collection's subdirectory only — not the
      // legacy hardcoded filestores/library/ directory. Without this
      // every collection's adapter would see files from every other
      // collection mixed together, making the engine think files are
      // already on disk when they're actually in the wrong folder.
      const files = await entityListLocal(repo, DIR);
      // Sibling-aware shadow classification — see KB adapter for details.
      // Use the full filename set so a legit `a.server.conf` appears in
      // siblings and a follow-on `a.server.server.conf` shadow maps back
      // to it correctly.
      const canonicalSiblings = new Set(files.map((f) => f.filename));
      const out: LocalItem[] = files.map((f) => {
        const shadow = classifyAsShadow(f.filename, canonicalSiblings);
        return {
          manifestKey: shadow ? canonicalFromShadow(f.filename) : f.filename,
          workingTreePath: `${DIR}/${f.filename}`,
          mtime_ms: f.mtime_ms,
          isShadow: shadow,
        };
      });
      return out;
    },

    /// Server-deleted file → drop the manifest entry AND remove from disk.
    /// This matches user expectation ("I deleted it on Pinkfish, why is it
    /// still here") and mirrors KB's long-standing behavior. The deletion
    /// is added to `touched` so the auto-commit captures it.
    async onServerDelete({ repo, manifestKey, manifest, touched, local }) {
      // No shadow guard: manifests only contain canonical keys, so a
      // shadow-shaped check here would only fire on false positives
      // (canonical names containing `.server.`) and prevent legitimate
      // cleanup. See matching note in KB adapter.
      // `local` is the LocalItem[] threaded from listLocal — match on
      // canonical entry's manifestKey to avoid an extra IPC list per
      // deleted key.
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
        // Local delete failed — drop the manifest entry anyway so the
        // engine doesn't retry every poll. See KB adapter for rationale.
        console.error(`[filestore] failed to delete local ${manifestKey}:`, e);
      }
      delete manifest.files[manifestKey];
      return true;
    },
  };
}
