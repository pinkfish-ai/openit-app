# Agent sync V2 — Step 1 pre-flight findings

**Date:** 2026-05-01
**Plan:** `2026-05-01-PIN-TBD-agent-sync-v2-plan.md`

## 1) Release endpoint shape

Read `/Users/sankalpgunturi/Repositories/platform/servers/appapi/useragent-releases.go`
and the route registration at `servers/appapi/routes.go:508`.

**The `/service/` path is `POST /service/useragents/by-id/{userAgentId}/releases`** — NOT
`POST /service/useragents/{id}/releases` as the plan's pseudocode shows. The `by-id/`
prefix is a Go 1.22 ServeMux disambiguation against `/service/useragents/full/{userAgentId}`
(see the comment at routes.go:507). Only the `/api/` route omits the `by-id/` segment
(routes.go:172) — that one isn't reachable via the runtime token's auth scope.

Body: empty. The handler reads `userAgentId` from the path and calls
`userAgentReleasesService.CreateRelease(ctx, acct, userAgentId)`. No request body parsing.

Idempotency on no-change: yes. When `CreateRelease` returns a release with
`UserAgentId == ""`, the handler responds `202 Accepted` with `{"message":"nothing to release"}`.
Otherwise `201 Created` with the release object. Both are non-error paths — our retry
treats the call as success on any 2xx.

**Decision:** REST wrapper hits `POST /service/useragents/by-id/{id}/releases` with no body.
Treat any 2xx as success; 4xx/5xx triggers `release_pending: true`.

## 2) PATCH overlay semantics for V2 fields

`PatchUpdate` (services/useragents.go:1102–1146) marshals the existing agent to JSON, decodes
into `map[string]json.RawMessage`, overlays each provided patch key, then unmarshals back into
`entities.UserAgent` and calls `Update`. Top-level overlay across the board.

Arrays (`promptExamples`, `datastores`, `filestores`, `knowledgeBases`, `servers`) are
whole-replace — the overlay swaps the entire array value. The plan's omit-when-absent rule
matches this: omitting `datastores` from the body preserves cloud's array; including it
replaces cloud's array with what we send.

**Decision:** plan §"Disk schema" omit-when-absent rule is correct and required. Always
present V1 fields (`name`, `description`, `instructions`); conditionally include V2 fields.

## 3) DataCollectionReference wire shape

`entities/entities.go:1592-1601`:

```go
type DataCollectionReference struct {
    Id              string `json:"id"`
    Name            string `json:"name"`
    Description     string `json:"description"`
    CanRead         bool   `json:"canRead"`
    CanWrite        bool   `json:"canWrite"`
    CanDelete       bool   `json:"canDelete"`
    ProxyEndpointId string `json:"proxyEndpointId"`
    IsStructured    *bool  `json:"isStructured,omitempty"`
}
```

`validateResources` (services/useragents.go:49-68) requires non-empty `Id`, `Name`,
`ProxyEndpointId` AND at least one of `CanRead`/`CanWrite`/`CanDelete`. Empty fields throw
`BadRequest`, which kills the entire POST/PATCH (not skip-with-warning).

Validation runs at Create time (Create:78-86) AND inside Update — confirmed via the call
chain `PatchUpdate → Update → validateResources`. So a partial reference kills PATCH too.

**Decision:** `resolveResourceRefs` MUST emit refs with all four required fields populated
or treat the row as unresolvable (skip with warning). Missing description / isStructured
are fine — both are optional on the wire (description has no `omitempty` tag but empty
string is valid; isStructured is a pointer with omitempty).

## 4) `listAllCollections` / proxyEndpointId resolution

**There is no single REST endpoint that lists all collections.** Confirmed:

- `src/lib/syncEngine.ts:1224-1237` defines a private `listAllCollections` factory closure
  inside the per-class engine — it's just `GET /datacollection/?type=<type>` with the type
  parameter required (the per-type filter is set right above the call: line 1230).
- The platform-side handler is the same: per-type list with no aggregate endpoint.

**`proxyEndpointId` is NOT returned from `/datacollection/`.** The `DataCollection` shape
(`src/lib/skillsApi.ts:21-31`) doesn't carry it. To resolve the proxy ID for a collection,
we'd need to fetch `GET /api/proxy-endpoints` and match `proxyEndpoint.resourceId === collection.id`
+ `proxyEndpoint.resourceType` matches the collection type. This is what the web builder does
(`web/packages/app/src/routes/agents/hooks/agent-editor/useProxyEndpoints.ts`).

ResourceType strings the platform recognizes (proxy-endpoints.go:103): `"filestore"`,
`"datastore"`, `"knowledge_base"` (underscore, not kebab), `"token"`, `"useragents"`.

