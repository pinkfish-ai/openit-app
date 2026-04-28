# MCP Tools Catalog — v1 (post-spike + first-test feedback)

**Date:** 2026-04-28 (revised after spikes; refined after first manual test)
**Branch:** `mcp-tools-catalog` (off `main`)
**Spike report:** [`2026-04-28-mcp-tools-catalog-spikes.md`](./2026-04-28-mcp-tools-catalog-spikes.md)
**Scope:** ship a simple in-app way for IT admins to install MCP servers into their OpenIT project, plus surface "Connect via Pinkfish" as the upsell path.

---

## Why

Today an IT admin in OpenIT chats with Claude but Claude has no hands — no GitHub, no Linear, no Atlassian. To wire those up they leave the app, learn `.mcp.json`, and configure servers by hand. Meanwhile Pinkfish has 250 vetted connections sitting one OAuth click away.

V1 closes that gap with the **least amount of code**: a catalog screen that calls Claude Code's own `claude mcp add` CLI to register first-party MCP servers. All 6 catalog entries are remote OAuth — install is a single click, no modal, no token paste. After install we auto-restart the embedded Claude session and auto-open `/mcp` so the user lands on the OAuth-authenticate row. The Pinkfish upsell sells **vetted tool curation + connection breadth**, not friction asymmetry (most modern MCPs are now remote OAuth, so the friction story doesn't hold).

## What we are NOT building in v1

Deliberately out of scope:
- **Custom MCP runtime / process supervisor** — Claude Code runs the server.
- **Per-tool approval policies / audit log** — Claude Code's permission modes cover v1.
- **Live fetch of `modelcontextprotocol/servers` registry** — catalog is hardcoded; v2 fetches.
- **"Pinkfish has this connection" auto-detection** — catalog hardcodes which entries get the Pinkfish CTA.
- **Edit / remove already-installed servers** — install-only in v1; advanced users hand-edit `.mcp.json` or run `claude mcp remove`. Add UI in v2.
- **Cross-platform secret storage** — Claude Code's CLI stores env vars in `.mcp.json` plaintext; that's the upstream pattern, we match it. Move to keychain in v2.

## How it slots in

OpenIT's project root for an org is `~/OpenIT/<orgId>/`. Claude Code reads `.mcp.json` from that root on session start.

