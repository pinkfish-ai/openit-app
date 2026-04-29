---
name: databases
description: How to read, write, and search OpenIT datastores — both structured (with a `_schema.json`) and unstructured (freeform JSON rows). File ops first; reach for the gateway only when semantic search or natural-language queries would beat reading files directly.
---

## When to use

Invoked when the admin asks anything that involves OpenIT datastore content: tickets, people, custom datastores they've created, or anything else under `databases/`. Also auto-loaded contextually when you're about to read or write JSON rows under `databases/<colName>/<key>.json`.

If the admin asks something that targets a third-party system (Slack, Okta, GitHub, etc.), this skill doesn't apply — that's gateway/connector territory.

## Where datastores live on disk

```
databases/
├── tickets/                  ← default, structured (case-management schema)
│   ├── _schema.json          ← field definitions
│   └── <ticketId>.json       ← one file per row
├── people/                   ← default, structured (contacts schema)
│   ├── _schema.json
│   └── <emailSlug>.json
├── conversations/            ← LOCAL-ONLY, unstructured. Not synced to cloud.
│   └── <ticketId>/msg-*.json
└── <custom-name>/            ← any other folder = a custom datastore
    ├── _schema.json          ← optional. Present → structured. Absent → unstructured.
    └── *.json
```

The folder name is the unprefixed display name. The cloud collection name is `openit-<folder-name>` (e.g. `databases/tickets/` ↔ `openit-tickets` on Pinkfish). The sync engine handles the prefix mapping automatically; you just see the unprefixed names on disk.

## Two flavors

**Structured datastore** — has a `_schema.json` next to its row files. The schema defines fields with types (`string`, `number`, `boolean`, `date`, `select`) and `required` flags. Row content must match the schema; the sync engine validates locally before pushing to Pinkfish, and the server validates again. If you write a row that doesn't match (missing a required field, wrong type, value outside a `select`'s options), the local push will fail with a clear error message — the row stays uncommitted.

**Unstructured datastore** — no `_schema.json`. Rows are freeform JSON. The sync engine doesn't validate; you can write whatever shape you want.

How to tell which flavor a datastore is: check whether `_schema.json` exists. `Read databases/<colName>/_schema.json` — if it parses, structured; if Read errors out, unstructured.

## Reading datastores

**Default to file ops.** Datastore content is on disk as plain JSON files. Use `Read`, `Glob`, `Grep`, and `Bash` (for `ls`, `wc -l`, `jq`, etc.) instead of network calls.

Common patterns:

```
# All tickets
Glob "databases/tickets/*.json"

# Open tickets (need to filter on content)
Glob "databases/tickets/*.json" then Read each and check status field

# Find tickets mentioning "VPN" — small set
Grep "VPN" databases/tickets/

# All datastores in this project
ls databases/

# Schema for a structured datastore
Read databases/tickets/_schema.json
```

For tickets specifically, the field IDs are listed in `databases/tickets/_schema.json`. The schema gives you the human label for each field id (`f_1` → "Subject", etc.). Use the labels in the human-facing summary.

## Writing datastore rows

**Structured datastore — read the schema first.** Before writing a new row to a structured datastore, `Read databases/<colName>/_schema.json` to know what fields exist and which are required. Build the row with all required fields populated and types matching. Skip the schema read only if you've already read it earlier in the same task.

Field-naming convention for structured rows: use the schema's field `id` (e.g. `f_1`, `f_2`) as the JSON key, not the human label. Pinkfish's API accepts either, but the `id` form is canonical.

Example (writing a new contact):

```
1. Read databases/people/_schema.json
2. Note the field ids: f_1=Name, f_2=Email, f_3=Phone, f_4=Company, f_6=Status (required, select: Active|Inactive)
3. Write databases/people/alice-acme.json with:
   {
     "f_1": "Alice",
     "f_2": "alice@acme.com",
     "f_4": "Acme",
     "f_6": "Active"
   }
4. The next sync push validates locally and uploads to Pinkfish.
```

**Unstructured datastore — write anything.** No schema, no validation. Just put valid JSON in `databases/<colName>/<key>.json` and the sync engine treats the file as opaque content.

Filename = row key. Use a stable, idempotent slug (sanitised email for people, ticket id for tickets, etc.) so subsequent edits update the same row instead of creating duplicates.

## Creating a new datastore

Two ways. Both result in `databases/<name>/` locally + `openit-<name>` on the cloud after the next sync.

**Local-first (recommended).** Just `mkdir databases/<name>/`. Optionally drop a `_schema.json` inside if you want it structured. On next sync (60s poll or commit), OpenIT auto-creates `openit-<name>` on Pinkfish — structured if `_schema.json` exists with valid `CollectionSchema` shape, unstructured otherwise.

