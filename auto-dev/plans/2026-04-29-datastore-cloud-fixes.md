# Datastore cloud-side fixes for Pinkfish

Issues found while integrating OpenIT's local-first datastore sync (Phase 3, PIN-5779). Each one has a confirmed reproduction in `integration_tests/datastore-{create-no-template,import-csv}.test.ts` against `https://app-api.dev20.pinkfish.dev`. We're working around each one on the client today; the workarounds add complexity and lose fidelity. Fixing on the backend would let OpenIT use the natural API.

Ranked by impact on OpenIT.

---

## 1. POST `/datacollection/` auto-applies a template when given `isStructured + schema` ⚠️ HIGH

### Symptom

Sending a complete create body with our schema produces a collection that:
- Has **10 phantom rows** in it immediately, with `f_1`/`f_2`/… field IDs that don't match the schema we sent.
- Ignores the schema we provided — the resulting collection's field IDs are the cloud-template's, not ours.

### Repro

```bash
curl -X POST 'https://app-api.dev20.pinkfish.dev/datacollection/' \
  -H 'Auth-Token: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{
    "name": "openit-people-test-1",
    "type": "datastore",
    "isStructured": true,
    "schema": { "fields": [{"id":"firstName","label":"First name","type":"string","required":true}] },
    "createdBy": "<orgId>",
    "createdByName": "OpenIT"
  }'

# Then: GET /memory/bquery?collectionId=<returned-id>&limit=100
# → 10 rows with content like { f_1: "Henry Wilson", f_2: "henry@…", … }
```

Tested with: name variations (`openit-people-itest-noname-…`, generic names without "people"), `templateId: null`, `templateId: ""`, `templateId: "blank"`. **All produce the auto-template.** Only `isStructured + schema` together triggers it.

### Why it matters

Forces every structured-create caller to:
1. POST minimal first (no `isStructured`, no schema).
2. PUT schema in a separate call.

Doubles the round-trips and exposes a window where the collection exists unstructured.

### Proposed fix

When `templateId` is **absent** (or explicitly `null`) AND `schema` is provided, **honor the provided schema** and do not auto-seed rows. Only apply the matching template when `templateId` is set.

Optional opt-out flag if backwards-compat with existing template-on-create callers matters: `applyTemplate: false`.

---

## 2. PUT `/datacollection/{id}/schema` rejects common field types ⚠️ HIGH

### Symptom

