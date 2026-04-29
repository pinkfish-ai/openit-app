// KB sync wrapper. Phase 2 of V2 sync (PIN-5775) collapsed the
// orchestrator-level machinery into the shared `createCollectionEntitySync`
// helper in `syncEngine.ts` — same one filestore uses. This file is now
// ~150 LOC of KB-specific glue:
//
//   - The CollectionSyncConfig (REST type, default name, adapter factory).
//   - The push impl (KB-specific upload + git-status-aware dirty
//     detection + post-push remote_version refresh).
//   - The KB-only "Resolve in Claude" prompt builder + shadow walker.
//   - Re-exports under the names call sites already use.
//
// Sibling: filestoreSync.ts uses the same helper with filestore config.

import {
  entityListLocal,
  gitStatusShort,
  kbListRemote,
  kbUploadFile,
} from "./api";
import { displayKbName, type KbCollection } from "./kb";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import {
  KB_DIR_PREFIX,
  kbAdapter,
  kbServerShadowFilename,
} from "./entities/kb";
import { loadCollectionManifest, saveCollectionManifest } from "./nestedManifest";
import {
  canonicalFromShadow,
  classifyAsShadow,
  commitTouched,
  createCollectionEntitySync,
  type CollectionSyncStatus,
} from "./syncEngine";

export { kbServerShadowFilename };

/// Backward-compat alias for kbBaseFromShadowFilename — internally now
/// the engine's canonicalFromShadow.
export const kbBaseFromShadowFilename = canonicalFromShadow;

export type ConflictFile = {
  filename: string;
  reason: "local-and-remote-changed";
};

export type SyncStatus = CollectionSyncStatus<KbCollection>;

// Map a collection to its local subdirectory. Mirror of the same logic
// in `entities/kb.ts` — push and pull need to agree.
function collectionLocalDir(collection: KbCollection): string {
  return `${KB_DIR_PREFIX}/${displayKbName(collection.name)}`;
}

// ---------------------------------------------------------------------------
// Engine handle — created once at module init.
// ---------------------------------------------------------------------------

const handle = createCollectionEntitySync<KbCollection>({
  entityName: "kb",
  displayName: "kb",
  // REST DataCollectionType is snake_case `knowledge_base`. The MCP
  // server name uses the hyphenated form (`knowledge-base`); the REST
  // endpoint does not.
  collectionType: "knowledge_base",
  defaultNames: ["openit-default"],
  describeDefault: (name) =>
    `OpenIT knowledge base — ${displayKbName(name)}.`,
  localFolderRoot: KB_DIR_PREFIX,
  buildAdapter: ({ creds, collection }) => kbAdapter({ creds, collection }),
  fromDataCollection: (c) => ({
    id: String(c.id),
    name: c.name,
    description: c.description,
  }),
  pushOne: pushAllToKbImpl,
});

export const subscribeSync = handle.subscribe;
export const getSyncStatus = handle.getStatus;
export const stopKbSync = handle.stop;
export const kbHasServerShadowFiles = handle.hasServerShadowFiles;

/// Public start signature drops the legacy `orgSlug`/`orgName` params
/// (Phase 2 dropped MCP-driven naming-by-org). The shape is preserved
/// to avoid churning every call site — extra args are ignored.
export async function startKbSync(args: {
  creds: PinkfishCreds;
  repo: string;
  /** Legacy — Phase 2 ignores. Kept so call sites compile unchanged. */
  orgSlug?: string;
  /** Legacy — Phase 2 ignores. Kept so call sites compile unchanged. */
  orgName?: string;
  /** Receives per-collection log lines (`✓ openit-default (id: …)`)
   *  on the FIRST attempt. Forwarded to the orchestrator. */
  onLog?: (msg: string) => void;
}): Promise<void> {
  void args.orgSlug;
  void args.orgName;
  void args.onLog;
  await handle.start({ creds: args.creds, repo: args.repo });
}

/// Run one bidirectional pull across every active KB collection. Used
/// by Shell.tsx's ↻ button and the pre-push pull in `pushAll.ts`. Goes
/// through the engine's per-repo lock so it can't race the poller.
export const pullAllKbNow = handle.pullAllNow;

/// Push every local file in one collection's folder to the cloud. Caller
/// is the Sync tab's commit handler (in `pushAll.ts`), which iterates
/// over `getSyncStatus().collections`. Serialises against pull on the
/// per-collection lock.
export const pushAllToKb = handle.pushOne;

// ---------------------------------------------------------------------------
// Conflict prompt builder — KB-only. Walks every active collection's
// folder so orphan shadows from a previous session aren't missed.
// ---------------------------------------------------------------------------

function canonicalSiblingSet(files: { filename: string }[]): Set<string> {
  return new Set(files.map((f) => f.filename));
}

