# CLI Catalog — v1

**Date:** 2026-04-28
**Branch:** `cli-tools-catalog` (off `main`)
**Supersedes:** the closed-unmerged MCP-tools branch (PR #57). See "Why CLI not MCP" below; the spike work that informed this plan (sync exclusion, Workbench-station entity model) carries forward.

**Scope:** ship a curated catalog of IT-admin CLI tools. Click Install on a card and **Claude itself** runs the install (brew first, vendor fallback as needed) and updates the project's `CLAUDE.md` so it knows the tool is available. The catalog is reachable via the Workbench **CLI** station only — no on-disk `cli/` directory, no file-explorer entry.

---

## Why CLI, not MCP

The MCP route shipped 6 first-party remote OAuth servers via `claude mcp add`. Built, manual-tested, and pivoted before merging:

1. **Token cost.** MCP server schemas load into context every turn whether used or not. Six rich servers ≈ 80–120K tokens of always-on tool surface. ~$10–15/session in pure schema overhead at Sonnet 4.6 prices.
2. **Per-session tool cap.** Anthropic enforces a ceiling. Two or three rich MCPs already crowd skills and Bash for headroom.
3. **Aligns with OpenIT doctrine.** `auto-dev/00-autodev-overview.md` § "Quick decision tree": *"calling system CLIs on the user's machine — if a CLI can answer the question well, prefer it."*
4. **Zero-cost until invoked.** A `gh pr list` call costs the bash command and its response, paid only when used.
5. **Claude already knows the popular CLIs.** `gh`, `aws`, `gcloud` need zero context. For lesser-known tools the CLAUDE.md hint includes a `<tool> --help` nudge for runtime discovery.

---

## Why agentic install (not direct shell-out)

The first version of the CLI flow had OpenIT shell out to `brew install` via a Tauri command, then splice the project CLAUDE.md from Rust. First non-trivial test (Microsoft Graph CLI — bad tap name) failed with opaque stderr and no path forward. Pivoted again, mid-PR:

**Click Install → write a structured prompt into the active Claude session.** Claude runs brew, sees the output, debugs failures, falls back to vendor docs, and edits CLAUDE.md per the marker convention. Same pattern Claude uses for everything else in OpenIT.

Trade-off: one Claude turn per install (cost: pennies). What you get: robust to bad metadata, robust to per-OS install variation, fully transparent to the user (they see the agent work in the chat), and *much* less code on our side. No more brew shell-out, no more Rust string-splicing, no more session restart wiring.

---

## Locked v1 catalog (7 entries)

| # | Tool | Binary | Brew package | Notes |
|---|---|---|---|---|
| 1 | AWS CLI | `aws` | `awscli` | IAM, EC2, S3, RDS, CloudWatch. |
| 2 | Azure CLI | `az` | `azure-cli` | AAD/Entra, VMs, storage, networking. |
| 3 | Google Cloud SDK | `gcloud` | `google-cloud-sdk` | GCP projects, IAM, GKE, BigQuery, Cloud Run. |
| 4 | GitHub CLI | `gh` | `gh` | Repos, PRs, issues, releases, Actions. |
| 5 | Okta CLI | `okta` | `okta/tap/okta-cli` | Identity admin: users, groups, apps. |
| 6 | Tailscale CLI | `tailscale` | `tailscale` | Zero-trust VPN admin: devices, ACLs, exit nodes. |
| 7 | 1Password CLI | `op` | `1password-cli` | Secrets, items, service accounts. |

Microsoft Graph CLI was in v1 but pulled (no canonical brew formula — the tap I specified was fictional). Tailscale takes its slot — clean brew install, real IT-admin daily-work tool. kubectl considered and dropped (more devops than helpdesk). Snowflake / Datadog / Atlassian considered and deferred.

---

## Architecture

### Backend (Rust, `src-tauri/src/cli_tools.rs`)

A single Tauri command — `cli_is_installed(binary: String) -> bool`. Wraps `which::which`. Free PATH lookup the catalog UI calls per entry to render install/installed state. Detection is source-agnostic — a binary the user installed manually flips the card to "Installed" without OpenIT having done anything.

Everything else (running brew, vendor fallback, CLAUDE.md splicing) is Claude's responsibility now.

### Frontend

- **`src/lib/cliCatalog.ts`** — hardcoded 7-entry catalog with `binary`, `brewPkg`, `claudeMdHint`, `docsUrl`.
- **`src/lib/cliInstall.ts`** — `listInstalled()` (calls `cli_is_installed` for every catalog entry in parallel), `buildInstallPrompt(entry)` / `buildUninstallPrompt(entry)` (pure functions, unit-tested), `requestCliInstall(entry)` / `requestCliUninstall(entry)` (write the prompt into the active Claude session via `writeToActiveSession`).
- **`src/shell/CliPanel.tsx`** + scoped `CliPanel.module.css` — the catalog UI rendered into the center pane. Click Install → request flies → button flashes "Sent to Claude →" for 4 seconds.

### Marker-block convention

Documented in `scripts/openit-plugin/CLAUDE.md` so Claude reads it on session start and knows the format without OpenIT having to repeat it in every prompt:

```
<!-- openit:cli-tools:start -->
## Installed CLI tools

These CLI tools are installed locally and available via Bash. Prefer them over hand-rolled API calls or scraping; for unfamiliar commands run `<tool> --help` to discover capabilities.

<!-- entry:aws -->- AWS CLI (`aws`) is installed. Use it for AWS operations — auth via `aws configure` or AWS_PROFILE.
<!-- entry:gh -->- GitHub CLI (`gh`) is installed. Use it for GitHub operations — auth via `gh auth login`.
<!-- openit:cli-tools:end -->
```

Per-entry sub-markers (`<!-- entry:ID -->`) keep the block parseable so re-installing an entry replaces the line in place rather than duplicating, and removing the last entry strips the entire block.

### Entity-model integration

CLI is a first-class Workbench entity (no file-explorer presence — system state, not project content):

- `entityIcons.tsx` — `cli` added to `EntityKind` + `ENTITY_META` with a wrench icon and accent tone.
- `types.ts` — `{ kind: "cli" }` ViewerSource.
- `entityRouting.ts` — `rel === "cli"` → `{ kind: "cli" }`.
- `Viewer.tsx` — load-effect branch + render branch (`<CliPanel projectRoot={repo} />`) + header title.
- `Workbench.tsx` — `cli` station counted via `listInstalled`.
- `project.rs` — no on-disk dir created; CLI lives entirely in `which` + CLAUDE.md.

---

## UX

1. **Workbench** shows a **CLI** station with the count of currently-detected CLIs.
2. **Click CLI** → Viewer renders the catalog grid in the center pane.
3. **Click Install** → an install prompt is written into the active Claude session as a new turn. The card's button flashes "Sent to Claude →" for 4 seconds.
4. **Watch Claude work in the chat.** Claude runs `brew install`, sees its output, debugs failures (bad tap, missing formula, network) the way a human would, and updates CLAUDE.md when the install succeeds.
5. **Uninstall** mirrors install. `window.confirm` guards (since the chat will be visibly busy for a moment) but doesn't kill any sessions — the same Claude that runs the uninstall already has the new CLAUDE.md state in context.
6. **No auto-restart.** The session that runs the install also edits CLAUDE.md — it doesn't need to re-read the file. Future sessions read the updated CLAUDE.md naturally on start.
7. **Per-card "docs ↗" link** to the vendor docs.

No Pinkfish CTA — Pinkfish doesn't have a parallel CLI offering, so the comparison was forced. Cloud upsell stays in the existing Connect-to-Cloud flow.

---

## Checklist

### Backend
- [x] `src-tauri/src/cli_tools.rs` — single `cli_is_installed` command (everything else moved to Claude).
- [x] Register in `src-tauri/src/lib.rs`.

### Frontend
- [x] `src/lib/cliCatalog.ts` — 7 entries (Tailscale replaces MS Graph).
- [x] `src/lib/cliInstall.ts` — `listInstalled`, prompt builders, `requestCliInstall` / `requestCliUninstall`.
- [x] `src/shell/CliPanel.tsx` + `CliPanel.module.css`.
- [x] Entity wiring: `entityIcons.tsx`, `types.ts`, `entityRouting.ts`, `Viewer.tsx`, `Workbench.tsx`.

### Plugin
- [x] `scripts/openit-plugin/CLAUDE.md` — marker convention spec so Claude knows the format. **At merge time, mirror to `/web/packages/app/public/openit-plugin/CLAUDE.md` and bump manifest version.**

### Tests
- [x] **TS unit** — `cliCatalog.test.ts` (shape conformance), `cliInstall.test.ts` (listInstalled, prompt builders, request functions).

### Ship
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` clean
- [ ] `cargo check` clean
- [ ] Commit + push (PR #58 auto-updates)

---

## Manual E2E plan

- **`gh` install** — Claude is well-trained on it; should run `brew install gh` and update CLAUDE.md without drama. Validates the happy path.
- **`okta` install** — less-known to Claude; exercises the marker convention more carefully and the `<tool> --help` discovery angle.
- **`tailscale` install** — also less-known; second pass at the discovery flow.
- **Failure injection** — uninstall brew temporarily (`mv $(which brew) /tmp/brew.bak`) and try installing. Should see Claude debug, suggest curl, fall back to docs. Restore brew after.
- **Uninstall** — verify the CLAUDE.md block updates correctly, including the empty-block-cleanup case (uninstall the last entry).

---

## Open questions for review

1. **Catalog composition.** Locked at 7. Worth swapping any for Snowflake / Datadog / Salesforce as customer interviews come in?
2. **Plugin re-sync overwriting CLAUDE.md.** Plugin manifest re-syncs from `/web` would clobber the user's marker block. Infrequent in practice. Self-healing regeneration on Workbench load is a v2 nicety.
3. **No auto-refresh of "Installed" state.** After Claude finishes installing, the catalog still shows "Install locally" until the user re-opens the panel. Polling `cli_is_installed` while a card is in "Sent" state is a v2 polish.
4. **Cost monitoring.** Each install costs roughly one Claude turn. Worth tracking per-org install counts if billing concerns surface.

---

## Rough effort

~1 day end-to-end including the two pivots (Tools→CLI naming + Pinkfish strip, then brew shell-out → agentic install). Final shape is much smaller than the v1 plan estimated — Claude does the heavy lifting and our code is mostly catalog data + UI shell + a single PATH-lookup command in Rust.
