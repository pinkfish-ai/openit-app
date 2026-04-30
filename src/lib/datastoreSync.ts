// Datastore sync wrapper. Pull pipeline + auto-commit + conflict shadow
// live in `syncEngine.ts` driven by `datastoreAdapter`. This file owns:
//   - Resolve (find or create the openit-* datastore collections, with the
//     same 409-conflict + eventual-consistency handling as filestore).
//   - Schema-on-disk write (`_schema.json` per collection) — runs as a
//     side-effect of startDatastoreSync since schemas have no `updatedAt`
//     and don't fit the engine's version-diff model.
//   - Push (full reconcile per collection — POST new, PUT changed, DELETE
//     missing — with paginated post-push manifest reconcile).
//   - Lifecycle: 60s poll wired through the engine.
//
// Per-repo serialization is provided by `withRepoLock(repo, "datastore")`
// from the engine. All entry points (pull, push, schema-write, bootstrap)
// serialize on the same lock (iter-5 / iter-12 BugBot fixes).

import {
  getCollection,
  type DataCollection,
  type MemoryBqueryResponse,
  type MemoryItem,
} from "./skillsApi";
import {
  datastoreStateLoad,
  datastoreStateSave,
  entityWriteFile,
  fsList,
  fsRead,
  projectUpdateLastSyncAt,
  type KbStatePersisted,
} from "./api";
import { derivedUrls, getToken, type PinkfishCreds } from "./pinkfishAuth";
import { makeSkillsFetch } from "../api/fetchAdapter";
import { datastoreAdapter } from "./entities/datastore";
import { fetchDatastoreItems } from "./entities/datastoreApi";
import { fetchSkillFile } from "./skillsSync";
import {
  classifyAsShadow,
  clearConflictsForPrefix,
  DEFAULT_POLL_INTERVAL_MS,
  pullEntity,
  withRepoLock,
  type EntityAdapter,
} from "./syncEngine";
import {
  CONVERSATIONS_COLLECTION_NAME,
  localSubdirFor,
} from "./datastorePaths";

export { localSubdirFor };

export { fetchDatastoreItems };

type CreateCollectionResponse = {
  message?: string;
  id?: string | number;
  schema?: Record<string, unknown>;
  isStructured?: boolean;
  [key: string]: unknown;
};

type ListCollectionsResponse = DataCollection[] | null;

type DefaultDatastore = {
  name: string;
  /** Cloud template — only set for structured collections that want
   *  template data populated. Left null for the OpenIT defaults: we
   *  ship our own bundled schema and don't want sample rows. */
  templateId: string | null;
  description: string;
  isStructured: boolean;
  /** Plugin-manifest path (under `scripts/openit-plugin/`) of the
   *  bundled `_schema.json`. Loaded at create-time via `fetchSkillFile`
   *  so the cloud collection lands structured against the same fields
   *  the disk-side `databases/<col>/_schema.json` describes. Null for
   *  unstructured collections. */
  schemaPath: string | null;
};

// `openit-tickets` and `openit-people` are **structured**: each ships a
// bundled `_schema.json` (under `scripts/openit-plugin/schemas/`) that
// the resolver loads and includes in the create-collection POST body.
// Cloud fix #1 (firebase-helpers PR #462) makes the cloud honor that
// schema and skip the auto-template injection.
//
// `openit-conversations` is **unstructured**: per-message rows are
// freeform JSON keyed by msgId, with the parent `ticketId` carried in
// `content.ticketId`. The local layout is nested
// (`databases/conversations/<ticketId>/<msgId>.json`); the engine
// adapter explodes by `content.ticketId` on pull and composes back on
// push.
const DEFAULT_DATASTORES: DefaultDatastore[] = [
  {
    name: "openit-tickets",
    templateId: null,
    description: "IT ticket tracking",
    isStructured: true,
    schemaPath: "schemas/tickets._schema.json",
  },
  {
    name: "openit-people",
    templateId: null,
    description: "Contact/people directory",
    isStructured: true,
    schemaPath: "schemas/people._schema.json",
  },
  {
    name: "openit-conversations",
    templateId: null,
    description: "Per-message conversation turns",
    isStructured: false,
    schemaPath: null,
  },
];

