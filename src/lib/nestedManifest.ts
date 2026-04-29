// Per-collection manifest management for any entity sync (filestore, KB,
// future row-based engines). Replaces the filestore-specific
// filestoreManifest.ts since the on-disk shape is engine-agnostic — only
// the entity-state filename differs (`.openit/fs-state.json` vs
// `.openit/kb-state.json`).
//
// Solution: nested manifest structure
// File:      `.openit/<entityName>-state.json`
// Structure: `{ [collectionId]: { collection_id, collection_name, files } }`
//
// Each collection's state is preserved independently, preventing:
// - one collection's sync from clearing another's file tracking
// - loss of conflict detection data
// - unnecessary re-downloads on every sync

import type { KbStatePersisted } from "./api";
import {
  fsStoreStateLoad,
  fsStoreStateSave,
  kbStateLoad,
  kbStateSave,
} from "./api";

/// Entity-state file name — the per-engine state file under .openit/.
/// `fs` → `.openit/fs-state.json`, `kb` → `.openit/kb-state.json`.
export type EntityName = "fs" | "kb";

export type NestedManifestRoot = {
  [collectionId: string]: KbStatePersisted;
};

const loaders: Record<EntityName, (repo: string) => Promise<KbStatePersisted>> = {
  fs: fsStoreStateLoad,
  kb: kbStateLoad,
};

const savers: Record<
  EntityName,
  (repo: string, state: KbStatePersisted) => Promise<void>
> = {
  fs: fsStoreStateSave,
  kb: kbStateSave,
};

/// Per-repo+entity serialisation for the manifest read-modify-write.
/// The engine's `withRepoLock` keys on `adapter.prefix`, which is unique
/// per collection — fine for the per-collection working tree, but two
/// pollers can still race on the *shared* root manifest at
/// `.openit/<entity>-state.json`. Without this queue, both reads see the
/// same snapshot, each writes only its own slot, and the second write
/// silently drops the first's update. Promise chain keyed by
/// `${repo}|${entity}` keeps every load/save pair atomic across all
/// collections in that repo+entity.
const manifestLocks = new Map<string, Promise<unknown>>();

function withManifestLock<T>(
  repo: string,
  entityName: EntityName,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${repo}|${entityName}`;
  const previous = manifestLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  manifestLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/// Load the manifest for one collection out of the shared per-entity root
/// manifest. If the root file is missing, unparseable, or in the legacy
/// flat format (pre-Phase-1 single-collection writers), return a default
/// for this collection — the engine will treat it as a fresh collection
/// and re-fetch. Other collections' entries are preserved untouched.
export async function loadCollectionManifest(
  repo: string,
  entityName: EntityName,
  collectionId: string,
): Promise<KbStatePersisted> {
  return withManifestLock(repo, entityName, () =>
    loadCollectionManifestImpl(repo, entityName, collectionId),
  );
}

async function loadCollectionManifestImpl(
  repo: string,
  entityName: EntityName,
  collectionId: string,
): Promise<KbStatePersisted> {
  try {
    const root = await loaders[entityName](repo);

    // Legacy flat format: `collection_id` lives at the top level.
    // Pre-Phase-1 single-collection writers wrote this shape. With the
    // nested format these fields belong inside one of the buckets, not
    // at the root. Drop the legacy data and start fresh for this
    // collection — engine re-fetches.
    if (root.collection_id && !isNestedFormat(root)) {
      console.log(
        `[nestedManifest] migrating ${entityName} from flat to nested format`,
      );
      return defaultManifest(collectionId);
    }

    if (isNestedFormat(root)) {
      const nested = root as unknown as NestedManifestRoot;
      if (nested[collectionId]) return nested[collectionId];
      return defaultManifest(collectionId);
    }

    return defaultManifest(collectionId);
  } catch (e) {
    console.log(
      `[nestedManifest] error loading ${entityName} manifest, starting fresh:`,
      e,
    );
    return defaultManifest(collectionId);
  }
}

/// Save one collection's manifest into the shared per-entity root
/// manifest, preserving all other collections. Read-modify-write — the
/// pair is serialised through `withManifestLock` so concurrent writes
/// from sibling collections never overlap.
export async function saveCollectionManifest(
  repo: string,
  entityName: EntityName,
  collectionId: string,
  collectionName: string,
  manifest: KbStatePersisted,
): Promise<void> {
  return withManifestLock(repo, entityName, () =>
    saveCollectionManifestImpl(
      repo,
      entityName,
      collectionId,
      collectionName,
      manifest,
    ),
  );
}

async function saveCollectionManifestImpl(
  repo: string,
  entityName: EntityName,
  collectionId: string,
  collectionName: string,
  manifest: KbStatePersisted,
): Promise<void> {
  let root: NestedManifestRoot = {};
  try {
    const loaded = await loaders[entityName](repo);
    if (isNestedFormat(loaded)) {
      root = loaded as unknown as NestedManifestRoot;
    }
    // Old flat format → drop it, build a fresh nested root with just
    // this collection. Other (non-existent) collections have no state
    // to lose.
  } catch {
    // File doesn't exist yet — start fresh.
  }

  root[collectionId] = {
    ...manifest,
    collection_id: collectionId,
    collection_name: collectionName,
  };

  // The Tauri command's parameter type is the flat `KbStatePersisted`
  // (the shape was repurposed before nesting existed); cast through
  // unknown so serde sees the nested root we actually want on disk.
  await savers[entityName](repo, root as unknown as KbStatePersisted);
}

function isNestedFormat(manifest: unknown): boolean {
  const m = manifest as Record<string, unknown>;
  if (m.collection_id && typeof m.collection_id === "string") return false;
  const values = Object.values(m);
  return values.length > 0 && values.every(isKbStatePersisted);
}

function isKbStatePersisted(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return "collection_id" in o && "files" in o && typeof o.files === "object";
}

function defaultManifest(collectionId: string): KbStatePersisted {
  return {
    collection_id: collectionId,
    collection_name: "",
    files: {},
  };
}
