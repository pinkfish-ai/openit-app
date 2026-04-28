# MCP Tools Catalog — Spike Findings (2026-04-28)

Pre-implementation spike to validate three "must-fix" risks called out in the v1 plan critical review. All three resolved; one materially reshapes the design.

---

## Spike 1 — Sync engine exclusion ✅ Cleared

**Question:** Will writing `~/OpenIT/<orgId>/.mcp.json` (containing IT-admin secrets) get uploaded to Pinkfish by the existing sync engine?

**Answer:** No. Two independent guards.

1. **Allowlist architecture.** `pushAllEntities` in `src/lib/pushAll.ts:18` only invokes three named pushers (`pushAllToKb`, `pushAllToFilestore`, `pushAllToDatastores`). Each scopes its local listing to a hardcoded subdir: `knowledge-bases/default`, `filestores/library`, `databases/openit-*`. A file at the project root falls outside all three.
2. **Dotfile filter.** `entity_list_local` in `src-tauri/src/kb.rs:680` skips any entry where `name.starts_with('.')`. Even if `.mcp.json` were inside one of the synced subdirs, it would still be filtered.

**Action required: none.** Zero code changes for sync exclusion.

---

## Spike 2 — Claude Code MCP config strategy ✅ Cleared, with recommendation flip

**Question:** Where does Claude Code expect MCP config? Is `claude mcp add` a stable programmatic interface? Does config hot-reload?

**Answers:**
- **File:** `.mcp.json` at project root, `mcpServers` object. Schema is stable and documented.
- **`claude mcp add --scope project` is the recommended programmatic path.** Handles schema validation, file creation, and approval-prompt registration. Supports `--transport stdio | http | sse` and `--env KEY=value`. Source: https://code.claude.com/docs/en/mcp.
- **No hot-reload.** Config is read at session start only. The embedded Claude session must be restarted for new servers to take effect.

**New gotcha discovered:** project-scoped servers trigger a **one-time approval prompt inside Claude Code itself** the first time the user starts a session after install. We don't write the config and have it Just Work — Claude Code shows its own confirmation. UX needs to set expectations for this.

**Plan change:**
- Replace direct `.mcp.json` writes with shell-out to `claude mcp add --scope project ...`. Removes our schema risk and most of `mcpConfig.ts` (it becomes a thin command-builder + spawn wrapper).
- Restart UX must account for the in-Claude approval prompt as part of the auto-restart flow.

---

## Spike 3 — Catalog verification ⚠️ Reshapes the design

**Question:** Are the 8 candidate servers (GitHub, Slack, Linear, Jira, Notion, GSuite, AWS, 1Password) actively maintained, and what's their install method as of April 2026?

**Headline finding: most modern first-party MCPs are remote (HTTP) with OAuth, not local stdio with token paste.** This invalidates the v1 plan's core "friction is the wedge" framing for the Pinkfish upsell.

| Server | Status | Install | Required creds |
|---|---|---|---|
| GitHub | ✅ Vendor-published | Remote HTTP (`api.githubcopilot.com/mcp/`) | OAuth |
| Linear | ✅ Vendor-published | Remote HTTP (`mcp.linear.app/mcp`) | OAuth |
| Atlassian (Jira+Confluence) | ✅ Vendor-published (Rovo MCP, GA) | Remote HTTP (`mcp.atlassian.com/v1/mcp/authv2`) | OAuth |
| Notion | ✅ Vendor-published | Remote HTTP preferred (`mcp.notion.com/mcp`); npx fallback | OAuth (remote) or token (npx) |
| Slack | ⚠️ Reference archived; community fork | `npx @zencoderai/slack-mcp-server` | Bot token + team ID |
| Google Workspace | ⚠️ Google preview not GA; community servers | Community `.dxt` or `uvx` | Google OAuth |
| AWS | ⚠️ Multi-server umbrella (`awslabs/mcp`) | `uvx awslabs.core-mcp-server` (Python `uv` required) | AWS SDK env vars |
| 1Password | ❌ No vendor-published server | Community wraps native `op` CLI | Service account token |

