// Datastore schema validation for structured collections. Used at push
// time (before POST/PUT to /memory/items) to catch row-shape errors
// locally with a clear message — the server would reject anyway, but
// surfacing the failure here is faster + cleaner.
//
// Validation rules:
//   - Required-field check: every field with `required: true` must be
//     present in the row.
//   - Type-match check: each present field's value matches the
//     declared `type` (string / number / boolean / date / select).
//   - Select-options check: when `type === "select"`, the value must
//     be one of the field's `options[]`.
//   - Extra fields not in the schema are tolerated (warn-log but
//     don't block — server accepts in some cases).
//
// Schema is the existing `CollectionSchema` shape from `skillsApi.ts`,
// matching what `_schema.json` contains on disk.

import type { CollectionSchema, SchemaField } from "./skillsApi";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/// Validate a row's content against a structured datastore's schema.
/// `row` is the parsed JSON object from `<key>.json`.
export function validateRow(
  row: unknown,
  schema: CollectionSchema | null | undefined,
): ValidationResult {
  if (!schema) return { ok: true }; // unstructured — nothing to validate
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { ok: false, errors: ["row content is not a JSON object"] };
  }
  const obj = row as Record<string, unknown>;
  const errors: string[] = [];

  // Schema fields can be addressed by either `id` (e.g. "f_3") or
  // `label` (e.g. "Email") — Pinkfish supports both. Look up by either.
  const fieldByKey = new Map<string, SchemaField>();
  for (const f of schema.fields ?? []) {
    fieldByKey.set(f.id, f);
    if (f.label) fieldByKey.set(f.label, f);
  }

  // Required-field check.
  for (const f of schema.fields ?? []) {
    if (!f.required) continue;
    const v = obj[f.id] ?? obj[f.label];
    if (v === undefined || v === null || v === "") {
      errors.push(`required field "${f.label || f.id}" missing`);
    }
  }

  // Type-match check on every present field that's in the schema.
  for (const [key, value] of Object.entries(obj)) {
    const field = fieldByKey.get(key);
    if (!field) continue; // extra field — tolerated, server decides
    if (value === undefined || value === null || value === "") continue; // empty handled in required check above
    const typeError = checkType(field, value);
    if (typeError) errors.push(typeError);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function checkType(field: SchemaField, value: unknown): string | null {
  switch (field.type) {
    case "string":
      if (typeof value !== "string") {
        return `field "${field.label || field.id}" must be a string (got ${typeof value})`;
      }
      return null;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `field "${field.label || field.id}" must be a number (got ${typeof value})`;
      }
      return null;
    case "boolean":
      if (typeof value !== "boolean") {
        return `field "${field.label || field.id}" must be a boolean (got ${typeof value})`;
      }
      return null;
    case "date":
      // Accept ISO-8601 strings or numeric ms-since-epoch.
      if (typeof value === "string") {
        const ts = Date.parse(value);
        if (Number.isNaN(ts)) {
          return `field "${field.label || field.id}" must be a parseable date (got "${value}")`;
        }
        return null;
      }
      if (typeof value === "number") return null;
      return `field "${field.label || field.id}" must be a date string or epoch number`;
    case "select":
      if (typeof value !== "string") {
        return `field "${field.label || field.id}" must be a string (select value)`;
      }
      if (field.options && field.options.length > 0 && !field.options.includes(value)) {
        return `field "${field.label || field.id}" value "${value}" not in options (${field.options.join(", ")})`;
      }
      return null;
    default:
      // Unknown type — don't block, server decides.
      return null;
  }
}
