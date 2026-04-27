// Pinkfish push pipeline shared by the Sync tab and the
// `.openit/push-request.json` trigger flow (the latter is what
// `scripts/openit-plugin/sync-push.mjs` drives).
//
// KB and filestore use their existing push functions; datastores use
// pushAllToDatastores. We pre-pull each entity to surface conflicts
// before clobbering teammate edits, then push and stream results.

import { getSyncStatus, kbHasServerShadowFiles, pullNow, pushAllToKb, startKbSync } from "./kbSync";
import {
  pushAllToFilestore,
  getFilestoreSyncStatus,
  pullOnce as filestorePullOnce,
} from "./filestoreSync";
import { pushAllToDatastores, pullDatastoresOnce } from "./datastoreSync";
import { loadCreds } from "./pinkfishAuth";

export async function pushAllEntities(
  repo: string,
  onLine: (line: string) => void,
): Promise<void> {
  const creds = await loadCreds().catch(() => null);
  if (!creds) {
    onLine("✗ sync: not authenticated");
    return;
  }

  onLine("▸ sync: starting push to Pinkfish");

  // KB requires a resolved collection; if sync hasn't run yet (e.g. user
  // commits before the initial pull completes), kick it off inline.
  let kbCollection = getSyncStatus().collection;
  if (!kbCollection) {
    onLine("▸ sync: resolving knowledge base");
    try {
      const slug = (repo.split("/").pop() ?? "").trim();
      await startKbSync({ creds, repo, orgSlug: slug, orgName: slug });
      kbCollection = getSyncStatus().collection;
    } catch (e) {
      onLine(`✗ sync: kb resolve failed: ${String(e)}`);
    }
  }

  // KB: pre-pull to detect remote/local conflicts before we clobber anything.
  if (kbCollection) {
    const shadowBefore = await kbHasServerShadowFiles(repo);
    if (shadowBefore) {
      onLine(
        "✗ sync: kb has unresolved merge shadow (.server.) files — resolve and commit again",
      );
    } else {
      onLine("▸ sync: kb pre-push pull");
      try {
        await pullNow({ creds, repo, collection: kbCollection });
        const conflicts = getSyncStatus().conflicts;
        const hasShadow = await kbHasServerShadowFiles(repo);
        if (conflicts.length > 0 || hasShadow) {
          onLine(
            "✗ sync: kb pull surfaced conflicts — resolve in Claude, then commit again:",
          );
          for (const c of conflicts) onLine(`  • ${c.filename}: ${c.reason}`);
          if (hasShadow && conflicts.length === 0) {
            onLine("  • server shadow files present under knowledge-bases/default/");
          }
        } else {
          onLine("▸ sync: kb pushing");
          try {
            const { pushed, failed } = await pushAllToKb({
              creds,
              repo,
              collection: kbCollection,
              onLine,
            });
            onLine(`▸ sync: kb push complete — ${pushed} ok, ${failed} failed`);
          } catch (e) {
            onLine(`✗ sync: kb push failed: ${String(e)}`);
          }
        }
      } catch (e) {
        onLine(`✗ sync: kb pull failed: ${String(e)}`);
      }
    }
  } else {
    onLine("▸ sync: kb skipped (no collection)");
  }

  // Filestore: pre-push pull to detect remote-side edits before we
  // clobber them. Same pattern as KB above.
  const fsCollections = getFilestoreSyncStatus().collections;
  if (fsCollections.length > 0) {
    for (const collection of fsCollections) {
      onLine(`▸ sync: filestore (${collection.name}) pre-push pull`);
      let safe = true;
      try {
        const { ok, error, downloaded } = await filestorePullOnce({
          creds,
          repo,
          collection,
        });
        const conflicts = getFilestoreSyncStatus().conflicts;
        if (!ok) {
          // pullOnce never throws; check ok explicitly. Without this
          // a network/auth failure would leave conflicts empty AND no
          // catch fires — push would silently proceed and clobber.
          safe = false;
          onLine(
            `✗ sync: filestore (${collection.name}) pre-push pull failed: ${error ?? "unknown"}`,
          );
        } else if (conflicts.length > 0) {
          safe = false;
          onLine(
            `✗ sync: filestore (${collection.name}) pull surfaced conflicts — resolve in Claude, then commit again:`,
          );
          for (const c of conflicts) onLine(`  • ${c.filename}: ${c.reason}`);
        } else if (downloaded > 0) {
          onLine(`  ✓ pulled ${downloaded} file(s) before push`);
        }
      } catch (e) {
        safe = false;
        onLine(`✗ sync: filestore (${collection.name}) pre-push pull failed: ${String(e)}`);
      }
      if (!safe) continue;

      onLine(`▸ sync: filestore (${collection.name}) pushing`);
      try {
        const { pushed, failed } = await pushAllToFilestore({
          creds,
          repo,
          collection,
          onLine,
        });
        onLine(
          `▸ sync: filestore push (${collection.name}) — ${pushed} ok, ${failed} failed`,
        );
      } catch (e) {
        onLine(`✗ sync: filestore push (${collection.name}) failed: ${String(e)}`);
      }
    }
  } else {
    onLine("▸ sync: filestore skipped (no collections)");
  }

  // Datastore: pre-push pull. Without this, user A's edit silently
  // overwrites user B's remote edit when both sides changed since the
  // last sync.
  onLine("▸ sync: datastores pre-push pull");
  let datastorePushSafe = true;
  try {
    const { ok, error, pulled, conflicts } = await pullDatastoresOnce({ creds, repo });
    if (!ok) {
      datastorePushSafe = false;
      onLine(`✗ sync: datastores pre-push pull failed: ${error ?? "unknown"}`);
    } else if (conflicts.length > 0) {
      datastorePushSafe = false;
      onLine(
        "✗ sync: datastores pull surfaced conflicts — resolve in Claude, then commit again:",
      );
      for (const c of conflicts) {
        onLine(`  • ${c.collectionName}/${c.key}.json: ${c.reason}`);
      }
    } else if (pulled > 0) {
      onLine(`  ✓ pulled ${pulled} row(s) before push`);
    }
  } catch (e) {
    datastorePushSafe = false;
    onLine(`✗ sync: datastores pre-push pull failed: ${String(e)}`);
  }

  if (datastorePushSafe) {
    onLine("▸ sync: datastores pushing");
    try {
      const { pushed, failed } = await pushAllToDatastores({ creds, repo, onLine });
      onLine(`▸ sync: datastore push complete — ${pushed} ok, ${failed} failed`);
    } catch (e) {
      onLine(`✗ sync: datastore push failed: ${String(e)}`);
    }
  }

  onLine("▸ sync: done");
}
