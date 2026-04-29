/**
 * Real-API test: when our app POSTs `/datacollection/` with the same
 * body shape it actually sends (no `templateId`, isStructured: true,
 * with our bundled schema), does the cloud auto-populate rows?
 *
 * Background: the user reported that connecting against a fresh org
 * produced 10 empty rows in `openit-people` immediately after create —
 * suggesting the Pinkfish backend matches collection name and applies
 * a template even when no `templateId` is requested. This test
 * reproduces the exact create body and asserts post-create row count.
 *
 * Skipped without test-config.json present.
 *
 * Cleanup: each test deletes the collection it created. Failure paths
 * also delete in `afterEach` so accumulated test debris stays bounded.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, deriveSkillsBaseUrl } from "./utils/config";
import { type DataCollection, PinkfishClient } from "./utils/pinkfish-api";
import * as fs from "fs";
import * as path from "path";

const config = loadConfig();
const skip = !config;

let client: PinkfishClient | null = null;
const createdIds: string[] = [];

function loadBundledSchema(name: "tickets" | "people"): Record<string, unknown> {
  const p = path.resolve(
    process.cwd(),
    "scripts/openit-plugin/schemas",
    `${name}._schema.json`,
  );
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

/// Build the same POST body the app sends in `buildCreateBody` for a
/// datastore default. Kept in sync with `src/lib/datastoreSync.ts`.
function buildAppCreateBody(args: {
  name: string;
  description: string;
  orgId: string;
  schema: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: args.name,
    type: "datastore",
    description: args.description,
    createdBy: args.orgId,
    createdByName: "OpenIT",
    triggerUrls: [],
    isStructured: true,
    schema: args.schema,
  };
}

describe.skipIf(skip)("Datastore create — auto-template detection", () => {
  beforeAll(() => {
    if (!config) return;
    client = new PinkfishClient(config);
    console.log("\n" + "=".repeat(60));
    console.log("DATASTORE CREATE NO-TEMPLATE TEST");
    console.log("=".repeat(60));
    console.log("Repo:        ", config.repo);
    console.log("Org:         ", config.orgId);
    console.log("Skills URL:  ", deriveSkillsBaseUrl(config.credentials.tokenUrl));
    console.log("=".repeat(60) + "\n");
  });

  afterEach(async () => {
    if (!client) return;
    while (createdIds.length > 0) {
      const id = createdIds.pop()!;
      try {
        await client.deleteCollection(id);
        console.log(`[cleanup] deleted ${id}`);
      } catch (err) {
        console.warn(`[cleanup] delete ${id} failed:`, err);
      }
    }
  });

  it("openit-people-itest-<ts>: create body without templateId yields 0 rows", async () => {
    if (!client || !config) return;
    const ts = Date.now();
    const name = `openit-people-itest-${ts}`;
    const body = buildAppCreateBody({
      name,
      description: "Integration test — should not auto-seed",
      orgId: config.orgId,
      schema: loadBundledSchema("people"),
    });

    console.log(`POST /datacollection/ name=${name} (no templateId)`);
    const created = await client.createCollection(body);
    expect(created.id).toBeTruthy();
    createdIds.push(created.id);

    const { items, total } = await client.listDatastoreItems(created.id);
    console.log(`  → ${items.length} items reported (total=${total})`);
    if (items.length > 0) {
      console.log("  first row keys:", Object.keys(items[0] ?? {}).slice(0, 6));
      console.log("  first row sample:", JSON.stringify(items[0]).slice(0, 200));
    }
    expect(items.length).toBe(0);
  });

  it("openit-tickets-itest-<ts>: create body without templateId yields 0 rows", async () => {
    if (!client || !config) return;
    const ts = Date.now();
    const name = `openit-tickets-itest-${ts}`;
    const body = buildAppCreateBody({
      name,
      description: "Integration test — should not auto-seed",
      orgId: config.orgId,
      schema: loadBundledSchema("tickets"),
    });

    console.log(`POST /datacollection/ name=${name} (no templateId)`);
    const created = await client.createCollection(body);
    expect(created.id).toBeTruthy();
    createdIds.push(created.id);

    const { items, total } = await client.listDatastoreItems(created.id);
    console.log(`  → ${items.length} items reported (total=${total})`);
    if (items.length > 0) {
      console.log("  first row keys:", Object.keys(items[0] ?? {}).slice(0, 6));
      console.log("  first row sample:", JSON.stringify(items[0]).slice(0, 200));
    }
    expect(items.length).toBe(0);
  });

  // ----- variations to find the right "no template please" signal -----

  it("VAR: templateId: null (explicit no-template)", async () => {
    if (!client || !config) return;
    const name = `openit-people-itest-tn-${Date.now()}`;
    const body = {
      ...buildAppCreateBody({
        name,
        description: "Var: templateId null",
        orgId: config.orgId,
        schema: loadBundledSchema("people"),
      }),
      templateId: null,
    };
    const created = await client.createCollection(body);
    createdIds.push(created.id);
    const { items } = await client.listDatastoreItems(created.id);
    console.log(`  templateId:null → ${items.length} rows`);
    expect(items.length).toBe(0);
  });

  it("VAR: templateId: '' (explicit empty)", async () => {
    if (!client || !config) return;
    const name = `openit-people-itest-te-${Date.now()}`;
    const body = {
      ...buildAppCreateBody({
        name,
        description: "Var: templateId empty",
        orgId: config.orgId,
        schema: loadBundledSchema("people"),
      }),
      templateId: "",
    };
    const created = await client.createCollection(body);
    createdIds.push(created.id);
    const { items } = await client.listDatastoreItems(created.id);
    console.log(`  templateId:'' → ${items.length} rows`);
    expect(items.length).toBe(0);
  });

  it("VAR: templateId: 'blank'", async () => {
    if (!client || !config) return;
    const name = `openit-people-itest-tb-${Date.now()}`;
    const body = {
      ...buildAppCreateBody({
        name,
        description: "Var: templateId blank",
        orgId: config.orgId,
        schema: loadBundledSchema("people"),
      }),
      templateId: "blank",
    };
    const created = await client.createCollection(body);
    createdIds.push(created.id);
    const { items } = await client.listDatastoreItems(created.id);
    console.log(`  templateId:'blank' → ${items.length} rows`);
    expect(items.length).toBe(0);
  });

  it("VAR: no isStructured, no schema (minimal create)", async () => {
    if (!client || !config) return;
    const name = `openit-people-itest-min-${Date.now()}`;
    const body = {
      name,
      type: "datastore",
      description: "Var: minimal create",
      createdBy: config.orgId,
      createdByName: "OpenIT",
      triggerUrls: [],
    };
    const created = await client.createCollection(body);
    createdIds.push(created.id);
    const { items } = await client.listDatastoreItems(created.id);
    console.log(`  minimal → ${items.length} rows`);
    expect(items.length).toBe(0);
  });

  it("VAR: isStructured: false (unstructured)", async () => {
    if (!client || !config) return;
    const name = `openit-people-itest-uns-${Date.now()}`;
    const body = {
      name,
      type: "datastore",
      description: "Var: unstructured",
      createdBy: config.orgId,
      createdByName: "OpenIT",
      triggerUrls: [],
      isStructured: false,
    };
    const created = await client.createCollection(body);
    createdIds.push(created.id);
    const { items } = await client.listDatastoreItems(created.id);
    console.log(`  unstructured → ${items.length} rows`);
    expect(items.length).toBe(0);
  });

  it("VAR: structured + schema, no templateId, name without 'people'", async () => {
    if (!client || !config) return;
    const name = `openit-itest-noname-${Date.now()}`;
    const body = buildAppCreateBody({
      name,
      description: "Var: name doesn't match a template",
      orgId: config.orgId,
      schema: loadBundledSchema("people"),
    });
    const created = await client.createCollection(body);
    createdIds.push(created.id);
    const { items } = await client.listDatastoreItems(created.id);
    console.log(`  generic-name+schema → ${items.length} rows`);
    expect(items.length).toBe(0);
  });

  /// Strip field types the PUT-schema endpoint rejects (`string[]`,
   /// nested arrays, etc.). The POST endpoint accepts them but applies
   /// a template anyway, so we have to PUT — which means the schema
   /// must use only the types the PUT validator accepts. Drop the
   /// offending fields entirely; users can add them back via the cloud
   /// admin if needed.
  /// PUT-schema endpoint accepts a narrower type list than the POST
   /// body: rejects `string[]` ("Invalid field type: string[]") and
   /// `text` ("Invalid field type: text"). Drop arrays entirely; remap
   /// `text` → `string` so longform fields still round-trip as strings
   /// on cloud. Whitelist the rest.
  function sanitizeSchemaForPut(schema: Record<string, unknown>): Record<string, unknown> {
    const ALLOWED = new Set(["string", "number", "boolean", "select"]);
    const fields = (schema.fields as Array<Record<string, unknown>> | undefined) ?? [];
    const safeFields: Array<Record<string, unknown>> = [];
    for (const f of fields) {
      const t = String(f.type ?? "");
      if (t.endsWith("[]")) continue;
      if (t === "text") {
        safeFields.push({ ...f, type: "string" });
        continue;
      }
      if (t === "datetime") {
        // PUT rejects "datetime"; coerce to "string" so the field still
        // round-trips (rows store ISO-8601 strings anyway).
        safeFields.push({ ...f, type: "string" });
        continue;
      }
      if (t === "enum") {
        // PUT rejects "enum"; remap to "select" (Pinkfish's term).
        // Pass the values list through under the same key.
        safeFields.push({ ...f, type: "select", options: f.values ?? f.options });
        continue;
      }
      if (ALLOWED.has(t)) safeFields.push(f);
    }
    return { ...schema, fields: safeFields };
  }

  it("WORKAROUND: minimal create, then PUT sanitized schema → 0 rows", async () => {
    if (!client || !config) return;
    const name = `openit-people-itest-2step-${Date.now()}`;

    // Step 1 — minimal create. No isStructured, no schema. Confirmed
    // above this avoids the cloud-side auto-template.
    const created = await client.createCollection({
      name,
      type: "datastore",
      description: "Workaround: minimal create then PUT schema",
      createdBy: config.orgId,
      createdByName: "OpenIT",
      triggerUrls: [],
    });
    createdIds.push(created.id);

    // Step 2 — PUT schema (sanitized: PUT rejects "string[]"). This
    // marks the collection structured server-side without auto-seeding.
    const schema = sanitizeSchemaForPut(loadBundledSchema("people"));
    await client.putCollectionSchema(created.id, schema);

    const { items, total } = await client.listDatastoreItems(created.id);
    console.log(`  2-step (create + PUT schema) → ${items.length} rows (total=${total})`);
    expect(items.length).toBe(0);
  });

  it("WORKAROUND: same for openit-tickets shape", async () => {
    if (!client || !config) return;
    const name = `openit-tickets-itest-2step-${Date.now()}`;
    const created = await client.createCollection({
      name,
      type: "datastore",
      description: "Workaround: tickets minimal create then PUT schema",
      createdBy: config.orgId,
      createdByName: "OpenIT",
      triggerUrls: [],
    });
    createdIds.push(created.id);
    const schema = sanitizeSchemaForPut(loadBundledSchema("tickets"));
    await client.putCollectionSchema(created.id, schema);
    const { items } = await client.listDatastoreItems(created.id);
    console.log(`  tickets 2-step → ${items.length} rows`);
    expect(items.length).toBe(0);
  });

  it("DIAGNOSTIC: exact name 'openit-people' (matches what user's app uses)", async () => {
    if (!client || !config) return;
    // First make sure the production-named collection isn't already there;
    // if it is, skip — we don't want to clobber the user's real data.
    const existing = await client.findCollectionByName("datastore", "openit-people");
    if (existing) {
      console.log(`SKIPPED — openit-people already exists on cloud (id=${existing.id})`);
      const { items } = await client.listDatastoreItems(existing.id);
      console.log(`  existing has ${items.length} rows`);
      return;
    }
    const body = buildAppCreateBody({
      name: "openit-people",
      description: "Diagnostic — production-named, body identical to user's connect",
      orgId: config.orgId,
      schema: loadBundledSchema("people"),
    });
    console.log("POST /datacollection/ name=openit-people (production name)");
    let created: DataCollection;
    try {
      created = await client.createCollection(body);
    } catch (err) {
      console.warn("create failed:", err);
      throw err;
    }
    createdIds.push(created.id);

    const { items, total } = await client.listDatastoreItems(created.id);
    console.log(`  → ${items.length} items reported (total=${total})`);
    if (items.length > 0) {
      console.log(
        `  ⚠ AUTO-TEMPLATE DETECTED: cloud created openit-people with ${items.length} pre-existing rows`,
      );
      console.log("  first row:", JSON.stringify(items[0]).slice(0, 300));
    } else {
      console.log("  ✓ no auto-template — clean create");
    }
  });
});