**Dashboard-first.** Create the datastore on the Pinkfish dashboard. On next poll, OpenIT pulls it down and creates the local `databases/<name>/` folder. The schema (if any) is written as `_schema.json`.

Don't create datastore folders OUTSIDE `databases/` — only that root is sync-tracked.

The folder name `conversations` is reserved for the local-only chat-thread store and is NOT mirrored to cloud. Don't reuse it.

## Updating a schema

`_schema.json` is bidirectional just like row files. Edit it locally; on next sync, the change pushes to Pinkfish via `PUT /datacollection/{id}/schema`. The server validates the change against existing rows — if the new schema invalidates rows that already exist (e.g. you add a required field that existing rows lack), the push fails with a clear error and your row pushes for that collection are skipped that cycle. Either fix the affected rows or revert the schema change.

If the admin edits the schema on the dashboard, the change pulls down to your `_schema.json` on next sync.

Schema-shape reference (Pinkfish `CollectionSchema`):

```json
{
  "fields": [
    { "id": "f_1", "label": "Name", "type": "string", "required": false },
    { "id": "f_2", "label": "Email", "type": "string", "required": false },
    { "id": "f_6", "label": "Status", "type": "select", "required": true,
      "options": ["Active", "Inactive"] }
  ],
  "nextFieldId": 7,
  "sortConfig": { "fields": ["Name"], "direction": "asc" }
}
```

Field types: `string`, `number`, `boolean`, `date` (ISO-8601 string OR ms-since-epoch number), `select` (string, must be one of the field's `options[]`).

## When to reach for gateway / MCP instead

You should default to file ops. The cases where the gateway / MCP wins:

1. **Semantic search across rows.** "Find tickets that look like password-reset issues" — naive `Grep "password"` misses the rephrasings ("can't log in", "lost my login"). The cloud `datastore-structured` MCP has a `natural_query` tool that uses the LLM to interpret the question against the schema. Reach for that when the search is fuzzy or large.

2. **Bulk operations on large datastores.** If the operation touches thousands of rows, file iteration is slow. The MCP's batch-update tools are faster.

3. **Cross-collection joins.** The MCP can correlate rows across `tickets` and `people` (e.g. "all tickets from people at Acme") more efficiently than you stitching multiple `Read` calls.

For each of these:

```
1. capabilities_discover with a description of what you want
2. Pick the tool from the response
3. capability_details to confirm the schema
4. gateway_invoke with { server: "datastore-structured", tool: <name>, arguments: {...} }
```

For everything else — reading specific rows, simple filters on small datastores, editing a row, creating a new row, running scripts that operate on the JSON files — use file ops. The sync engine takes care of the cloud round-trip.

## How sync works (so you trust the file ops)

When you write to `databases/<colName>/<key>.json`, the file sits on disk. On the user's next "Sync to Cloud" commit (or a programmatic `node .claude/scripts/sync-push.mjs`), OpenIT runs the push pipeline:

1. Schema-push first if `_schema.json` is dirty.
2. For each row file: validate against schema (structured only), then `POST /memory/items` for new rows or `PUT /memory/items/<id>` for changed ones.
3. Delete server rows that no longer exist locally (only when the local dir actually exists — empty-dir doesn't trigger nukes).
4. Refresh the local manifest with the post-push `updatedAt`.

You don't need to call any of those endpoints yourself for normal operations. Edit the file, the sync engine handles the rest.

If a sync conflict surfaces (`<key>.server.json` shadow file appears next to a `<key>.json`), follow the `resolve-sync-conflict` skill.

## Common requests

**"Show me all open tickets."** `Glob "databases/tickets/*.json"`, `Read` each, filter on `status: "open"`. Format as a list with subject + asker + timestamp.

**"Count tickets by status."** `Bash 'jq -r ".status // \"unknown\"" databases/tickets/*.json | sort | uniq -c'`. (`jq` is installed locally per CLI tools list.)

**"Add a new contact for Alice at Acme."** Read `databases/people/_schema.json`, build the row JSON keyed by field ids, `Write databases/people/alice-acme.json`. Confirm the change with the admin showing field labels (not ids) in the summary.

**"Edit Alice's status to Inactive."** `Read databases/people/alice-acme.json`, `Edit` the `f_6` field. Show before/after in the summary using human labels.

**"Find tickets mentioning VPN that aren't resolved."** Small set: `Grep -l "VPN" databases/tickets/`, then `Read` and filter on `status != "resolved"`. Larger set: `gateway_invoke datastore-structured natural_query`.

**"Create a new datastore for tracking projects."** `mkdir databases/projects/`. Decide structured vs unstructured: if the admin wants validation on the rows (e.g. required name + status fields), drop a `_schema.json`; otherwise leave it bare. Add a first row file. Next sync pushes it up as `openit-projects`.
