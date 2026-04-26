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
  classifyAsShadow,
  looksLikeShadow,
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
      // Build the canonical-sibling set first so we can classify shadows
      // accurately: a file is a shadow IFF it matches `<base>.server.<ext>`
      // AND `<base>.<ext>` is also present on disk. Without the sibling
      // check, a legitimate file like `nginx.server.conf` (no
      // `nginx.conf` sibling) would be misclassified and never tracked.
      const canonicalSiblings = new Set(
        files
          .filter((f) => !looksLikeShadow(f.filename))
          .map((f) => f.filename),
      );
      const out: LocalItem[] = files.map((f) => {
        const shadow = classifyAsShadow(f.filename, canonicalSiblings);
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
    async onServerDelete({ repo, manifestKey, manifest, touched, local }) {
      // No shadow guard here: the manifest only ever contains canonical
      // keys (engine writes them via `manifest.files[r.manifestKey] = …`
      // where r.manifestKey is the canonical name). An old guard checking
      // `isShadowFilename(manifestKey)` only fired on false positives —
      // canonical names that happen to contain `.server.` — and prevented
      // the server-delete cleanup from running on them.
      // `local` is the LocalItem[] threaded through from listLocal — the
      // canonical entry's manifestKey equals its filename for KB, so we
      // can match directly without an extra IPC list.
      const stillOnDisk = local.some(
        (f) => !f.isShadow && f.manifestKey === manifestKey,
      );
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