/// Prompt text for Claude Code to resolve KB merge conflicts (pairs
/// yours vs server shadow). Per-collection paths so multi-KB conflicts
/// route to the right `knowledge-bases/<name>/` folder.
export async function buildKbConflictPrompt(repo: string): Promise<string> {
  const sync = getSyncStatus();
  const lines: string[] = [];

  // status.conflicts is the flattened union across collections; tag
  // each with its collection by walking collections and looking up
  // matching prefixes in the conflict bus. The orchestrator stores
  // each conflict's prefix as `knowledge-bases/<displayName>` so we
  // can route on that. Engine-side `subscribeConflicts` exposes the
  // prefix on each `AggregatedConflict`, but the local KB status
  // ConflictFile only carries `filename` — so iterate per collection
  // and map filenames to that collection's subdir.
  for (const collection of sync.collections) {
    const dir = collectionLocalDir(collection);
    const local = await entityListLocal(repo, dir).catch(() => []);
    const siblings = canonicalSiblingSet(local);
    const shadowNames = local
      .map((f) => f.filename)
      .filter((n) => classifyAsShadow(n, siblings));
    // Pair every shadow on disk with its canonical filename. This
    // captures BOTH currently-tracked conflicts AND orphan shadows
    // from a previous session.
    for (const sh of shadowNames) {
      const base = kbBaseFromShadowFilename(sh);
      lines.push(`- ${dir}/${base} (yours) vs ${dir}/${sh} (server)`);
    }
  }

  if (lines.length === 0) return "";
  return `There are merge conflicts in the knowledge base. For each pair below, read both files, merge them intelligently into the main file (the one without ".server." in the name), then delete the .server. shadow file(s).

${lines.join("\n")}

For binary files (e.g. PDF), pick the correct version or replace manually, then delete the shadow file.`;
}

// ---------------------------------------------------------------------------
// Push implementation — KB-specific upload + git-status-aware dirty
// detection + post-push remote_version refresh.
// ---------------------------------------------------------------------------

async function pushAllToKbImpl(args: {
  creds: PinkfishCreds;
  repo: string;
  collection: KbCollection;
  onLine?: (msg: string) => void;
}): Promise<{ pushed: number; failed: number }> {
  const { creds, repo, collection, onLine } = args;
  const dir = collectionLocalDir(collection);

  const token = getToken();
  if (!token) {
    onLine?.(`✗ kb push (${displayKbName(collection.name)}): not authenticated`);
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);

  const local = await entityListLocal(repo, dir);
  const persisted = await loadCollectionManifest(repo, "kb", collection.id);

  // Use git status (content hash) instead of mtime alone to decide what
  // to push. Files git reports as modified/untracked under this
  // collection's dir are the ones that actually changed since the last
  // commit. Per-collection scoping prevents one collection's commit
  // from clearing another's "needs push" set.
  const gitFiles = await gitStatusShort(repo).catch(() => []);
  const dirtyPaths = new Set(
    gitFiles
      .filter((g) => g.path.startsWith(`${dir}/`))
      .map((g) => g.path.slice(`${dir}/`.length)),
  );

  const siblings = canonicalSiblingSet(local);
  const toPush = local.filter((f) => {
    if (classifyAsShadow(f.filename, siblings)) return false;
    const tracked = persisted.files[f.filename];
    if (!tracked) return true;
    if (dirtyPaths.has(f.filename)) return true;
    if (f.mtime_ms != null && f.mtime_ms > tracked.pulled_at_mtime_ms)
      return true;
    return false;
  });

  if (toPush.length === 0) {
    onLine?.(`▸ kb push (${displayKbName(collection.name)}): nothing new to upload`);
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;
  const pushedNames = new Set<string>();

  for (const f of toPush) {
    try {
      onLine?.(`▸ uploading ${dir}/${f.filename}`);
      await kbUploadFile({
        repo,
        filename: f.filename,
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
        subdir: dir,
      });
      persisted.files[f.filename] = {
        remote_version: new Date().toISOString(),
        pulled_at_mtime_ms: f.mtime_ms ?? Date.now(),
      };
      pushedNames.add(f.filename);
      pushed += 1;
    } catch (e) {
      failed += 1;
      onLine?.(`✗ ${dir}/${f.filename}: ${String(e)}`);
    }
  }

  // Reconcile remote_version after push: refresh from server's
  // authoritative updatedAt so the next pull doesn't false-flag a
  // conflict.
  if (pushedNames.size > 0) {
    try {
      const remote = await kbListRemote({
        collectionId: collection.id,
        skillsBaseUrl: urls.skillsBaseUrl,
        accessToken: token.accessToken,
      });
      for (const r of remote) {
        if (pushedNames.has(r.filename) && r.updated_at) {
          const tracked = persisted.files[r.filename];
          if (tracked) tracked.remote_version = r.updated_at;
        }
      }
    } catch (e) {
      console.warn(`[kb:${collection.id}] post-push remote-version sync failed:`, e);
    }
  }

  await saveCollectionManifest(repo, "kb", collection.id, collection.name, persisted);

  if (pushedNames.size > 0) {
    const ts = new Date().toISOString();
    const paths = Array.from(pushedNames).map((n) => `${dir}/${n}`);
    await commitTouched(repo, paths, `sync: deployed @ ${ts}`);
  }
  return { pushed, failed };
}
