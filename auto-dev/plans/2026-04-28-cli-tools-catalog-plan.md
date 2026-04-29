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

## Hybrid install flow (programmatic happy path, agent fallback)

Two iterations got us here. v1 had OpenIT shell out to `brew install` via a Tauri command, then splice CLAUDE.md from Rust. First non-trivial test (Microsoft Graph CLI — bad tap name) failed with opaque stderr. v2 pivoted to fully agentic — Claude runs brew, debugs failures, edits CLAUDE.md. Worked, but the UI lost deterministic state (we couldn't tell when the install actually finished, which meant no spinners, no proper installed-state flips, no clean error surfaces).

**v3 (this plan): hybrid + cross-platform-aware.** Programmatic install runs `brew install` directly **on macOS** so the UI sees real state — `idle → installing → installed/failed`. On brew failure, the captured stderr can be handed to Claude as a debug prompt that includes the actual error and asks Claude to pick an alternate install path. **On Windows/Linux** there's no programmatic happy path — too much per-OS, per-tool variation to maintain a static matrix. Click Install hands off to Claude immediately with the target OS as context, and Claude picks the right native install method (winget on Windows; apt/dnf/pacman/snap on Linux; vendor's recommended path otherwise).

Both fallback paths use the **same agent prompt builder** (`buildAgentInstallPrompt(entry, context)`) with a discriminated context — `{ kind: "brew-failed", stderr }` or `{ kind: "non-macos", targetOs }`. One mental model, one code path, two trigger points.

| State | UI (macOS) | UI (Windows/Linux) | Trigger |
|---|---|---|---|
| `idle` (not installed) | "Install locally" | "Install via Claude →" | Click |
| `idle` (installed) | "Uninstall" red button | "Uninstall via Claude →" red | Click |
| `busy` | "Installing…" / "Uninstalling…" | n/a (non-mac is async by definition) | While brew runs |
| `installed` | Green dot + "Installed" pill | Same | After Claude updates `which` state |
| `failed` | Error block with stderr + "Ask Claude to debug ↗" | Same (without stderr; failure means no Claude session) | brew exit ≠ 0, or no PTY for handoff |
| `handed-off` | "Sent to Claude →" disabled (4s) | Same | After agent prompt fires |

What you get: fast deterministic happy path (95% of installs), Claude as an explicit fallback for the cases where our brew metadata is wrong or the user's machine is unusual. The user sees the actual stderr they hit before deciding to involve the agent.

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

Five Tauri commands:

- **`cli_is_installed(binary)`** — `which::which` lookup. Source-agnostic; a binary the user installed manually still flips the card.
- **`cli_target_os()`** — returns `"macos"`, `"windows"`, `"linux"`, or `"unknown"`. The frontend caches the result and branches install behavior on it.
- **`cli_install(args)`** — runs `brew install <pkg>`, then splices the entry's hint line into CLAUDE.md. macOS-only by design (the frontend doesn't call it on other OSes). Brew failure short-circuits without writing the hint; stderr propagates verbatim so the UI can offer it to the agent-debug fallback.
- **`cli_uninstall(args)`** — runs `brew uninstall <pkg>` AND strips the entry from CLAUDE.md. The CLAUDE.md update happens regardless of brew exit (the CLI may have been installed out-of-band); brew errors surface for the recovery affordances.
- **`cli_remove_hint_only(...)`** — strip-the-hint without touching the binary. Used as a manual recovery option when brew uninstall failed.

The CLAUDE.md splicer (`upsert_cli_entry`, `remove_cli_entry`, `parse_block`, `rewrite_block`) is pure-string and unit-tested in Rust (8 tests covering append, preserve-existing, replace-in-place, sort-by-id, drop-block-when-last, no-op-on-unknown, parse).

### Frontend

- **`src/lib/cliCatalog.ts`** — hardcoded 7-entry catalog: `binary`, `brewPkg`, `claudeMdHint`, `docsUrl`.
- **`src/lib/cliInstall.ts`** —
  - `getTargetOs()` — cached call into Rust; returns the OS string.
  - `listInstalled()` — calls `cli_is_installed` per entry in parallel.
  - `installCli` / `uninstallCli` / `removeHintOnly` — Tauri bridges to the macOS-only Rust commands.
  - `buildAgentInstallPrompt(entry, context)` / `buildAgentUninstallPrompt(entry, context)` — pure prompt builders, unit-tested. Context is a discriminated union: `{ kind: "brew-failed", stderr }` (recovery from a macOS brew failure) or `{ kind: "non-macos", targetOs }` (initial install on Windows/Linux).
  - `requestAgentInstall(...)` / `requestAgentUninstall(...)` — write the built prompt to the active Claude session.