- **Read path:** parse `~/OpenIT/<orgId>/.mcp.json` directly (it's tiny, well-defined JSON) → render which catalog entries are installed.
- **Write path:** **shell out to `claude mcp add --scope project <name> ...`** in the project root. The CLI handles schema validation and approval-prompt registration. Spike 2 confirmed this is the supported programmatic interface.
- **Restart + auto-`/mcp`:** Claude Code reads MCP config at session start only. After install, OpenIT auto-restarts the embedded Claude session (kill PTY → respawn) and writes `/mcp\n` into the new PTY 1.5s after spawn. The user lands directly on Claude Code's MCP panel with the cursor on the new server's `Authenticate` row — they press Enter once to OAuth in the browser. (First manual test of the original v1 surfaced that without the auto-`/mcp`, users were left staring at a `failed/not authenticated` state with no obvious next step.)
- **Pinkfish CTA:** opens the existing `PinkfishOauthModal` / Connect-to-Cloud flow with the connection name pre-filled.
- **Sync exposure:** none. Spike 1 confirmed the sync engine is allowlist-by-subdir + dotfile-filtered; `.mcp.json` at project root is double-safe.

## Files to touch

| File | Change |
|---|---|
| `src/shell/Shell.tsx` | Add `Tools` entry to the left nav, render `<ToolsPanel>` when active. Subscribe to restart events to bump `chatSessionKey`. |
| `src/shell/ToolsPanel.tsx` *(new)* | Catalog grid + installed list. Search filter. **Inline install on each card** — no modal. Per-card pending state and inline error display. |
| `src/shell/ToolsPanel.module.css` *(new)* | Scoped styles. Avoids growing 106KB `App.css`. |
| `src/shell/activeSession.ts` *(extended)* | New restart pub/sub + post-spawn command queue (drains `/mcp\n` after the new PTY's `setActiveSession` fires). |
| `src/lib/mcpInstall.ts` *(new)* | Thin wrapper: `listInstalled(projectRoot)` (parses `.mcp.json`), `installServer(projectRoot, entry)` (shells out to `claude mcp add`). |
| `src/lib/mcpCatalog.ts` *(new)* | Hardcoded catalog. Each entry: `{ id, name, description, url, vendorTag: 'first-party', pinkfishConnection?: string }`. All entries are HTTP — no transport discriminator needed. |
| `src-tauri/src/claude.rs` *(extended)* | New `claude_mcp_add` tauri::command that builds the right `claude mcp add --scope project ...` invocation and shells out via `which::which("claude")`. |

### Locked v1 catalog (6 entries — all first-party remote OAuth)

| # | Server | Install command |
|---|---|---|
| 1 | GitHub | `claude mcp add --transport http --scope project github https://api.githubcopilot.com/mcp/` |
| 2 | Linear | `claude mcp add --transport http --scope project linear https://mcp.linear.app/mcp` |
| 3 | Atlassian (Jira + Confluence) | `claude mcp add --transport http --scope project atlassian https://mcp.atlassian.com/v1/mcp/authv2` |
| 4 | Notion | `claude mcp add --transport http --scope project notion https://mcp.notion.com/mcp` |
| 5 | Sentry | `claude mcp add --transport http --scope project sentry https://mcp.sentry.dev/mcp` |
| 6 | Cloudflare | `claude mcp add --transport http --scope project cloudflare https://bindings.mcp.cloudflare.com/sse` (TODO: verify which Cloudflare MCP surface to bundle) |

**Slack and GSuite both deferred:**
- **Slack** — the official reference server was archived mid-2025; the only viable local install is a community fork (`@zencoderai/slack-mcp-server`) that requires a bot token. Users still get Slack via the "+ N more via Pinkfish" tile, where it's an OAuth one-click. Avoiding the stdio + token-paste path keeps v1 architecturally homogeneous (no modal, no `requiredEnv` machinery, no community-vendor caveat in the UI).
- **GSuite** — Google's official Workspace MCP is in preview, not GA; community workarounds aren't worth the maintenance tax. Revisit when Google ships.

### Pinkfish-upsell framing

For all six catalog entries, local install is one-click OAuth, so the Pinkfish CTA can't lean on friction asymmetry. It leans on:

- **Curation:** 15+ vetted, audit-ready tools per Pinkfish connection vs the raw, often-large surface of the official server (e.g. GitHub MCP exposes `delete_repo`).
- **Breadth:** A persistent "+ 244 more via Pinkfish →" tile at the end of the catalog grid (250 connections − 6 in-catalog).
- **Resilience:** Pinkfish's gateway abstracts vendor-server churn (e.g. the Slack reference server was archived mid-2025; GitHub MCP moved orgs).

## UX

1. **Sidebar** — `Tools` left-tab between `Overview` and `Sync`. Empty state when no project.
2. **Catalog grid** — "Give your agent hands" headline, search bar, 6 cards + a persistent `+ 244 more via Pinkfish →` tile.
3. **Per-card buttons** — primary `Install locally · OAuth`, secondary `Connect via Pinkfish` (tooltip: "15+ vetted tools, audit-ready").
4. **Inline install** — clicking `Install locally · OAuth` flips the button to `Installing…`, runs `claude mcp add` directly (no modal), then triggers an auto-restart of the embedded Claude session and writes `/mcp\n` into the new PTY 1.5s after spawn. Errors render inline on the card. No confirmation dialogs.
5. **Post-restart in the terminal** — Claude Code's `/mcp` panel opens automatically with the cursor on the new server's `Authenticate` row. User presses Enter once, OAuth happens in the browser, status flips to `connected`.
6. **Installed state** — installed cards float to the top with a green dot and "Installed" pill. No edit/remove in v1; users can `claude mcp remove <name>` from the terminal or hand-edit `.mcp.json`.

## Checklist

### Setup
- [x] Create worktree on branch `mcp-tools-catalog` (done)
- [x] Spikes 1–3 (done; see spike report)
- [ ] Linear ticket with label `Phase: Implementation`
- [ ] Commit plan + spike report to branch as starting point

### Core
- [x] `src/lib/mcpCatalog.ts`: 6 HTTP entries + types.
- [x] `src/lib/mcpInstall.ts`: `listInstalled(projectRoot)` (parse `.mcp.json`), `installServer(projectRoot, entry)` (shell out via Rust command).
- [x] `src-tauri/src/claude.rs`: `claude_mcp_add` command + register in `lib.rs`.
- [x] `src/shell/activeSession.ts`: extend with restart pub/sub + post-spawn command queue.
- [x] `src/shell/ToolsPanel.tsx` — inline install on cards, search, installed-on-top sort.
- [x] `src/shell/ToolsPanel.module.css` — scoped styles.
- [x] Pinkfish CTA button uses `openUrl(...)` to deep-link `app.pinkfish.ai/connections?provider=<id>`.
- [x] Add `Tools` left-tab to `Shell.tsx` + subscribe to restart events.

### Plugin-side
- [ ] Append a short section to `scripts/openit-plugin/CLAUDE.md`: locally-installed MCP servers are in `.mcp.json` at project root; prefer them over hand-rolled CLI calls when available. Copy to `/web` at merge time per overview doc.

### Test plan
- [x] **Unit** — `mcpCatalog.test.ts`: no duplicate IDs, every entry has https URL, name/description non-empty, `findEntry` works.
- [x] **Unit** — `mcpInstall.test.ts`: `listInstalled` parses missing/empty/malformed `.mcp.json` correctly; `installServer` builds the right `claude_mcp_add` payload for every catalog entry.
- [x] **Manual / E2E (1st pass)**: GitHub install end-to-end. Surfaced the missing-OAuth-prompt UX issue → motivated v1.1's `/mcp\n` auto-fire.
- [ ] **Manual / E2E (2nd pass, after v1.1)**: install Linear, confirm restart fires, `/mcp` panel auto-opens with cursor on Authenticate, single Enter completes OAuth, status flips to `connected`, ask Claude to "list my Linear teams" and confirm the tool call fires.
- [ ] **Manual / E2E**: `Connect via Pinkfish` opens `app.pinkfish.ai/connections?provider=<id>` in the browser.

### Ship
- [ ] Self-review with `simplify` skill
- [ ] Open PR per `auto-dev/04-PR.md`
- [ ] BugBot loop until only Low-severity findings remain
- [ ] On merge, copy plugin CLAUDE.md changes into `/web` and bump manifest version

## Open questions — resolved

1. **Catalog** — locked at 6 (GitHub, Linear, Atlassian, Notion, Sentry, Cloudflare). Slack and GSuite both deferred to the Pinkfish path.
2. **Pinkfish CTA copy** — "Connect via Pinkfish."
3. **Restart UX** — auto-restart + auto-`/mcp\n`. Decided after the original modal+restart UX left the first manual tester staring at a `failed/not authenticated` state.
4. **Catalog placement** — left-tab between Overview and Sync.
5. **Pinkfish framing** — vetted tools + connection breadth (250 vs 6), uniformly. No Slack asterisk now that Slack is gone.
6. **Approval prompt strategy** — option (a): let Claude Code's native prompt show; auto-`/mcp\n` lands the user directly on it.
7. **Modal** — none. Originally drafted with a confirm-and-trust-checkbox dialog; first manual test made it clear the modal was pure ceremony for OAuth entries. With Slack also out, there's no token-paste flow that needs a form, so the modal disappears entirely.

## Rough effort

~2 days end-to-end. Catalog data + install lib is half a day. UI + modal is another half. Auto-restart (PTY kill/respawn) is the riskiest piece — half a day with manual verification. Tests + plugin CLAUDE.md update + PR + BugBot is the remainder.
