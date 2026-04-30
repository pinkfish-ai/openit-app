// Form-based edit for a single datastore row. One input per schema
// field, typed appropriately (string → text, text → textarea, enum
// → select, datetime → datetime-local, boolean → checkbox, number →
// number, string[] → comma-separated text). Falls back to a generic
// text input for any unrecognized type so unknown shapes still
// surface and can be saved.
//
// The draft state lives in the parent (Viewer) so the cancel/save
// flow can reset it on source change without the form having to
// remember anything itself. This component only renders inputs and
// emits onChange — it doesn't talk to the filesystem.
//
// Out of scope (V1): array-of-objects, nested objects, validation
// on required fields, type-specific format checks (e.g. valid ISO
// timestamp). Saving an invalid value writes it as-is; the agent
// and downstream consumers already tolerate sparse rows.

import type { DataCollection } from "../lib/skillsApi";
import { Button } from "../ui";

type SchemaFieldShape = {
  id: string;
  label?: string;
  type?: string;
  values?: string[];
  required?: boolean;
  nullable?: boolean;
  comment?: string;
};

export function RowEditForm({
  collection,
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  error,
}: {
  collection: DataCollection;
  draft: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  // The schema as loaded from disk has a richer type vocabulary than
  // the (older) SchemaField TS model — string/text/enum/datetime/
  // string[]/boolean/number/etc. Treat fields as the disk shape.
  const fields = (collection.schema?.fields ?? []) as unknown as SchemaFieldShape[];

  const setField = (id: string, value: unknown) => {
    onChange({ ...draft, [id]: value });
  };

  const renderInput = (field: SchemaFieldShape) => {
    const id = field.id;
    const value = draft[id];
    const required = !!field.required;
    const placeholder = field.comment ?? "";

    switch (field.type) {
      case "text":
        return (
          <textarea
            className="row-edit-textarea"
            value={typeof value === "string" ? value : value == null ? "" : String(value)}
            onChange={(e) => setField(id, e.target.value)}
            placeholder={placeholder}
            required={required}
            rows={4}
          />
        );
      case "enum": {
        const opts = field.values ?? [];
        const stringValue = typeof value === "string" ? value : "";
        return (
          <select
            className="row-edit-input"
            value={stringValue}
            onChange={(e) => setField(id, e.target.value || null)}
          >
            {/* Allow blank for nullable enums; required ones still
                accept blank here but a future validation pass would
                catch it. */}
            <option value="">{field.nullable ? "(unset)" : "—"}</option>
            {opts.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        );
      }
      case "datetime":
        // Native datetime-local takes `YYYY-MM-DDTHH:mm` (no seconds,
        // no Z). Round-trip ISO-8601 UTC by trimming/restoring the
        // suffix. Fall back to plain text if the input doesn't
        // round-trip cleanly so the user isn't blocked.
        return (
          <input
            type="text"
            className="row-edit-input"
            value={typeof value === "string" ? value : value == null ? "" : String(value)}
            onChange={(e) => setField(id, e.target.value)}
            placeholder="2026-04-27T09:14:02Z"
          />
        );
      case "boolean":
        return (
          <input
            type="checkbox"
            className="row-edit-checkbox"
            checked={!!value}
            onChange={(e) => setField(id, e.target.checked)}
          />
        );
      case "number":
        return (
          <input
            type="number"
            className="row-edit-input"
            value={typeof value === "number" ? value : typeof value === "string" ? value : ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") setField(id, null);
              else {
                const n = Number(v);
                setField(id, Number.isFinite(n) ? n : v);
              }
            }}
          />
        );
      case "string[]": {
        // Render as a comma-separated text input. Saved back as an
        // array of trimmed non-empty strings so a stray trailing
        // comma doesn't introduce empty elements.
        const stringValue = Array.isArray(value)
          ? (value as unknown[])
              .map((v) => (typeof v === "string" ? v : String(v ?? "")))
              .join(", ")
          : typeof value === "string"
            ? value
            : "";
        return (
          <input
            type="text"
            className="row-edit-input"
            value={stringValue}
            onChange={(e) => {
              const parts = e.target.value
                .split(",")
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
              setField(id, parts);
            }}
            placeholder="comma, separated, values"
          />
        );
      }
      case "string":
      default:
        return (
          <input
            type="text"
            className="row-edit-input"
            value={typeof value === "string" ? value : value == null ? "" : String(value)}
            onChange={(e) => setField(id, e.target.value)}
            placeholder={placeholder}
            required={required}
          />
        );
    }
  };

  return (
    <div className="row-edit">
      <div className="row-edit-form">
        {fields.length === 0 && (
          <p className="summary-desc">
            No schema for this collection — switch to Raw to edit the JSON directly.
          </p>
        )}
        {fields.map((field) => (
          <label key={field.id} className="row-edit-field">
            <span className="row-edit-label">
              {field.label ?? field.id}
              {field.required && <span className="row-edit-required" aria-hidden> *</span>}
            </span>
            {renderInput(field)}
            {field.comment && <span className="row-edit-hint">{field.comment}</span>}
          </label>
        ))}
      </div>
      <div className="row-edit-footer">
        {error && <span className="row-edit-error">{error}</span>}
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          disabled={saving}
          loading={saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