/// Load a default's bundled `_schema.json` and shape it for the cloud
/// `POST /datacollection/` body. Returns `null` if the schema isn't
/// applicable (unstructured) or fails to load (caller continues without
/// — auto-template behavior on the cloud already short-circuits because
/// `templateId` is null).
async function loadBundledSchema(
  def: DefaultDatastore,
  creds: PinkfishCreds,
): Promise<{ fields: Array<Record<string, unknown>>; nextFieldId: number } | null> {
  if (!def.schemaPath) return null;
  try {
    const raw = await fetchSkillFile(def.schemaPath, creds);
    const parsed = JSON.parse(raw) as {
      fields?: Array<Record<string, unknown>>;
      nextFieldId?: number;
    };
    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    if (fields.length === 0) return null;
    // Honor an explicit `nextFieldId` from the schema file (cloud uses it
    // to allocate the next `f_N`-style id when admins add fields). If the
    // file omits it (current bundled schemas do — all ids are semantic),
    // fall back to a count-based default so the first cloud-generated
    // field doesn't collide with anything we shipped.
    const nextFieldId =
      typeof parsed.nextFieldId === "number" && Number.isFinite(parsed.nextFieldId)
        ? parsed.nextFieldId
        : fields.length + 1;
    return { fields, nextFieldId };
  } catch (err) {
    console.warn(`[datastoreSync] failed to load bundled schema ${def.schemaPath}:`, err);
    return null;
  }
}

// `localSubdirFor` and `CONVERSATIONS_COLLECTION_NAME` live in
// `./datastorePaths` so the adapter (`entities/datastore.ts`) can share
// them without a circular import.

// Org-scoped cache to prevent collections from one org leaking into another.
let createdCollections = new Map<string, Map<string, DataCollection>>();
let lastCreationAttemptTime = new Map<string, number>();

// Per-org in-flight resolve promise — concurrent callers share the same
// operation so we never race two list-then-create sequences.
const inflightResolve = new Map<string, Promise<DataCollection[]>>();

function getOrgCache(orgId: string): Map<string, DataCollection> {
  if (!createdCollections.has(orgId)) {
    createdCollections.set(orgId, new Map());
  }
  return createdCollections.get(orgId)!;
}

function getLastCreationTime(orgId: string): number {
  return lastCreationAttemptTime.get(orgId) ?? 0;
}

function setLastCreationTime(orgId: string, time: number): void {
  lastCreationAttemptTime.set(orgId, time);
}

const CREATION_COOLDOWN_MS = 10_000;

