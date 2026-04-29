// KB collection resolution. Phase 2 of V2 sync (PIN-5775) shifts this
// off the `knowledge-base` MCP and onto the same REST `/datacollection/`
// endpoint the filestore engine uses. Pinkfish-entity CRUD goes REST per
// the project's auth/decision tree (see auto-dev/00-autodev-overview.md).
//
// The actual resolver (REST list + openit-* prefix filter + dedupe +
// auto-create defaults) lives inside the shared
// `createCollectionEntitySync` helper in syncEngine.ts. This file owns
// the small public types and a couple of helpers (display-name strip,
// the OPENIT_KB_PREFIX constant) that consumer code references.

export type KbCollection = {
  id: string;
  name: string;
  description?: string;
};

/// Prefix every OpenIT-managed KB carries on the cloud. Used to filter
/// the user's full collection list down to the ones we own. Mirrors
/// `OPENIT_FILESTORE_PREFIX` from filestoreSync.ts.
export const OPENIT_KB_PREFIX = "openit-";

/// Strip the `openit-` prefix for display in the UI / log lines.
/// Returns the input unchanged when the prefix is absent.
export function displayKbName(name: string): string {
  return name.startsWith(OPENIT_KB_PREFIX)
    ? name.slice(OPENIT_KB_PREFIX.length)
    : name;
}
