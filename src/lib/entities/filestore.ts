// Filestore adapter for syncEngine. The remote API is the same `kb_list_remote`
// shape (skills `/datacollection/{id}/items`) but the working-tree dir is
// `filestore/` and downloads use `fs_store_download_to_local`. Filestore had
// no shadow handling pre-engine; engine now provides it for free, with the
// shadow filename mirroring KB's `<base>.server.<ext>` convention.

import {
  fsStoreDownloadToLocal,
  fsStoreListLocal,
  fsStoreStateLoad,
  fsStoreStateSave,
  kbListRemote,
} from "../api";
import { derivedUrls, getToken, type PinkfishCreds } from "../pinkfishAuth";
import { type EntityAdapter, type LocalItem, type RemoteItem } from "../syncEngine";

const DIR = "filestore";

export type FilestoreCollection = {
  id: string;
  name: string;
  description?: string;
};

export function fsServerShadowFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return `${filename}.server`;
  return `${filename.slice(0, dot)}.server.${filename.slice(dot + 1)}`;
}

function isShadow(filename: string): boolean {
  return filename.includes(".server.");
}

export function filestoreAdapter(args: {
  creds: PinkfishCreds;
  collection: FilestoreCollection;
}): EntityAdapter {
  const { creds, collection } = args;
  return {
    prefix: "filestore",

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
              fsServerShadowFilename(filename),
              downloadUrl,
            ),
        });
      }
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      const files = await fsStoreListLocal(repo);
      const out: LocalItem[] = files.map((f) => ({
        manifestKey: f.filename,
        workingTreePath: `${DIR}/${f.filename}`,
        mtime_ms: f.mtime_ms,
        isShadow: isShadow(f.filename),
      }));
      return out;
    },

    // No onServerDelete: filestore historically only drops the manifest
    // entry (not the local file) when the server deletes — engine's
    // default behavior matches.
  };
}