export async function resolveProjectDatastores(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<DataCollection[]> {
  const existing = inflightResolve.get(creds.orgId);
  if (existing) {
    console.log("[datastoreSync] joining in-flight resolve for org:", creds.orgId);
    return existing;
  }
  const promise = resolveProjectDatastoresImpl(creds, onLog);
  inflightResolve.set(creds.orgId, promise);
  try {
    return await promise;
  } finally {
    inflightResolve.delete(creds.orgId);
  }
}

async function resolveProjectDatastoresImpl(
  creds: PinkfishCreds,
  onLog?: (msg: string) => void,
): Promise<DataCollection[]> {
  console.log("[datastoreSync] resolveProjectDatastores called for org:", creds.orgId);
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  try {
    const fetchFn = makeSkillsFetch(token.accessToken);
    const url = new URL("/datacollection/", urls.skillsBaseUrl);
    url.searchParams.set("type", "datastore");
    console.log("[datastoreSync] Fetching from:", url.toString());
    const response = await fetchFn(url.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as DataCollection[] | null;
    const allCollections = Array.isArray(result) ? result : [];
    console.log(`[datastoreSync] ✓ Found ${allCollections.length} datastore collections`);
    allCollections.forEach((c: DataCollection) => console.log(`  • ${c.name} (id: ${c.id})`));
    // Multi-collection discovery — every `openit-*` datastore syncs, not
    // just the hardcoded defaults. Auto-create still seeds any of the
    // three defaults that are missing.
    const defaults: DefaultDatastore[] = DEFAULT_DATASTORES;
    let matching = allCollections.filter((c: DataCollection) =>
      typeof c.name === "string" && c.name.startsWith("openit-"),
    );
    console.log(`[datastoreSync] ✓ openit-* datastore collections: ${matching.length}`);

    const orgCache = getOrgCache(creds.orgId);

    // Cache whatever we found — even if some defaults are missing, we'll
    // top them up below and return the union.
    for (const m of matching) {
      orgCache.set(m.name, m);
      onLog?.(`  ✓ ${m.name}  (id: ${m.id})`);
    }

    // Determine which defaults are missing and need auto-creation.
    const presentNames = new Set(matching.map((c) => c.name));
    const missingDefaults = defaults.filter((d) => !presentNames.has(d.name));

    if (missingDefaults.length === 0) {
      return matching;
    }

    const now = Date.now();
    const lastCreationTime = getLastCreationTime(creds.orgId);
    if (orgCache.size > 0 && now - lastCreationTime < CREATION_COOLDOWN_MS) {
      console.log("[datastoreSync] collections not yet visible in API list, returning cached collections");
      return Array.from(orgCache.values());
    }

    if (now - lastCreationTime < CREATION_COOLDOWN_MS) {
      console.log("[datastoreSync] skipping creation (cooldown active)");
      return Array.from(orgCache.values());
    }

    console.log(
      `[datastoreSync] creating ${missingDefaults.length} missing default(s): ${missingDefaults.map((d) => d.name).join(", ")}`,
    );
    setLastCreationTime(creds.orgId, now);
    let conflictHit = false;
    for (const def of missingDefaults) {
      try {
        const createUrl = new URL("/datacollection/", urls.skillsBaseUrl);
        const body: Record<string, unknown> = {
          name: def.name,
          type: "datastore",
          description: def.description,
          createdBy: creds.orgId,
          createdByName: "OpenIT",
          triggerUrls: [],
          isStructured: def.isStructured,
        };
        if (def.templateId) {
          body.templateId = def.templateId;
        }
        // Load the bundled schema for structured defaults so the cloud
        // collection lands with the right fields. Cloud fix #1 (PR #462)
        // makes the server honor this and skip the auto-template path.
        const schema = await loadBundledSchema(def, creds);
        if (schema) {
          body.schema = schema;
        }
        const createResponse = await fetchFn(createUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        console.log(`[datastoreSync] POST /datacollection/ response status: ${createResponse.status} ${createResponse.statusText}`);

        if (!createResponse.ok) {
          const errText = await createResponse.text();
          console.error("[datastoreSync] response error:", errText);
          if (createResponse.status === 409) {
            console.log(`[datastoreSync] collection ${def.name} already exists (409) — will refetch`);
            conflictHit = true;
            continue;
          }
          throw new Error(`HTTP ${createResponse.status}: ${createResponse.statusText}`);
        }

        let createResult: CreateCollectionResponse | null;
        try {
          createResult = (await createResponse.json()) as CreateCollectionResponse | null;
        } catch (e) {
          console.error("[datastoreSync] failed to parse create response JSON:", e);
          throw new Error(`Failed to parse collection creation response: ${e}`);
        }

        console.log(`[datastoreSync] create response for ${def.name}:`, JSON.stringify(createResult));

        const idAny = createResult?.id as string | number | undefined;
        const id = idAny != null ? String(idAny) : undefined;
        if (id) {
          const col = {
            id,
            name: def.name,
            type: "datastore",
            description: def.description,
            isStructured: def.isStructured,
          } as DataCollection;
          matching.push(col);
          orgCache.set(def.name, col);
          console.log(`[datastoreSync] cached ${def.name} with id: ${id}`);
          onLog?.(`  + ${def.name}  (id: ${id})  [created]`);
        } else {
          console.warn(`[datastoreSync] no id found in response for ${def.name}. Response keys:`, Object.keys(createResult || {}));
        }
      } catch (e) {
        console.warn(`[datastoreSync] failed to create ${def.name}:`, e);
      }
    }

    if (matching.length > 0 || conflictHit) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const refetchUrl = new URL("/datacollection/", urls.skillsBaseUrl);
        refetchUrl.searchParams.set("type", "datastore");
        const refetchResponse = await fetchFn(refetchUrl.toString());

        let refetchResult: ListCollectionsResponse;
        try {
          refetchResult = (await refetchResponse.json()) as ListCollectionsResponse;
        } catch (e) {
          console.error("[datastoreSync] failed to parse refetch response JSON:", e);
          throw new Error(`Failed to parse refetch response: ${e}`);
        }

        const refetched = Array.isArray(refetchResult) ? refetchResult : [];
        const updatedMatching = refetched.filter(
          (c: DataCollection) => typeof c.name === "string" && c.name.startsWith("openit-"),
        );
        if (updatedMatching.length >= matching.length && updatedMatching.length > 0) {
          console.log("[datastoreSync] re-fetched collections after creation");
          for (const m of updatedMatching) orgCache.set(m.name, m);
          return updatedMatching;
        }
        if (conflictHit && matching.length === 0) {
          console.warn("[datastoreSync] 409 conflict but refetch still returned no matches — API may be lagging");
        }
      } catch (e) {
        console.warn("[datastoreSync] failed to re-fetch after creation:", e);
      }
    }

    return matching;
  } catch (error) {
    console.log("----END DATASTORE SYNC (error)----");
    console.error("[datastoreSync] resolveProjectDatastores failed:", error);
    throw error;
  }
}

export async function fetchDatastoreSchema(
  creds: PinkfishCreds,
  collectionId: string,
): Promise<any> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);

  const collection = await getCollection(urls.skillsBaseUrl, token.accessToken, collectionId);
  return collection.schema;
}

