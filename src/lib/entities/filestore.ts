// Filestore adapter for syncEngine. The remote API is the same `kb_list_remote`
// shape (skills `/datacollection/{id}/items`) but the working-tree dir is
// `filestores/library/` and downloads use `fs_store_download_to_local`.
// Filestore had no shadow handling pre-engine; engine now provides it for
// free, with the shadow filename mirroring KB's `<base>.server.<ext>`
// convention.
//
// Layout split (2026-04-27): `filestores/library/` holds curated docs/scripts
// and is what this adapter maps to. `filestores/attachments/<ticketId>/` is a
// separate, server-managed surface for chat-intake uploads — those live
// under conversations operationally and aren't routed through this
// adapter (no shadow needed; auto-commit driver handles them).

import {
  entityDeleteFile,
  fsStoreDownloadToLocal,
  fsStoreListLocal,
  fsStoreStateLoad,
  fsStoreStateSave,
  kbListRemote,
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

const DIR = "filestores/library";

export type FilestoreCollection = {
  id: string;
  name: string;
  description?: string;
};

export function filestoreAdapter(args: {
  creds: PinkfishCreds;
  collection: FilestoreCollection;
}): EntityAdapter {
  const { creds, collection } = args;
  return {
    prefix: "filestores/library",

    loadManifest: (repo) => fsStoreStateLoad(repo),
    saveManifest: (repo, m) => fsStoreStateSave(repo, m),

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
          fetchAndWrite: (repo) =>
            fsStoreDownloadToLocal(repo, filename, downloadUrl),
          writeShadow: (repo) =>
            fsStoreDownloadToLocal(
              repo,
              shadowFilename(filename),
              downloadUrl,
            ),
        });
      }
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      const files = await fsStoreListLocal(repo);
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
