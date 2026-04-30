// Shared path helpers for the datastore sync engine.
//
// Lives separately from `datastoreSync.ts` and `entities/datastore.ts`
// so both can import without a circular reference (datastoreSync depends
// on the adapter in entities/datastore, which needs the same mapping).

/// Map a cloud collection name to its local working-tree folder.
/// `openit-tickets` → `databases/tickets`. The `openit-` prefix is a
/// cloud-side discovery hint; on disk we want the readable folder name.
export function localSubdirFor(collectionName: string): string {
  const folder = collectionName.startsWith("openit-")
    ? collectionName.slice("openit-".length)
    : collectionName;
  return `databases/${folder}`;
}

/// The unstructured per-message conversation collection. Singled out
/// because it's the only datastore that uses a nested local layout
/// (`databases/conversations/<ticketId>/<msgId>.json`).
export const CONVERSATIONS_COLLECTION_NAME = "openit-conversations";