// ---------------------------------------------------------------------------
// Schema write — `_schema.json` per collection. Schemas have no `updatedAt`
// so they don't fit the engine's version-diff model; we write them once on
// every startDatastoreSync as a content-equality side-effect. Cheap (one
// fs read + maybe one write per collection) and idempotent.
//
// Row-seeding logic that used to live alongside this is gone: the engine's
// bootstrap-adoption case (`!tracked && localFile`) handles already-on-disk
// rows during the first pull, and brand-new rows are written by the engine
// pipeline itself.
// ---------------------------------------------------------------------------

async function writeDatastoreSchemas(
  repo: string,
  collections: DataCollection[],
): Promise<{ written: number; unchanged: number }> {
  return withRepoLock(repo, "datastore", async () => {
    let written = 0;
    let unchanged = 0;
    for (const col of collections) {
      // Unstructured collections (e.g. openit-conversations) carry no
      // schema and don't get a `_schema.json` written. Structured ones
      // without a server-side schema also skip — there's nothing to write.
      if (col.isStructured === false) continue;
      if (!col.schema) continue;
      const subdir = localSubdirFor(col.name);
      const schemaContent = JSON.stringify(col.schema, null, 2);
      const schemaPath = `${repo}/${subdir}/_schema.json`;
      let existing: string | null = null;
      try { existing = await fsRead(schemaPath); } catch { /* missing */ }
      if (existing !== schemaContent) {
        await entityWriteFile(repo, subdir, "_schema.json", schemaContent);
        written += 1;
      } else {
        unchanged += 1;
      }
    }
    return { written, unchanged };
  });
}

// ---------------------------------------------------------------------------
// Push — upload locally edited datastore rows back to Pinkfish. Strategy
// is full reconcile per collection (POST new, PUT changed, skip
// unchanged, DELETE missing). Engine doesn't help with this surface
// because datastore push needs the per-row remote `id` (delete-by-id
// semantics) which only the live API list returns.
// ---------------------------------------------------------------------------

type PushResult = { pushed: number; failed: number };

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export async function pushAllToDatastores(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine?: (line: string) => void;
}): Promise<PushResult> {
  return withRepoLock(args.repo, "datastore", () => pushAllToDatastoresImpl(args));
}

