// KB adapter for syncEngine. Maps the engine's generic pull contract onto
// the existing kb_* Tauri commands. All KB-specific shape lives here.

import {
  kbDeleteFile,
  kbDownloadToLocal,
  kbListLocal,
  kbListRemote,
  kbStateLoad,
  kbStateSave,
} from "../api";
import { type KbCollection } from "../kb";
import { derivedUrls, getToken, type PinkfishCreds } from "../pinkfishAuth";
import {
  canonicalFromShadow,
  isShadowFilename,
  shadowFilename,
  type EntityAdapter,
  type LocalItem,
  type RemoteItem,
} from "../syncEngine";

const DIR = "knowledge-base";

/// Backward-compat alias. `kbSync.buildKbConflictPrompt` imports this name;
/// keeping it as an alias avoids touching that public-facing helper.
export const kbServerShadowFilename = shadowFilename;

export function kbAdapter(args: {
  creds: PinkfishCreds;
  collection: KbCollection;
}): EntityAdapter {
  const { creds, collection } = args;
  return {
    prefix: "kb",

    loadManifest: (repo) => kbStateLoad(repo),
    saveManifest: (repo, m) => kbStateSave(repo, m),

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
          fetchAndWrite: (repo) => kbDownloadToLocal(repo, filename, downloadUrl),
          writeShadow: (repo) =>
            kbDownloadToLocal(repo, kbServerShadowFilename(filename), downloadUrl),
        });
      }
      // KB list endpoint is single-shot, no pagination cursor — full set.
      return { items, paginationFailed: false };
    },

    async listLocal(repo) {
      const files = await kbListLocal(repo);
      const out: LocalItem[] = files.map((f) => {
        const shadow = isShadowFilename(f.filename);
        return {
          // Shadow files key off the canonical filename so the engine's
          // "does a shadow already exist for this remote item?" check
          // matches. workingTreePath stays as the on-disk name.
          manifestKey: shadow ? canonicalFromShadow(f.filename) : f.filename,
          workingTreePath: `${DIR}/${f.filename}`,
          mtime_ms: f.mtime_ms,
          isShadow: shadow,
        };
      });
      return out;
    },

    /// KB historically deletes the local file when the server has deleted
    /// it (and the file is still on disk). The default engine behavior
    /// (drop manifest entry only) preserves user data; KB intentionally
    /// trusts the server as authoritative for files it tracks.
    async onServerDelete({ repo, manifestKey, manifest, touched }) {
      if (isShadowFilename(manifestKey)) return true; // engine should ignore shadows
      // If the file isn't on disk, just drop the manifest entry — nothing
      // to delete. Skip the default branch by returning true.
      const local = await kbListLocal(repo);
      const stillOnDisk = local.some((f) => f.filename === manifestKey);
      if (!stillOnDisk) {
        delete manifest.files[manifestKey];
        return true;
      }
      try {
        await kbDeleteFile(repo, manifestKey);
        touched.push(`${DIR}/${manifestKey}`);
      } catch (e) {
        // Local delete failed (file locked, permission denied, etc.). Drop
        // the manifest entry anyway — the file becomes "untracked" from
        // the engine's perspective. Without this, the engine retries every
        // poll cycle indefinitely, spamming logs. User can clean up
        // manually if needed; the next pull won't be affected.
        console.error(`[kb] failed to delete local ${manifestKey}:`, e);
      }
      delete manifest.files[manifestKey];
      return true;
    },
  };
}
