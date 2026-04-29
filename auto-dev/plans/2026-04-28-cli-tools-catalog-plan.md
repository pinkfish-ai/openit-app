# CLI Tools Catalog — v1

**Date:** 2026-04-28
**Branch:** `cli-tools-catalog` (off `main`)
**Supersedes:** the closed-unmerged MCP-tools branch (PR #57). See "Why CLI not MCP" below for the pivot rationale; the spike work that informed this plan (sync exclusion, Workbench-station entity model, restart pub/sub) carries forward.

**Scope:** ship a curated catalog of IT-admin CLI tools the user can install with one click. Each install runs `brew install <pkg>` and adds a one-line hint to the project CLAUDE.md so Claude knows the tool is available. Install state surfaces in the Workbench's Tools station and the file explorer.

---

## Why CLI, not MCP

The MCP route would have shipped 6 first-party remote OAuth servers via `claude mcp add`. We built that, manual-tested it, and pivoted before merging. The reasons that flipped the decision:

1. **Token cost.** Each MCP server's full tool schema loads into context every turn, used or not. Six rich servers ≈ 80–120K tokens of always-on tool surface. At Sonnet 4.6 pricing that's **~$10–15 per session in pure schema overhead** before the first useful turn.
2. **Per-session tool cap.** Anthropic enforces a ceiling on tools per session. Two or three rich MCPs already crowd skills and Bash for headroom.
3. **Already aligned with OpenIT doctrine.** `auto-dev/00-autodev-overview.md` § "Quick decision tree" says: *"calling system CLIs on the user's machine (gcloud, bq, az, aws, kubectl, okta, gh, …) — if a CLI can answer the question well, prefer it. Don't reinvent."* The MCP path was the outlier.
4. **CLI surfaces are zero-cost until invoked.** A `gh pr list` call costs the bash command (~50 tokens) and its response, paid only when used. No baseline tax.
5. **Claude already knows the popular CLIs from training.** `gh`, `aws`, `gcloud`, `kubectl` need zero context. For lesser-known tools (`okta`, `mgc`, `op`) the CLAUDE.md hint includes a `<tool> --help` nudge so Claude self-discovers the surface on demand.
6. **Robust to vendor MCP churn.** Slack's reference MCP was archived mid-2025; GitHub's moved orgs; Cloudflare ships per-product surfaces. CLI tools are battle-tested and stable.

---

## Locked v1 catalog (7 entries)

| # | Tool | Binary | Brew package | Notes |
|---|---|---|---|---|
| 1 | AWS CLI | `aws` | `awscli` | IAM, EC2, S3, RDS, CloudWatch, etc. |
| 2 | Azure CLI | `az` | `azure-cli` | AAD/Entra, VMs, storage, networking. |
| 3 | Google Cloud SDK | `gcloud` | `google-cloud-sdk` | GCP projects, IAM, GKE, BigQuery, Cloud Run. |
| 4 | GitHub CLI | `gh` | `gh` | Repos, PRs, issues, releases, Actions. |
| 5 | Okta CLI | `okta` | `okta/tap/okta-cli` | Identity admin: users, groups, apps. |
| 6 | Microsoft Graph CLI | `mgc` | `microsoftgraph/tap/msgraph-cli` | M365/Entra admin: users, groups, licenses. |
| 7 | 1Password CLI | `op` | `1password-cli` | Secrets, items, service accounts. |

Covers the three pillars of IT-admin daily work: **cloud infrastructure, identity/access, secrets** — plus source control. kubectl considered and dropped (more devops than helpdesk). Snowflake / Datadog / Atlassian considered and deferred (less universal).

---

## Architecture

### Backend (Rust, `src-tauri/src/cli_tools.rs`)

Three Tauri commands:

- **`cli_is_installed(binary: String) -> bool`** — wraps `which::which`. Free PATH lookup; called per catalog entry on every Workbench load to render install/installed state.
- **`cli_install(args)`** — runs `brew install <brew_pkg>`, then splices the entry's hint line into the project's `CLAUDE.md` between `<!-- openit:cli-tools:start -->` / `<!-- openit:cli-tools:end -->` markers. Brew failure short-circuits without writing the hint.
- **`cli_uninstall(args)`** — runs `brew uninstall <brew_pkg>` AND strips the entry from `CLAUDE.md`. The CLAUDE.md update happens regardless of brew exit status; brew errors are surfaced so the UI can offer "remove from CLAUDE.md only" recovery.
- **`cli_remove_hint_only(...)`** — escape hatch for CLIs that weren't brew-managed (manual installer, pip, etc.). Strips the hint without touching the binary.

The CLAUDE.md splicing logic is pure-string and unit-tested in Rust (`#[cfg(test)] mod tests`).

### Marker-block format

```markdown
<!-- openit:cli-tools:start -->
## Installed CLI tools

These CLI tools are installed locally and available via Bash. Prefer them over hand-rolled API calls or scraping; for unfamiliar commands run `<tool> --help` to discover capabilities.

<!-- entry:aws -->- AWS CLI (`aws`) is installed. Use it for AWS operations — auth via `aws configure` or AWS_PROFILE.
<!-- entry:gh -->- GitHub CLI (`gh`) is installed. Use it for GitHub operations — auth via `gh auth login`.
<!-- openit:cli-tools:end -->
```

Per-entry sub-markers (`<!-- entry:ID -->`) make parsing reliable and idempotent — re-installing the same tool overwrites in place rather than duplicating, removing the last entry strips the block entirely.

### Frontend

- **`src/lib/cliCatalog.ts`** — hardcoded 7-entry catalog with `binary`, `brewPkg`, `claudeMdHint`, `docsUrl`.
- **`src/lib/cliInstall.ts`** — TS bridge: `listInstalled()` (calls `cli_is_installed` for every catalog entry in parallel), `installCli(...)`, `uninstallCli(...)`, `removeHintOnly(...)`. Wraps brew uninstall failures in `UninstallError` carrying a `hintRemoved` flag the UI keys off for the recovery affordance.
- **`src/shell/ToolsPanel.tsx`** + scoped `ToolsPanel.module.css` — the catalog UI rendered into the center pane.
- **`src/shell/activeSession.ts`** — extended with a restart pub/sub (no post-spawn command queue this time; CLI installs don't need an `/mcp` panel).

### Entity-model integration

Tools is a first-class entity alongside agents/workflows/databases:

- `entityIcons.tsx` — `tools` added to `EntityKind` + `ENTITY_META` with a wrench icon and the accent tone.
- `types.ts` — `{ kind: "tools" }` ViewerSource.
- `entityRouting.ts` — `rel === "tools"` → `{ kind: "tools" }`.
- `Viewer.tsx` — load-effect branch (`setMode("rendered")`) + render branch (`<ToolsPanel projectRoot={repo} />`) + header title.
- `Workbench.tsx` — `tools` station with custom counter via `listInstalledCli`.
- `project.rs` — empty `tools/` dir created on bootstrap so the file explorer surfaces it (idempotent maintenance block ensures existing projects pick it up next launch without reconnect).
- `Shell.tsx` — subscribes to `subscribeRestartRequested` to bump `chatSessionKey` after install/uninstall.

---

## UX

1. **File explorer** shows `tools/` alongside `agents/`, `databases/`, `reports/`, etc.
2. **Workbench** shows a Tools station with the count of currently-detected CLIs (from `which`).
3. **Click Tools (either path)** → Viewer renders the catalog grid in the center pane.
4. **Install** → button flips to "Installing…" → `brew install` runs → green "Installed" pill on success, inline error on failure.
5. **Uninstall** → `window.confirm` (kills active chat) → `brew uninstall` + CLAUDE.md strip → restart. If brew fails (CLI was installed out-of-band), the error renders inline with a "Already removed — just dismiss the CLAUDE.md hint" recovery button.
6. **Auto-restart after install/uninstall** so the freshly-spawned Claude session reads the updated CLAUDE.md hint section.
7. **Per-card "docs ↗" link** to the vendor docs.
8. **Pinkfish CTA on each card** — secondary, ghost-bordered. "+ 243 more via Pinkfish →" tile at the bottom.

---

## Pinkfish-upsell framing

Local CLI install gives Claude raw access to the tool's full surface — for `gh` that's hundreds of subcommands, including footguns. Pinkfish's value:

1. **Vetted tools** — 15+ curated tools per connection, audit-ready, no `delete_repo`-style sharp edges by default.
2. **Connection breadth** — 250 connections vs our 7. The "+ 243 more" tile makes this concrete.
3. **No machine setup** — Pinkfish runs in the cloud. CLI tools assume the user has brew and is willing to install software locally.

---

## Checklist

### Setup
- [x] Cut `cli-tools-catalog` worktree off main
- [x] `npm install` + `node scripts/build-slack-listener.mjs`

### Backend
- [x] `src-tauri/src/cli_tools.rs` with the four commands + Rust unit tests for splicing
- [x] Register in `src-tauri/src/lib.rs`
- [x] `project.rs` creates empty `tools/` dir on bootstrap (both new-project list and idempotent maintenance block)

### Frontend
- [x] `src/lib/cliCatalog.ts` — 7 entries
- [x] `src/lib/cliInstall.ts` — TS bridge
- [x] `src/shell/ToolsPanel.tsx` + `ToolsPanel.module.css`
- [x] `src/shell/activeSession.ts` — restart pub/sub
- [x] Entity wiring: `entityIcons.tsx`, `types.ts`, `entityRouting.ts`, `Viewer.tsx`, `Workbench.tsx`, `Shell.tsx`

### Plugin
- [x] `scripts/openit-plugin/CLAUDE.md` — section telling Claude about the locally-installed-CLIs marker block. **At merge time, mirror to `/web/packages/app/public/openit-plugin/CLAUDE.md` and bump the manifest version per the plugin sync convention in `auto-dev/00-autodev-overview.md`.**

### Tests
- [x] **Rust unit** — splicing tests in `cli_tools.rs` cover: append-block, preserve-existing-content, replace-in-place, sort-by-id, drop-block-when-last, no-op-on-unknown-id, parse-block.
- [x] **TS unit** — `cliCatalog.test.ts` (shape conformance), `cliInstall.test.ts` (mocked invoke for listInstalled / install / uninstall / removeHintOnly + UninstallError wrapping).
- [ ] **Manual / E2E** — install `gh` end-to-end; restart auto-fires; ask Claude to "list my GitHub repos" and confirm the bash invocation works. Repeat with `okta` (less-known, exercises the `--help` discovery path). Uninstall and confirm CLAUDE.md is cleaned. Try uninstalling a non-brew-managed binary to exercise the recovery path.

### Ship
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` clean
- [ ] `cargo check` clean
- [ ] Commit + push + open PR

---

## Open questions for review

1. **Catalog composition.** Locked at 7. Worth swapping any for Snowflake / Datadog / Salesforce as customer interviews come in?
2. **Curl fallback.** v1 is brew-only; the install errors out with a helpful message if brew is missing. Adding curl-based installs as fallback is per-tool work (each vendor has its own install script). Defer to v2.
3. **Plugin re-sync overwriting CLAUDE.md.** Plugin updates via `/web` manifest re-sync would clobber our marker block. Not common (plugin versions bump infrequently); the user can re-trigger by clicking install on each tool again. Self-healing regeneration on every Workbench load is a v2 nicety if this becomes a real pain point.
4. **brew install side effects.** Some packages (cask installs, `--with-X` flags) require sudo or interactive prompts. None of the 7 in the catalog do; if we add packages that need it, we'll need to surface stderr in real-time rather than the buffered output we have now.

---

## Rough effort

~1 day end-to-end. Most of the architectural shape (Workbench station, Viewer routing, restart pub/sub, entity model) carries forward from the MCP branch. The CLI-specific work is the Rust splicing + brew shell-out + the catalog data.
