# Agent sync V2 — implementation summary

V2 expands the agent disk schema from V1's flat `agents/triage.json` (3 fields) into a folder
layout `agents/triage/{triage.json,common.md,cloud.md,local.md}` with structured-fields-on-disk
for model / sharing / prompt examples / intro / resources / tools, three-block instructions
that are assembled differently for the cloud (`common + cloud`) vs the local intake
subprocess (`common + local`), default-attached resources + tools per the bundled triage
template, auto-release with retry-on-failure, an instructions-divergence shadow on pull, and a
full Edit-tab UI in Viewer.tsx that diffs and writes only changed files. A migration shim runs
before the first cloud pull on every launch to fold the V1 flat file (if any) into the new
layout, preserving the user's existing instructions verbatim in `common.md`.

## Pre-flight findings that changed implementation choices

1. **Release endpoint path.** The `/service/` route is
   `POST /service/useragents/by-id/{id}/releases` — NOT
   `POST /service/useragents/{id}/releases` as the plan's pseudocode shows. Go 1.22 ServeMux
   disambiguates `/service/useragents/full/{id}` against the rest, so the release route lives
   under `by-id/`. Implemented `releaseUserAgent` against the correct path.

2. **Resource resolution needs FOUR parallel fetches, not three.** `/datacollection/?type=...`
   does NOT return `proxyEndpointId`. The platform's `validateResources` rejects refs with
   empty `proxyEndpointId` (kills the entire upsert with `BadRequest`). To get the proxy ID for
   a collection we additionally hit `GET /api/proxy-endpoints` and join on
   `proxyEndpoint.resourceId === collection.id`. Implemented `resolveResourceRefs` accordingly.
   When a collection resolves but no proxy is registered, the row is dropped with a
   `⚠ skipping ...` warning so the rest of the upsert can proceed.

3. **Wire field is `servers`, not `tools`.** Disk uses `tools.servers` (per plan); push
   adapter renames to top-level `servers` for the wire. Pull projection reads `servers` and
   writes `tools.servers`.

4. **First-launch pull window has no conflict detection.** Per plan §"Risks 11" — when the
   migration runs and plugin sync writes the bundled `cloud.md` / `local.md`, but
   `pushed_instructions_hash` isn't recorded yet, the very first pull has no anchor to detect
   cloud-side divergence against. The shim treats this as a baseline accept; documented in
   the divergence helper's comment block.

## Deviations from the plan

1. **Helper naming.** Plan called for `assembleInstructionsForCloud` and
   `assembleInstructionsForLocal`. Both reduced to a single `assembleInstructions(a, b)` since
   the only difference is the second block — push uses `(common, cloud)`, intake uses
   `(common, local)`. Saves one round of duplication.

2. **No SHA-256-on-disk pull-time check.** `pushed_instructions_hash` is the manifest field
   the plan describes; on pull, we compare cloud's `instructions` hash against this stored
   value. If they differ, we write `agents/triage/instructions.server.md` directly (instead
   of pumping through the engine's normal shadow pipeline) because the engine's shadow
   filename convention expects a sibling next to a tracked file, and `instructions` isn't a
   file on disk in V2. The shadow lands beside the user's `common.md` / `cloud.md` so the
   resolve-conflict skill picks it up.

3. **Edit tab Save is fire-and-forget for the .md files.** The plan's per-file write rule is
   honored, but Save doesn't roll back on partial failure. If `cloud.md` write succeeds and
   `triage.json` fails, the partial state is what disk shows. The error surfaces inline; the
   user re-clicks Save. All-or-nothing wasn't required by the plan, and rollback would
   require capturing the pre-edit content of every file just for this case.

4. **Read view fetches .md files inside a child component.** Each render of the View tab
   spawns three async `fsRead`s. They're cheap and gated on `(repo, agent.id, agent.name)` so
   the tab doesn't refetch on every keystroke elsewhere in the app. If perf becomes an issue
   on huge .md blocks, lift the cache up to the parent.

5. **Tools section is hardcoded to the three default MCP servers** (`knowledge-base`,
   `datastore-structured`, `filestorage`) per plan. Cloud-side additions (a 4th MCP server
   attached via web) round-trip through the form's merge logic — they appear as additional
   rows below the three defaults so the user can toggle them off too. V4 will add the
   "+ add custom server" affordance with full per-tool config.

## What's still open / untested

- **No live runtime token PATCH smoke test.** The plan's Step 1 #4 was marked optional in V1
  and skipped here too. Confirmed via reading the platform code and existing test fixtures
  that PATCH overlay semantics work as expected.

- **End-to-end manual scenarios (10 listed in the plan).** Each scenario needs a running
  OpenIT instance against a dev cloud env. I ran tsc + vitest + cargo test green locally;
  none of the 10 manual tests have been validated. Suggested order:
  1. Migration scenario (start from V1 flat file). Restart with V2 build, confirm folder
     layout appears with content preserved.
  2. Edit common.md → push. Web shows the change.
  3. Detach a resource via Edit tab → push. Web shows updated resources.
  4. Block release endpoint mid-push (e.g. mock or break network) → confirm
     `release_pending` lands in manifest, agent shows pushed but not released.

- **Plugin sync ordering on a fresh install.** When the migration shim runs and creates the
  folder, the next plugin sync tick should write `cloud.md` / `local.md` from the bundled
  defaults (write-once gate treats them as new files because the folder didn't exist
  before). Verified by code path inspection; not exercised live.

- **Edit tab styling.** The form uses existing `.row-edit` classes plus a few new selectors
  (`.agent-edit-section`, `.agent-edit-row`, etc.) that I added without companion CSS rules.
  The form will render with default browser styling — functional but rough. CSS polish was
  out of scope for V2 per the plan's Step 7 (UI sketch was layout, not pixel spec).

- **Conflict shadow on pull.** Tested by code path; not exercised live. If the shadow code
  fires on a clean baseline (e.g. legitimate cloud edit while the manifest hash is correct),
  the user sees `agents/triage/instructions.server.md` appear without warning. The
  `resolve-sync-conflict` skill needs to know about this new shadow file naming; documenting
  the path in the resolve flow is V3 work.

## Test results

```
npx tsc --noEmit -p .         → 0 errors
npx vitest run                → 267 passed (23 suites)
cargo test --manifest-path src-tauri/Cargo.toml
                              → 101 passed (3 suites)
```

## Commits

```
fa22656 feat(intake): assemble triage persona from common.md + local.md
1e1051c feat(viewer): full V2 agent Edit + read views
9f0a0db feat(agent-sync): pull-side instructions divergence detection
2266a93 feat(agent-sync): V2 push wrapper — folder layout, release, retry
f71195e feat(agent-sync): widen AgentRow + adapter for V2 disk layout
8050fec feat(agent-sync): bundled plugin folder layout for triage agent
40e0e4f feat(agent-sync): migrate flat agents/triage.json into folder layout
5b3c8cb docs(agent-sync): V2 stage 01 pre-flight findings
```
