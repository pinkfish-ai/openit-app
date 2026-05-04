# Agent sync V1 — Step 1 pre-flight findings

**Date:** 2026-04-30
**Plan:** `2026-04-30-PIN-TBD-agent-sync-v1-plan.md` (spec held by the implementing agent)

## 1) POST required fields beyond `{name, description, instructions}`

Read `/Users/sankalpgunturi/Repositories/platform/services/useragents.go` lines 71–158
(`UserAgentService.Create`) and `servers/appapi/useragents.go` lines 19–38
(`handleCreateUserAgent`).

The handler decodes the body straight into `entities.UserAgent`. The service
generates the `Id` if missing (`ua_<xid>`), sets server-side metadata
(`CreatedBy`, `CreatedDate`, `Version=1`, `VersionDate`, `VersionBy`,
`LastModified`), defaults `AgentType` to `Chat` when blank, and does
`validateResources` only on `Datastores`/`Filestores`/`KnowledgeBases` (which
are zero-valued slices when the body omits them — passes). There are no
required fields beyond what we send.

**Decision:** POST body is the same 3 fields as PATCH — `{name, description,
instructions}`. The platform fills in the rest. No defaults to inject from the
client.

## 2) PATCH 409 status code

The PATCH route is `PATCH /service/useragents/{userAgentId}` registered at
`servers/appapi/routes.go:514` (handler `handlePatchUserAgent` at
`servers/appapi/useragents.go:267`).

The handler delegates to `UserAgentService.PatchUpdate` (services/useragents.go
lines 1102–1146) which fetches the existing agent, overlays the provided keys,
then calls `Update`. Inside the repo update path, version conflicts surface as
`errors.OutOfSync` (defined in `errors/errors.go:12` as `errors.New("versions
out of sync")`). `servers/internal/helpers.go:84` maps `errors.OutOfSync` to
`http.StatusConflict` (409).

The PATCH handler at line 279 also strips read-only fields (`id`, `createdBy`,
`acl`, `versionBy`, `versionDate`, `versionDate`, `lastModified`, etc.) before
applying the patch, so even if we accidentally include them they'd be ignored
— belt-and-suspenders against client mistakes.

**Decision:** detect 409 in the PATCH adapter and throw the new `OutOfSync`
error class. Body parse for context is optional; status alone is the signal.

## 3) `selectedModel` / `isShared` UI reads

`grep -rn "selectedModel\|isShared" src/`:

- `src/lib/entities/agent.ts:37-38` — declared on `AgentRow` (these get removed).
- `src/lib/entities/agent.ts:84-86` — populated from REST response in `listUserAgents` (these get removed).
- `src/shell/Viewer.tsx:1257-1262` — reads `a.selectedModel` and `a.isShared` to render the agent summary table.

The Viewer reads are conditional (`a.selectedModel && (...)`) so they'd
gracefully render nothing if the field is absent at runtime. But narrowing
`AgentRow` removes the property declarations entirely, which breaks
TypeScript compilation in Viewer.tsx.

**Decision:** drop the two `<tr>` rows in Viewer.tsx as part of Step 3. They
render nothing useful in V1 anyway (the disk file no longer carries those
fields, so the table rows are always empty after V1). This is a small UI
shrink, not a regression; the Model/Shared columns belong to a future iteration
that re-adds those fields to the disk shape.

## 4) Runtime token PATCH smoke test

Skipped per the plan's Step 1 — no runtime token available outside a running
OpenIT instance. What I would test if I had a token:

```
curl -X PATCH "https://app-api.<env>.pinkfish.ai/service/useragents/<existing-id>" \
  -H "Authorization: Bearer <runtime-token>" \
  -H "Content-Type: application/json" \
  -d '{"description":"smoke test"}' -i
```

Expected: HTTP 200 + JSON body with the updated agent. A 401 would mean the
runtime token's scope doesn't cover service-route writes; a 403 would mean
the ACL on that agent denies write to the token's account; a 404 means the
agent id doesn't exist on this env. None of those should occur given OpenIT's
existing read path uses the same token against `/service/useragents` GET.

## 5) Plugin manifest path

Read `scripts/openit-plugin/manifest.json`. The agent template entry is line 16:

```json
{ "path": "agents/triage.template.json" }
```

`routeFile` in `src/lib/skillsSync.ts:121-130` strips `.template.json` for
agents:

```ts
if (filePath.startsWith("agents/") && filePath.endsWith(".template.json")) {
  const agentBase = filePath.replace("agents/", "").replace(".template.json", "");
  return { subdir: "agents", filename: `${agentBase}.json`, substituteSlug: false };
}
```

After Step 8's rename, the manifest entry becomes
`agents/openit-triage.template.json` and `routeFile` produces `subdir:
"agents", filename: "openit-triage.json"`. Routing logic stays unchanged.

## Additional finding — `intake.rs` reads `agents/triage.json` directly

`src-tauri/src/intake.rs` reads the agent file at three sites:

- Lines 5, 21, 626, 1196, 1200 — comments + `load_triage_agent` reads
  `repo.join("agents").join("triage.json")` literally.

The plan didn't list the Rust path. Since OpenIT's chat-intake flow shells out
to `claude -p` with the persona text + selectedModel from this file, the rename
must propagate to `intake.rs` or the intake server will silently fall back to
its hardcoded defaults ("You are a helpdesk triage agent." / "sonnet") —
defeating the purpose of editing instructions on disk.

**Decision:** add `src-tauri/src/intake.rs` to Step 8 — change the literal
`triage.json` to `openit-triage.json`. Three call sites; the comments at
lines 5/21/626/1196 are doc only but should be updated for consistency.

## Implementation impacts on the original plan

1. **Viewer.tsx delete the two `<tr>` rows** in Step 3 alongside the
   `AgentRow` narrowing.
2. **`src-tauri/src/intake.rs` rename** added to Step 8. Rust file ⇒ `cargo
   test` may need to run as part of the verification step (likely no-op since
   intake tests don't load real files).
3. **No `entity_stat` Tauri command exists.** Per the plan's Step 4 note,
   derive the post-write mtime from `entity_list_local` (`entityListLocal` in
   `src/lib/api.ts:567`) — already-existing API.
4. **POST body matches PATCH body** — three fields, `{name, description,
   instructions}`. Confirmed by reading the Create handler.