**Recommended catalog changes:**
- **Drop AWS** — requires `uvx`/Python; most IT admins won't have it. Pinkfish has AWS via gateway anyway, so this becomes a strong upsell row instead.
- **Drop 1Password** — no first-party server, native CLI dependency, and the security blast radius of an unofficial credential-vault MCP is hard to justify.
- **Add Sentry** — official remote MCP at `mcp.sentry.dev`, OAuth, high IT-admin signal.
- **Add Cloudflare** — official remote MCP, OAuth, common IT-admin surface.
- **GSuite** — keep, with a "Coming with Google's official server" caveat banner; defer the actual install path (community `.dxt` is messy) until Google's preview goes GA.

**Proposed v1 catalog (7 servers, all OAuth except Slack):**

| # | Server | Type | Notes |
|---|---|---|---|
| 1 | GitHub | Remote OAuth | First-party |
| 2 | Linear | Remote OAuth | First-party |
| 3 | Atlassian | Remote OAuth | First-party |
| 4 | Notion | Remote OAuth | First-party |
| 5 | Sentry | Remote OAuth | First-party |
| 6 | Cloudflare | Remote OAuth | First-party |
| 7 | Slack | npx + bot token | Third-party fork (Zencoder); flag as "community" in UI |

GSuite parked until Google ships the official remote server.

---

## The big consequence: Pinkfish-upsell premise needs rewriting

The v1 plan said: *"Friction is the wedge — local install asks for tokens, Connect via Pinkfish is one-click OAuth."*

That's no longer true for **6 of 7** catalog entries. For remote OAuth MCPs, local install is also one-click OAuth — friction asymmetry is roughly zero.

**The Pinkfish value prop has to shift to:**
1. **Tool curation.** Each Pinkfish connection ships 15+ vetted tools — narrower, audit-readier, policy-pre-applied — vs whatever raw surface the official server exposes (often hundreds of tools, many of which are footguns).
2. **Connection breadth.** 250 connections vs our 7. The catalog becomes a *teaser* for the rest.
3. **Gateway abstraction.** Workflows authored against the gateway are connection-agnostic and survive vendor-server churn (e.g. the Slack reference server getting archived mid-2025, GitHub MCP moving from `modelcontextprotocol/servers` to `github/github-mcp-server`).

**Implication for catalog UI:** the dual-CTA on each card still works, but the copy and the visual emphasis change. Recommend:
- For OAuth-easy entries (6/7): primary CTA is **Install locally · OAuth** (no friction asymmetry to exploit), secondary is **Connect via Pinkfish** with tooltip "15+ vetted tools, audit-ready policies."
- For the Slack entry (and any future token-paste entries): primary CTA is **Connect via Pinkfish** (where the friction story is real); secondary is **Install locally · paste token** with the third-party-fork caveat.
- A persistent "+ 243 more via Pinkfish →" tile at the end of the catalog grid for the breadth pitch.

---

## Decisions needed from you before I touch code

1. **Lock the catalog.** Confirm the proposed 7 (GitHub, Linear, Atlassian, Notion, Sentry, Cloudflare, Slack) — or push back on any swap.
2. **GSuite:** include with a "coming soon" placeholder, or omit entirely until Google's server is GA?
3. **Pinkfish framing.** OK with the new "vetted tools + 250 connections" angle, or do you want to keep "friction is the wedge" and ship a different catalog (more token-paste entries) to defend it?
4. **Auto-restart UX with Claude Code's approval prompt.** When we restart the embedded session post-install, the user will see Claude Code's own native approval modal for the new project-scoped server. Two options:
   - (a) Restart, let Claude Code's prompt handle it. Cheap, but two confirmations (ours + Claude's).
   - (b) Pre-approve at install time by writing the trust record to Claude Code's settings ourselves. Cleaner UX, but reaches into Claude Code internals — fragile.
   Leaning (a). Confirm?

Once those four are locked, I'll update the v1 plan and start implementing.
