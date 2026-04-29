/**
 * Real-API test for the import-csv flow that's the only way to create
 * a structured datastore without triggering the cloud auto-template
 * (proven in datastore-create-no-template.test.ts).
 *
 * Validates:
 *   1. Build a CSV from our bundled seed people rows.
 *   2. Convert local schema (rich types) → cloud schema (f_N IDs,
 *      narrow types).
 *   3. POST /datacollection/import-csv → status URL.
 *   4. Poll until status === "completed". Assert all rows inserted.
 *   5. List items in the new collection. Assert correct row count.
 *   6. Cleanup.
 *
 * Skipped without test-config.json present.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./utils/config";
import { PinkfishClient } from "./utils/pinkfish-api";

const config = loadConfig();
const skip = !config;

let client: PinkfishClient | null = null;
const createdIds: string[] = [];

const PROJECT_ROOT = path.resolve(process.cwd());

function readJson<T = unknown>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf-8")) as T;
}

/// Convert a local _schema.json (rich types: string|text|number|
/// boolean|datetime|enum|string[]) into the cloud import-csv schema
/// shape (f_N IDs, types: string|number|boolean|date|select). Mirror
/// of the function we'll add to the production code.
function localSchemaToCloud(local: Record<string, unknown>): {
  cloud: { fields: Array<Record<string, unknown>>; nextFieldId: number };
  /// Mapping `localFieldId → cloudHeaderLabel`. Lets the CSV builder
  /// turn a row's `displayName` into the right column.
  idToLabel: Record<string, string>;
  /// Same mapping but localFieldId → cloud field type, used to coerce
  /// values into CSV-safe strings.
  idToType: Record<string, string>;
} {
  const localFields = (local.fields as Array<Record<string, unknown>>) ?? [];
  const cloudFields: Array<Record<string, unknown>> = [];
  const idToLabel: Record<string, string> = {};
  const idToType: Record<string, string> = {};
  let counter = 1;
  for (const f of localFields) {
    const t = String(f.type ?? "");
    if (t.endsWith("[]")) continue; // arrays not supported by the cloud schema
    const label = String(f.label ?? f.id);
    const fid = `f_${counter}`;
    counter += 1;
    const required = !!f.required;
    idToLabel[String(f.id)] = label;

    let cloudType: string;
    const extra: Record<string, unknown> = {};
    if (t === "string" || t === "text") {
      cloudType = "string";
    } else if (t === "number") {
      cloudType = "number";
    } else if (t === "boolean") {
      cloudType = "boolean";
    } else if (t === "datetime") {
      cloudType = "string"; // ISO-8601 round-trips as string; no MDY/DMY trap
    } else if (t === "enum") {
      cloudType = "select";
      extra.options = (f.values as unknown[]) ?? (f.options as unknown[]) ?? [];
    } else {
      cloudType = "string"; // unknown type — best effort
    }
    idToType[String(f.id)] = cloudType;
    cloudFields.push({
      id: fid,
      label,
      type: cloudType,
      required,
      ...extra,
    });
  }
  return {
    cloud: { fields: cloudFields, nextFieldId: counter },
    idToLabel,
    idToType,
  };
}

/// Build a CSV from row records. Rows are addressed by local field
/// `id` (e.g. `displayName`); we emit columns in the cloud schema
/// order using the cloudHeaderLabel. Values are coerced per cloudType.
function buildCsv(args: {
  rowFiles: string[];
  cloudFields: Array<Record<string, unknown>>;
  idToLabel: Record<string, string>;
  /// Reverse: cloudHeaderLabel → localFieldId, so we can look up the
  /// row's value when writing each column.
  labelToLocalId: Record<string, string>;
}): string {
  const headers = args.cloudFields.map((f) => String(f.label));
  const lines: string[] = [headers.map(csvQuote).join(",")];
  for (const filePath of args.rowFiles) {
    const row = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const cells = headers.map((h) => {
      const localId = args.labelToLocalId[h];
      const v = localId != null ? row[localId] : undefined;
      return csvQuote(serializeForCsv(v));
    });
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

function csvQuote(s: string): string {
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function serializeForCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.join("; "); // arrays flattened
  return JSON.stringify(v);
}

/// Wait for the import job to complete. Polls every 1s up to ~30s.
async function waitForImport(
  client: PinkfishClient,
  statusFileUrl: string,
): Promise<{ inserted: number; failed: number; total: number }> {
  for (let i = 0; i < 30; i++) {
    const s = await client.fetchImportStatus(statusFileUrl);
    if (s.status === "completed") {
      return {
        inserted: s.inserted ?? 0,
        failed: s.failed ?? 0,
        total: s.total ?? 0,
      };
    }
    if (s.status === "failed") {
      throw new Error(`import failed: ${JSON.stringify(s)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("import did not complete within 30s");
}

describe.skipIf(skip)("Datastore import-csv flow", () => {
  beforeAll(() => {
    if (!config) return;
    client = new PinkfishClient(config);
  });

  afterEach(async () => {
    if (!client) return;
    while (createdIds.length > 0) {
      const id = createdIds.pop()!;
      try {
        await client.deleteCollection(id);
        console.log(`[cleanup] deleted ${id}`);
      } catch {
        /* best effort */
      }
    }
  });

  it("creates openit-people via import-csv with our 5 seed rows + only those rows land", async () => {
    if (!client || !config) return;

    const localSchema = readJson<Record<string, unknown>>(
      "scripts/openit-plugin/schemas/people._schema.json",
    );
    const { cloud, idToLabel } = localSchemaToCloud(localSchema);
    const labelToLocalId: Record<string, string> = {};
    for (const [lid, lbl] of Object.entries(idToLabel)) labelToLocalId[lbl] = lid;

    const seedDir = path.join(
      PROJECT_ROOT,
      "scripts/openit-plugin/seed/people",
    );
    const rowFiles = fs
      .readdirSync(seedDir)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => path.join(seedDir, n));
    expect(rowFiles.length).toBe(5);

    const csv = buildCsv({
      rowFiles,
      cloudFields: cloud.fields,
      idToLabel,
      labelToLocalId,
    });
    console.log("\n--- Generated CSV ---\n" + csv + "\n");
    console.log("--- Cloud schema ---\n" + JSON.stringify(cloud, null, 2));

    const name = `openit-people-itest-csv-${Date.now()}`;
    const res = await client.importCsv({
      name,
      csv,
      schema: cloud,
      createdByName: "OpenIT integration test",
    });
    createdIds.push(res.collectionId);

    const result = await waitForImport(client, res.statusFileUrl);
    console.log(`  import: inserted=${result.inserted}, failed=${result.failed}, total=${result.total}`);
    expect(result.failed).toBe(0);
    expect(result.inserted).toBe(5);

    const { items } = await client.listDatastoreItems(res.collectionId);
    console.log(`  collection has ${items.length} rows after import`);
    expect(items.length).toBe(5);
  });

  it("creates openit-tickets via import-csv with our 5 seed rows + only those rows land", async () => {
    if (!client || !config) return;

    const localSchema = readJson<Record<string, unknown>>(
      "scripts/openit-plugin/schemas/tickets._schema.json",
    );
    const { cloud, idToLabel } = localSchemaToCloud(localSchema);
    const labelToLocalId: Record<string, string> = {};
    for (const [lid, lbl] of Object.entries(idToLabel)) labelToLocalId[lbl] = lid;

    const seedDir = path.join(
      PROJECT_ROOT,
      "scripts/openit-plugin/seed/tickets",
    );
    const rowFiles = fs
      .readdirSync(seedDir)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => path.join(seedDir, n));
    expect(rowFiles.length).toBe(5);

    const csv = buildCsv({
      rowFiles,
      cloudFields: cloud.fields,
      idToLabel,
      labelToLocalId,
    });

    const name = `openit-tickets-itest-csv-${Date.now()}`;
    const res = await client.importCsv({
      name,
      csv,
      schema: cloud,
      createdByName: "OpenIT integration test",
    });
    createdIds.push(res.collectionId);

    const result = await waitForImport(client, res.statusFileUrl);
    console.log(`  import: inserted=${result.inserted}, failed=${result.failed}`);
    expect(result.failed).toBe(0);
    expect(result.inserted).toBe(5);

    const { items } = await client.listDatastoreItems(res.collectionId);
    console.log(`  collection has ${items.length} rows after import`);
    expect(items.length).toBe(5);
  });
});