- **`src/shell/CliPanel.tsx`** + scoped `CliPanel.module.css` — catalog UI with the per-card state machine described above. Branches on `targetOs` at click time:
  - **macOS:** programmatic install → on failure, surface stderr + offer "Ask Claude to debug" (which fires the same agent prompt with `{ kind: "brew-failed" }`).
  - **Windows/Linux:** click immediately fires the agent prompt with `{ kind: "non-macos" }`. No brew, no stderr.

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
3. **Click Install (macOS)** → button flips to "Installing…" while brew runs. On success the card flips to the green Installed pill. On failure an inline error block appears with the captured stderr + "Ask Claude to debug ↗".
4. **Click Install (Windows/Linux)** → button reads "Install via Claude →" instead. Clicking writes a prompt to the active Claude session with the target OS as context. Card flips to "Sent to Claude →" (4s) and the user watches Claude pick the right install method (winget, apt, dnf, vendor curl, etc.) and update CLAUDE.md.
5. **Failed install** → choices: "Ask Claude to debug ↗" (writes a prompt with the actual stderr into the chat), or "Dismiss" (clear the error, retry whenever).
6. **Failed uninstall (macOS)** → same pattern, plus a "Just dismiss the hint" button for the case where brew can't manage the binary but the user is fine leaving it on disk.
7. **No auto-restart.** Programmatic install is fast enough that the same Claude session naturally picks up the new tool either via training (it knows `gh`, `aws`, etc.) or via the next message that mentions it. Future sessions read the updated CLAUDE.md on start.
8. **Per-card "docs ↗" link** to the vendor docs.

No Pinkfish CTA — Pinkfish doesn't have a parallel CLI offering, so the comparison was forced. Cloud upsell stays in the existing Connect-to-Cloud flow.

---

## Checklist

### Backend
- [x] `src-tauri/src/cli_tools.rs` — `cli_is_installed`, `cli_install`, `cli_uninstall`, `cli_remove_hint_only`. Splicer with 8 unit tests.
- [x] Register all four in `src-tauri/src/lib.rs`.

### Frontend
- [x] `src/lib/cliCatalog.ts` — 7 entries (Tailscale replaces MS Graph).
- [x] `src/lib/cliInstall.ts` — `listInstalled`, `installCli` / `uninstallCli` / `removeHintOnly`, debug-prompt builders, `requestInstallDebug` / `requestUninstallDebug`.
- [x] `src/shell/CliPanel.tsx` — deterministic per-card state machine + inline failure recovery.
- [x] `src/shell/CliPanel.module.css`.
- [x] Entity wiring: `entityIcons.tsx`, `types.ts`, `entityRouting.ts`, `Viewer.tsx`, `Workbench.tsx`.

### Plugin
- [x] `scripts/openit-plugin/CLAUDE.md` — marker convention spec so Claude knows the format. **At merge time, mirror to `/web/packages/app/public/openit-plugin/CLAUDE.md` and bump manifest version.**

### Tests
- [x] **Rust unit** — splicer tests in `cli_tools.rs`: append-block, preserve-existing-content, replace-in-place, sort-by-id, drop-block-when-last, no-op-on-unknown, parse-block, no-op-on-unchanged.
- [x] **TS unit** — `cliCatalog.test.ts` (shape conformance), `cliInstall.test.ts` (listInstalled, installCli/uninstallCli/removeHintOnly invocation shapes, UninstallError wrapping, debug-prompt builders, request functions).

### Ship
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` clean
- [ ] `cargo check` clean
- [ ] Commit + push (PR #58 auto-updates)

---

## Manual E2E plan

- **`gh` install (happy path)** — programmatic brew install runs, button flips to "Installing…" → green Installed pill, CLAUDE.md gets the marker block.
- **`tailscale` install** — less-known to Claude; verifies the `--help` discovery angle once Claude reads the new CLAUDE.md hint on the next session.
- **Failure injection** — temporarily disable brew (`mv $(which brew) /tmp/brew.bak`) and click Install. Inline error block appears with the actual stderr. Click "Ask Claude to debug" — prompt lands in the chat with the captured error. Claude picks an alternate install path. Restore brew after.
- **Uninstall** — verify CLAUDE.md block updates correctly, including the empty-block-cleanup case (uninstall the last entry).
- **Bad-tap regression** — temporarily change `okta`'s `brewPkg` to a fictional tap, click Install, confirm we get the proper error block + debug handoff (not a silent failure).

---

## Open questions for review

1. **Catalog composition.** Locked at 7. Worth swapping any for Snowflake / Datadog / Salesforce as customer interviews come in?
2. **Plugin re-sync overwriting CLAUDE.md.** Plugin manifest re-syncs from `/web` would clobber the user's marker block. Infrequent in practice. Self-healing regeneration on Workbench load is a v2 nicety.
3. **No auto-refresh of "Installed" state.** After Claude finishes installing, the catalog still shows "Install locally" until the user re-opens the panel. Polling `cli_is_installed` while a card is in "Sent" state is a v2 polish.
4. **Cost monitoring.** Each install costs roughly one Claude turn. Worth tracking per-org install counts if billing concerns surface.

---

## Rough effort

~1 day end-to-end including the two pivots (Tools→CLI naming + Pinkfish strip, then brew shell-out → agentic install). Final shape is much smaller than the v1 plan estimated — Claude does the heavy lifting and our code is mostly catalog data + UI shell + a single PATH-lookup command in Rust.