async function pushAllToDatastoresImpl(args: {
  creds: PinkfishCreds;
  repo: string;
  onLine?: (line: string) => void;
}): Promise<PushResult> {
  const { creds, repo, onLine } = args;
  const token = getToken();
  if (!token) {
    onLine?.("✗ datastore push: not authenticated");
    return { pushed: 0, failed: 0 };
  }
  const urls = derivedUrls(creds.tokenUrl);
  const fetchFn = makeSkillsFetch(token.accessToken);

  const collections = await resolveProjectDatastores(creds);
  if (collections.length === 0) {
    onLine?.("▸ datastore push: no openit-* collections — nothing to push");
    return { pushed: 0, failed: 0 };
  }

  let totalPushed = 0;
  let totalFailed = 0;
  const persisted: KbStatePersisted = await datastoreStateLoad(repo);
  const pushedKeysByCol = new Map<string, Set<string>>();

  for (const col of collections) {
    const colDir = `${repo}/${localSubdirFor(col.name)}`;
    const isConversations = col.name === CONVERSATIONS_COLLECTION_NAME;

    let remote: MemoryItem[];
    try {
      const resp = await fetchDatastoreItems(creds, col.id, 1000, 0);
      remote = resp.items;
    } catch (e) {
      onLine?.(`✗ datastore: list ${col.name} failed: ${String(e)}`);
      totalFailed += 1;
      continue;
    }
    // Cloud rows are addressed by composite (key, sortField). Index
    // remote by the same composite so an upsert finds the right row.
    // For non-conversations collections we mirror sortField=key, so the
    // composite collapses to (key, key) — functionally identical to the
    // legacy single-leg lookup.
    const remoteByComposite = new Map<string, MemoryItem>();
    for (const r of remote) {
      const k = (r.key ?? "").toString();
      const s = (r.sortField ?? "").toString();
      if (k) remoteByComposite.set(`${k}::${s}`, r);
    }

    // Track whether the directory actually exists. If `fsList` throws
    // because the directory doesn't exist yet, an empty `localFiles` does
    // NOT mean "user deleted everything" — skip the deletion phase
    // entirely so we don't nuke remote rows.
    //
    // openit-conversations layout is nested: folder name = ticketId
    // (the cloud row's `key`), filename = msgId (the cloud row's
    // `sortField`). Every other openit-* collection is flat — folder is
    // the collection, filename = key, and we mirror sortField=key.
    type LocalRow = { key: string; sortField: string; absPath: string };
    let localFiles: LocalRow[] = [];
    let localDirExists = true;
    // Tracks whether any per-ticket subfolder listing failed during the
    // conversations walk. We can't distinguish "user emptied this folder"
    // from "fsList errored" from the outside, so any inner-walk error
    // disables the remote-delete phase for this collection — better to
    // skip a deletion than to nuke teammates' rows because of a transient
    // read failure. (PIN-5793 BugBot R4 finding.)
    let innerWalkFailed = false;
    try {
      const topNodes = await fsList(colDir);
      if (isConversations) {
        for (const top of topNodes) {
          if (!top.is_dir) continue;
          const ticketId = top.name;
          let inner;
          try {
            inner = await fsList(top.path);
          } catch (e) {
            console.warn(
              `[datastoreSync] failed to list conversations subfolder ${ticketId}; ` +
                `disabling remote-delete pass for ${col.name} this push:`,
              e,
            );
            innerWalkFailed = true;
            continue;
          }
          const candidateNames = inner
            .filter(
              (n) =>
                !n.is_dir && n.name.endsWith(".json") && n.name !== "_schema.json",
            )
            .map((n) => n.name);
          const siblings = new Set(candidateNames);
          for (const n of inner) {
            if (n.is_dir) continue;
            if (!n.name.endsWith(".json")) continue;
            if (n.name === "_schema.json") continue;
            if (classifyAsShadow(n.name, siblings)) continue;
            const msgId = n.name.replace(/\.json$/, "");
            // Composite (key=ticketId, sortField=msgId) is unique by
            // construction, so two folders with the same msgId push as
            // distinct cloud rows — no first-writer-wins drop needed.
            localFiles.push({ key: ticketId, sortField: msgId, absPath: n.path });
          }
        }
      } else {
        // Build canonical-sibling set (per-collection) so we exclude shadow
        // rows but not legitimate filenames containing `.server.`. A row
        // keyed `nginx.server` produces filename `nginx.server.json`; with
        // no sibling `nginx.json` it should still push.
        const candidateNames = topNodes
          .filter(
            (n) =>
              !n.is_dir && n.name.endsWith(".json") && n.name !== "_schema.json",
          )
          .map((n) => n.name);
        const siblings = new Set(candidateNames);
        localFiles = topNodes
          .filter(
            (n) =>
              !n.is_dir &&
              n.name.endsWith(".json") &&
              n.name !== "_schema.json" &&
              !classifyAsShadow(n.name, siblings),
          )
          .map((n) => {
            const key = n.name.replace(/\.json$/, "");
            // Mirror: sortField = key. Stops the cloud's auto-stamp
            // path (firebase-helpers owner.ts:174-176) so storage
            // never carries a value we don't read.
            return { key, sortField: key, absPath: n.path };
          });
      }
    } catch {
      localDirExists = false;
    }
    const localComposites = new Set(
      localFiles.map((f) => `${f.key}::${f.sortField}`),
    );

    for (const { key, sortField, absPath } of localFiles) {
      const logPath = isConversations
        ? `${col.name}/${key}/${sortField}.json`
        : `${col.name}/${key}.json`;
      const composite = `${key}::${sortField}`;

      let parsed: unknown;
      try {
        const raw = await fsRead(absPath);
        parsed = JSON.parse(raw);
      } catch (e) {
        onLine?.(`✗ datastore: ${logPath} — invalid JSON: ${String(e)}`);
        totalFailed += 1;
        continue;
      }

      const existing = remoteByComposite.get(composite);
      try {
        if (!existing) {
          const url = new URL("/memory/items", urls.skillsBaseUrl);
          url.searchParams.set("collectionId", col.id);
          const resp = await fetchFn(url.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, sortField, content: parsed }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          onLine?.(`  + ${logPath} (created)`);
          totalPushed += 1;
          if (!pushedKeysByCol.has(col.id)) pushedKeysByCol.set(col.id, new Set());
          pushedKeysByCol.get(col.id)!.add(composite);
        } else if (!jsonEqual(parsed, existing.content)) {
          const url = new URL(`/memory/items/${encodeURIComponent(existing.id)}`, urls.skillsBaseUrl);
          url.searchParams.set("collectionId", col.id);
          // Send sortField on PUT too: firebase-helpers owner.ts:158
          // overwrites the doc's sortField with whatever the body
          // carries, so omitting it would zero it out (the row would
          // fall back to whatever Firestore had — usually fine, but
          // this keeps the wire shape symmetric with POST).
          const resp = await fetchFn(url.toString(), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sortField, content: parsed }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          onLine?.(`  ✓ ${logPath} (updated)`);
          totalPushed += 1;
          if (!pushedKeysByCol.has(col.id)) pushedKeysByCol.set(col.id, new Set());
          pushedKeysByCol.get(col.id)!.add(composite);
        }
      } catch (e) {
        onLine?.(`✗ datastore: ${logPath} — ${String(e)}`);
        totalFailed += 1;
      }
    }

    // SAFETY: only run the deletion phase if the local collection dir
    // actually exists AND every per-ticket subfolder we listed succeeded.
    // Otherwise an empty `localComposites` would be interpreted as "user
    // deleted everything" and we'd nuke every remote row — which would
    // happen on the very first commit if the datastore pull hadn't
    // completed yet OR if a transient read error truncated the local
    // walk for the conversations collection.
    if (localDirExists && !innerWalkFailed) {
      for (const r of remote) {
        const k = (r.key ?? "").toString();
        const s = (r.sortField ?? "").toString();
        if (!k) continue;
        if (localComposites.has(`${k}::${s}`)) continue;
        try {
          const url = new URL(
            `/memory/items/id/${encodeURIComponent(r.id)}`,
            urls.skillsBaseUrl,
          );
          url.searchParams.set("collectionId", col.id);
          const resp = await fetchFn(url.toString(), { method: "DELETE" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          const logTail = isConversations ? `${k}/${s}.json` : `${k}.json`;
          onLine?.(`  − ${col.name}/${logTail} (deleted on remote)`);
          totalPushed += 1;
        } catch (e) {
          const logTail = isConversations ? `${k}/${s}` : k;
          onLine?.(`✗ datastore: delete ${col.name}/${logTail} — ${String(e)}`);
          totalFailed += 1;
        }
      }
    } else {
      const reason = !localDirExists
        ? "has no local dir yet"
        : "had a partial local walk";
      onLine?.(
        `▸ datastore: ${col.name} ${reason} — skipping deletion phase to avoid nuking remote rows`,
      );
    }
  }

  // Reconcile manifest after pushes — re-fetch each affected collection to
  // grab the post-push `updatedAt` for items we just touched. Paginate
  // because a collection > 1000 items might have the pushed row past the
  // first page; partial fetch would silently leave its manifest entry stale.
  //
  // The set tracks `${key}::${sortField}` composites so conversations rows
  // (where two folders can share a msgId) reconcile without aliasing.
  const RECONCILE_PAGE = 1000;
  const RECONCILE_MAX = 100_000;
  for (const [colId, composites] of pushedKeysByCol) {
    if (composites.size === 0) continue;
    const col = collections.find((c) => c.id === colId);
    if (!col) continue;
    const isConversations = col.name === CONVERSATIONS_COLLECTION_NAME;
    const remaining = new Set(composites);
    try {
      let offset = 0;
      let seen = 0;
      while (remaining.size > 0) {
        const resp: MemoryBqueryResponse = await fetchDatastoreItems(creds, colId, RECONCILE_PAGE, offset);
        for (const item of resp.items) {
          const k = (item.key ?? "").toString();
          const s = (item.sortField ?? "").toString();
          const composite = `${k}::${s}`;
          if (!remaining.has(composite)) continue;
          // Conversations manifest key includes the sortField leg so
          // two tickets sharing a msgId have distinct entries; flat
          // collections keep the legacy `<colName>/<key>` shape.
          const mKey = isConversations
            ? `${col.name}/${k}/${s}`
            : `${col.name}/${k}`;
          persisted.files[mKey] = {
            remote_version: item.updatedAt ?? "",
            pulled_at_mtime_ms: Date.now(),
          };
          remaining.delete(composite);
        }
        const hasMore = resp.pagination?.hasNextPage === true;
        if (!hasMore || resp.items.length === 0) break;
        offset += resp.items.length;
        seen += resp.items.length;
        if (seen >= RECONCILE_MAX) {
          console.warn(
            `[datastoreSync] post-push reconcile for ${col.name}: hit ${RECONCILE_MAX}-item safety cap; ${remaining.size} row(s) left unreconciled`,
          );
          break;
        }
      }
    } catch (e) {
      console.warn(`[datastoreSync] post-push reconcile for ${col.name} failed:`, e);
    }
  }
  await datastoreStateSave(repo, persisted);

  return { pushed: totalPushed, failed: totalFailed };
}

// ---------------------------------------------------------------------------
// Pull — engine-driven. The adapter handles per-collection pagination + the
// `<colName>/<key>` manifest-key mapping.
// ---------------------------------------------------------------------------

export type DatastoreConflict = {
  collectionName: string;
  key: string;
  reason: "local-and-remote-changed";
};

/// Manual pull. Returns `ok: false` on resolve / pull failure so the
/// pre-push guard in SourceControl can distinguish "no conflicts found"
/// from "we couldn't even check". The function still doesn't reject —
/// existing callers (Shell ↻ button, modal connect) keep working.
export async function pullDatastoresOnce(args: {
  creds: PinkfishCreds;
  repo: string;
}): Promise<{
  ok: boolean;
  error?: string;
  pulled: number;
  conflicts: DatastoreConflict[];
}> {
  const { creds, repo } = args;
  let collections: DataCollection[];
  try {
    collections = await resolveProjectDatastores(creds);
  } catch (e) {
    console.error("[datastoreSync] resolve failed:", e);
    return { ok: false, error: String(e), pulled: 0, conflicts: [] };
  }
  const adapter = datastoreAdapter({ creds, collections });
  let result;
  try {
    result = await pullEntity(adapter, repo);
  } catch (e) {
    console.error("[datastoreSync] pull failed:", e);
    return { ok: false, error: String(e), pulled: 0, conflicts: [] };
  }
  // Map engine's manifest-key conflicts back into the DatastoreConflict
  // shape (collectionName + key) so callers don't see the engine's
  // `<col>/<key>` joined form.
  const conflicts: DatastoreConflict[] = result.conflicts.map((c) => {
    const slash = c.manifestKey.indexOf("/");
    if (slash < 0) {
      return { collectionName: "", key: c.manifestKey, reason: c.reason };
    }
    return {
      collectionName: c.manifestKey.slice(0, slash),
      key: c.manifestKey.slice(slash + 1),
      reason: c.reason,
    };
  });
  return { ok: true, pulled: result.pulled, conflicts };
}

let stopPoll: (() => void) | null = null;

export async function startDatastoreSync(args: {
  creds: PinkfishCreds;
  repo: string;
  onLog?: (msg: string) => void;
}): Promise<void> {
  const { creds, repo, onLog } = args;
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }

  // Resolve-once-and-share strategy: the adapter is built lazily on the
  // first successful resolve and reused for every subsequent poll. This
  // gives both:
  //   (a) consistent snapshot — pull + poll see the same collection set
  //       (avoids the iter 2 drift), and
  //   (b) auto-recovery — if the initial resolve fails (transient
  //       network / auth blip), the poll keeps trying every 60s until
  //       resolve succeeds (avoids the iter 12 stuck state).
  let adapter: EntityAdapter | null = null;
  let firstAttempt = true;

  const tryResolveAndPull = async () => {
    // First-attempt failures re-throw so the modal's outer try/catch
    // + syncErrors flag trips. The modal's catch logs the error, so we
    // don't also onLog here (would duplicate lines, iter 2 finding).
    // Subsequent poll-tick failures just log to console — auto-recovery
    // takes care of itself.
    const isFirst = firstAttempt;
    firstAttempt = false;

    if (!adapter) {
      try {
        const collections = await resolveProjectDatastores(creds, onLog);
        adapter = datastoreAdapter({ creds, collections });
        try {
          const r = await writeDatastoreSchemas(repo, collections);
          if (isFirst) {
            onLog?.(
              `    ${collections.length} collection(s) — ${r.written} schema(s) written, ${r.unchanged} unchanged`,
            );
          }
        } catch (e) {
          console.warn("[datastoreSync] schema write failed:", e);
        }
      } catch (e) {
        console.error("[datastoreSync] resolve failed:", e);
        if (isFirst) throw e;
        return;
      }
    }
    try {
      await pullEntity(adapter, repo);
      // Stamp `cloud.json.lastSyncAt` on every successful pull (Phase 2
      // deferral; matches what filestore + kb do).
      projectUpdateLastSyncAt(repo).catch((err) =>
        console.warn("[datastoreSync] lastSyncAt update failed:", err),
      );
    } catch (e) {
      console.error("[datastoreSync] pull failed:", e);
      if (isFirst) throw e;
    }
  };

  // Install the poller BEFORE awaiting the first call. If the first
  // attempt throws (transient resolve/pull failure on connect), the
  // throw still reaches the caller — but the 60s timer is already
  // registered and will keep retrying, preserving the iter-12
  // auto-recovery guarantee.
  const timer = setInterval(tryResolveAndPull, DEFAULT_POLL_INTERVAL_MS);
  stopPoll = () => clearInterval(timer);
  await tryResolveAndPull();
}

export function stopDatastoreSync(): void {
  if (stopPoll) {
    stopPoll();
    stopPoll = null;
  }
  clearConflictsForPrefix("datastore");
}
