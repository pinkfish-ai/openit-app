// Per-collection manifest management for filestore sync.
// Fixes the architecture issue where all collections shared one manifest file
// and overwrote each other's state.
//
// Solution: Nested manifest structure
// File: .openit/fs-state.json
// Structure: { [collectionId]: { collection_id, collection_name, files } }
//
// Each collection's state is preserved independently, preventing:
// - One collection's sync from clearing another's file tracking
// - Loss of conflict detection data
// - Unnecessary re-downloads on every sync

import type { KbStatePersisted } from "./api";
import { fsStoreStateLoad, fsStoreStateSave } from "./api";

export type FilestoreManifestRoot = {
  [collectionId: string]: KbStatePersisted;
};

/// Load the manifest for a specific collection from the shared root manifest.
/// If the root doesn't exist, returns default for this collection.
/// If root exists but this collection isn't in it, returns default for this collection.
/// Preserves all other collections' state in the file.
export async function loadCollectionManifest(
  repo: string,
  collectionId: string,
): Promise<KbStatePersisted> {
  try {
    // Load the entire root manifest
    const root = await fsStoreStateLoad(repo);

    // In the current (broken) format, root has collection_id at top level
    // We need to handle the migration: if root.collection_id exists (old format),
    // convert to new nested format
    if (root.collection_id && !isNestedFormat(root)) {
      console.log("[filestoreManifest] migrating from single-collection to nested format");
      // This is the old format - treat as belonging to a specific collection
      // For now, we'll use the loaded manifest for this collection
      // Next sync will write it in new format
      return root;
    }

    // New nested format: { [collectionId]: KbStatePersisted }
    if (isNestedFormat(root)) {
      const nested = root as unknown as FilestoreManifestRoot;
      if (nested[collectionId]) {
        return nested[collectionId];
      }
      // Collection not in manifest yet, return default
      return defaultManifest(collectionId);
    }

    // If we get here, something is wrong
    return defaultManifest(collectionId);
  } catch (e) {
    // File doesn't exist or can't be parsed - start fresh
    console.log("[filestoreManifest] error loading manifest, starting fresh:", e);
    return defaultManifest(collectionId);
  }
}

/// Save the manifest for a specific collection, preserving all other collections.
/// Loads the root, updates this collection's entry, saves root.
export async function saveCollectionManifest(
  repo: string,
  collectionId: string,
  collectionName: string,
  manifest: KbStatePersisted,
): Promise<void> {
  try {
    // Load current root manifest
    let root: FilestoreManifestRoot = {};
    try {
      const loaded = await fsStoreStateLoad(repo);
      // Check if it's nested format
      if (isNestedFormat(loaded)) {
        root = loaded as unknown as FilestoreManifestRoot;
      } else {
        // Old format - initialize new nested structure
        root = {};
      }
    } catch {
      // Manifest doesn't exist yet - start fresh
      root = {};
    }

    // Update this collection's entry
    root[collectionId] = {
      ...manifest,
      collection_id: collectionId,
      collection_name: collectionName,
    };

    // Save the updated root
    // We need to save in a way that preserves the nested structure
    // fsStoreStateSave expects KbStatePersisted, so we cast
    await fsStoreStateSave(repo, root as unknown as KbStatePersisted);
  } catch (e) {
    console.error("[filestoreManifest] failed to save manifest for", collectionId, e);
    throw e;
  }
}

/// Check if manifest is in new nested format or old single-collection format
function isNestedFormat(manifest: unknown): boolean {
  // New format: all top-level values are objects with files property
  // Old format: has collection_id and files at top level
  const m = manifest as Record<string, unknown>;

  // If it has collection_id at top level, it's old format
  if (m.collection_id && typeof m.collection_id === "string") {
    return false;
  }

  // If all values are objects with files property, it's new format
  const values = Object.values(m);
  return values.length > 0 && values.every((v) => isKbStatePersisted(v));
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