**Major plan deviation:** the plan's pseudocode `listKbCollections / listFsCollections /
listDsCollections` returning the proxyId alongside the collection is not how the platform
exposes the data. The actual flow needs FOUR fetches in parallel:

1. `GET /datacollection/?type=knowledge_base` — list KB collections
2. `GET /datacollection/?type=filestore` — list filestore collections
3. `GET /datacollection/?type=datastore` — list datastore collections
4. `GET /api/proxy-endpoints` — list ALL proxy endpoints (one shot, no per-type filter)

Then build a `Map<resourceId, proxyEndpointId>` from the proxy list and join.

**Decision:** plan's three-fetch claim is wrong by one. We need four parallel fetches at push
time when resources is non-empty. Latency cost is still small (one extra round-trip in
parallel). Note this in the implementation comment block. Skip-with-warning still applies
when the proxy lookup misses (the collection exists but no proxy registered).

## 5) McpServer minimal-shape acceptance

`entities/entities.go:1745-1752`:

```go
type McpServer struct {
    Name       string                `json:"name"`
    ServiceKey string                `json:"serviceKey,omitempty"`
    IsDynamic  bool                  `json:"isDynamic,omitempty"`
    Embedded   bool                  `json:"embedded,omitempty"`
    AllTools   bool                  `json:"allTools,omitempty"`
    Tools      map[string]ToolConfig `json:"tools,omitempty"`
}
```

The wire-level field on UserAgent is `servers` (entities.go:1615), not `tools`. The plan
calls the disk-side block `tools.servers` — adapter must translate disk `tools.servers` →
wire `servers`.

`Name` is required (no omitempty). All other fields are optional. Sending `{name, allTools:
true}` per the plan is accepted: `serviceKey` empty is fine, `tools` omitted means
all-by-default which is consistent with `allTools: true`.

**Decision:** wire shape `[{name: "knowledge-base", allTools: true}, ...]`. Disk → wire is
`tools.servers` field rename to `servers`.

## 6) `autoCommitDriver.ts` regression check

`src/lib/autoCommitDriver.ts:53-79`. The path predicate matches:

- `databases/tickets/*.json`
- `databases/people/*.json`
- `databases/conversations/<ticketId>` (rolled to dir)
- `filestores/attachments/<ticketId>` (rolled to dir)

Returns null for everything else. `agents/...` is null → not auto-committed. Same for
`agents/triage/triage.json`, `agents/triage/common.md`, etc.

**Decision:** plan's regression test request is fine — assert null for `agents/triage/triage.json`
and `agents/triage/common.md`.

## 7) `routeFile` and write-once gate

Confirmed both bugs in plan §"Plugin manifest routing":

- `routeFile` for input `agents/triage/triage.template.json` produces
  `filename: "triage/triage.json"` with a slash. `entity_write_file` would create the file
  literally at `<repo>/agents/triage/triage.json` because the Rust side concatenates
  `subdir + filename` with a `/`. Actually — needs checking. Let me verify:

  Inspected `src-tauri/src/lib.rs` for `entity_write_file`. The Rust handler joins
  `repo.join(subdir).join(filename)`, so a slash inside `filename` would mean
  `Path::join("agents", "triage/triage.json")` — `Path::join` treats the second arg as
  literal so it lands at `agents/triage/triage.json`. **It would actually work by accident.**
  But `git add` and other path-aware tools may misbehave. The plan's fix is cleaner anyway:
  preserve folder in subdir, strip `.template` from basename only.

- Write-once gate: `route.subdir === "agents"` exact-match miss for `route.subdir ===
  "agents/triage"`. Confirmed at `skillsSync.ts:205-212`. Fix to `startsWith("agents/")`
  per plan.

**Decision:** apply both rewrites verbatim per plan §"Plugin manifest routing".

## 8) Existing V1 disk layout

V1 ended with disk files at `agents/triage.json` (unprefixed local form) — confirmed by:

- `src/App.tsx:82` reads `${repo}/agents/triage.json`
- `src/lib/entities/agent.ts:39, 96` references `agents/<name>.json` with `name = "triage"`
- `src-tauri/src/intake.rs:1205` reads `agents/triage.json`
- The migration shim `migrateLegacyTriageFilename` from V1 was never landed — V1 ended up
  applying the `openit-` prefix at the sync boundary instead (commits `013c127` /
  `b8853ee`).

So the V2 migration source is `agents/triage.json` (flat) → `agents/triage/triage.json`
(folder). Same as the plan describes. No second-level rename concern (no openit-triage.json
exists on V1 disk).

## 9) Edit tab — current state

`src/shell/Viewer.tsx:1711-1853` — three modes (rendered / edit / raw) already wired for
agent sources via `agentEditDraft` state. The current Edit form has just two fields
(description + instructions). V2 expansion replaces this section in place.

## 10) Cargo test environment

`src-tauri/src/intake.rs::load_triage_agent` is called from `intake.rs:627` inside a test
path (chat intake handler, but cargo tests don't construct that path). No direct cargo test
loads agent files at fixed disk locations today. The legacy-flat fallback is still
defensible (per plan's §"Rust-side fallback") because dev workflows (clearing
`~/OpenIT/local/`, running cargo test on a fresh checkout) leave disk in inconsistent
states.

## Summary of plan deviations

1. **Release endpoint path** — `/service/useragents/by-id/{id}/releases`, not the plan's
   `/service/useragents/{id}/releases`. Hard requirement.
2. **Resource resolution needs FOUR parallel fetches**, not three. The fourth is `GET
   /api/proxy-endpoints` to map collection → proxy ID. Plan's three-fetch model is wrong by
   one.
3. **Wire field is `servers`, not `tools`.** Disk uses `tools.servers`; adapter renames.
4. **Web sets `proxyEndpointId: ''` in some chat-upload paths** — that's a different code
   path (file upload), not agent save. Agent save at
   `web/packages/app/src/routes/agents/agent-editor/AgentEditorContext.tsx:487-498` does
   pass real proxy IDs from a fetched proxy-endpoints list.

These are absorbed into the implementation plan below; the plan markdown file stays as the
spec of record.