The PUT-schema endpoint accepts a narrower type vocabulary than the POST-create body (which advertises but ignores them, see #1).

```
HTTP 400 INVALID_PARAMETERS — Invalid field type: text
HTTP 400 INVALID_PARAMETERS — Invalid field type: datetime
HTTP 400 INVALID_PARAMETERS — Invalid field type: enum
HTTP 400 INVALID_PARAMETERS — Invalid field type: string[]
HTTP 400 INVALID_PARAMETERS — Schema must include nextFieldId counter
```

Confirmed accepted: `string`, `number`, `boolean`, `select`, `date`. (Treated as authoritative; we can extend the test if needed.)

### Repro

```bash
curl -X PUT 'https://app-api.dev20.pinkfish.dev/datacollection/<id>/schema' \
  -H 'Auth-Token: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{ "schema": { "fields": [{"id":"f_1","label":"Notes","type":"text"}], "nextFieldId": 2 } }'

# → HTTP 400: "Invalid field type: text"
```

### Why it matters

Our shipped schemas (`tickets._schema.json`, `people._schema.json`) use `text` (long-form notes), `datetime` (ISO-8601 timestamps), `enum` (status/priority/channel), and `string[]` (tags/channels/kbArticleRefs). Today we sanitize the schema before the PUT:

| Local type | Cloud type sent |
|---|---|
| `string` | `string` |
| `text` | `string` (lossy: lose long-form hint) |
| `number` | `number` |
| `boolean` | `boolean` |
| `datetime` | `string` (lossy: lose date-rendering hint) |
| `enum` | `select` (with `options` from `values`) |
| `string[]` | dropped entirely |

Result: the cloud admin UI's structured rendering loses fidelity — long-form text fields render as one-line strings, dates as raw strings, multi-value tags can't be edited at all.

### Proposed fix

Either:
- **Accept the same vocabulary POST-create accepts** (the natural symmetry); cloud admin UI gains `text`/`datetime`/`enum`/`string[]` rendering hints. OR
- **Document the canonical type list** clearly and let clients normalize. We'll happily normalize if the spec is published; today we're guessing from 400 messages.

`nextFieldId` is also a surprise — POST didn't require it. Either accept the schema without it (compute server-side) or document the requirement.

---

## 3. POST `/datacollection/` is not atomic on name uniqueness ⚠️ MEDIUM

### Symptom

Two concurrent POSTs with the same `name` both succeed and produce two distinct collections with the same name. Pre-list-then-POST doesn't help: the gap between LIST and POST is enough for the race.

### Repro

```js
// Both racers see the empty list, both POST, both succeed:
await Promise.allSettled([
  fetch('POST /datacollection/', { body: { name: "openit-people-conc-1" } }),
  fetch('POST /datacollection/', { body: { name: "openit-people-conc-1" } }),
]);
// → cloud has 2 collections named "openit-people-conc-1"
```

Test in `integration_tests/datastore-import-csv.test.ts` ("CONCURRENT CREATE: two parallel customCreate-style calls for the same name → only one collection") confirms this.

### Why it matters

React StrictMode (and any other concurrent re-entry — HMR reload, double-click on Connect) trips this. The user has had **3 `openit-tickets`** and **2 `openit-people`** appear on a single org from one accidental double-call.

We've worked around it client-side with `useOnceEffect` to prevent parallel customCreate. But anyone integrating with the API has the same problem.

### Proposed fix

Either:
- POST `/datacollection/` should **uniqueness-check by `name` server-side** within the org, returning 409 (or returning the existing collection's id, like an upsert) on duplicate. OR
- A separate atomic verb: `POST /datacollection/?ifMissing=true` that returns the existing collection if one with that name exists.

The 409-on-duplicate semantics is what we expected; today's behavior surprises every multi-instance/concurrent caller.

---

## 4. `import-csv` overrides caller-supplied row keys ⚠️ LOW

### Symptom

POST `/datacollection/import-csv` creates rows with auto-assigned keys like `csv-import-<ts>-<rand>-<idx>` regardless of any "key" hint in the CSV. There's no documented way to specify per-row keys.

### Why it matters

Our local layout uses filename as row key (e.g. `databases/tickets/sample-ticket-1.json`). When `import-csv` returns cloud-assigned keys, our local files no longer match — the next pull writes new files under cloud keys, leaving duplicate locals + breaking the `ticketId == filename == conversation-folder-name` linkage.

This is why we abandoned `import-csv` entirely and went to minimal POST + per-row `/memory/items` POST (which DOES honor caller keys).

### Proposed fix

Optional. We're not blocked — `/memory/items` does what we need. But if `import-csv` accepted a `keyColumn` (e.g. `?keyColumn=Subject` to use the Subject column as the row key) it would be the natural one-shot create-and-populate verb again.

---

## 5. Server-side temp-file race in `import-csv` ⚠️ LOW

### Symptom

When two concurrent calls hit `/datacollection/import-csv` with names that collide on a temp filename, the second one returns:

```
HTTP 500 INTERNAL_SERVER_ERROR — ENOENT: no such file or directory, unlink '/tmp/openit-people.csv'
```

Or an `ENOENT … open '/tmp/openit-people.csv'` variant.

### Why it matters

Same StrictMode/concurrent scenario as #3. We've moved off this endpoint, so it's no longer a daily problem for OpenIT — but flagging it because it's the kind of crash that catches anyone doing concurrent imports.

### Proposed fix

Use a per-request UUID in the temp filename, or a per-call temp dir. Standard pattern.

---

## Summary table

| # | Issue | Severity | Our workaround | Cloud fix |
|---|---|---|---|---|
| 1 | POST auto-templates with `isStructured + schema` | HIGH | minimal POST + PUT schema (2 calls) | honor `schema` when no `templateId` |
| 2 | PUT schema type vocabulary | HIGH | sanitize: drop arrays, remap `text/datetime/enum` | accept same types as POST + document |
| 3 | Concurrent POST creates duplicates | MED | client-side `useOnceEffect` | server-side uniqueness or 409 |
| 4 | `import-csv` ignores caller keys | LOW | use `/memory/items` instead | optional `keyColumn` param |
| 5 | `import-csv` `/tmp/<name>.csv` race | LOW | avoid concurrent calls | per-UUID temp filename |

Fixing #1 + #2 alone unlocks: a single-call structured create, no schema-translation layer in clients, full type fidelity in the cloud admin UI. Those are the big wins.

Repro tests live in `integration_tests/datastore-{create-no-template,import-csv}.test.ts` — all run against `dev20.pinkfish.dev` with the existing `test-config.json` creds.
