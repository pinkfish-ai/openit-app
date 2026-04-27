# OpenIT Local-First — The Plan

**Status:** Active. Direction shift from "Pinkfish-cloud-by-default" to "local-by-default, cloud-as-upgrade."

## The flip

OpenIT is repositioned as a **local IT helpdesk you own.** Your datastores, knowledge base, agents, workflows, and tickets all live as files on your disk. Zero sign-up, zero subscription, full functionality out of the box. You can run the whole thing on a single laptop and never push anything anywhere.

Pinkfish becomes an **opt-in cloud upgrade** that adds capabilities the local mode genuinely can't do — channel ingest, always-on agent runtime, multi-device sync, third-party-system integrations. That's where the paid tier earns its keep.

## What "local" actually means for each entity

| Entity | Local representation | Local "operations" |
|---|---|---|
| **Knowledge base** | Markdown files in `knowledge-base/` | Claude reads files directly (`Read` tool). V2: local embedding index. |
| **Datastore (tickets, people, etc.)** | JSON files in `databases/<collection>/`, validated against `_schema.json` | Claude reads / writes / edits the JSON files (`Read`, `Write`, `Edit`). |
| **Agents** | JSON config files in `agents/` | The "runtime" is Claude itself, in the OpenIT chat pane. It reads the agent's `instructions` field and operates per them. No separate runtime needed. |
| **Workflows** | JSON files in `workflows/` | V1: Claude reads the workflow file and executes the steps inline. V2: a tiny local workflow runner walks them. |
| **Filestore** | Files on disk under `filestore/` | File system operations, the way they always were. |

The thing that makes this *work* is that **Claude is the agent runtime.** When the user types a question into the OpenIT chat, Claude is the triage agent. It reads `agents/openit-triage-<orgId>.json` for instructions, follows them, writes a ticket file, searches the KB by reading markdown, replies. No gateway, no Pinkfish-side execution, no network calls beyond Claude's own tokens.

## What "push to cloud" means

A user-initiated upgrade gesture — one button or a `/connect-pinkfish` skill — that:

1. Authenticates the user with Pinkfish via the existing OAuth flow.
2. Mirrors the local state (datastores, KB, agents, workflows) up to a fresh or existing Pinkfish org. The engine we already built does this with conflict resolution baked in.
3. Switches the project to "cloud-synced" mode: the engine continues to run bidirectionally; further local edits push, further cloud edits pull.
4. Reversibly. User can disconnect and the local files stay; engine just stops syncing.

The user's first session is local. They get value immediately. The decision to pay happens later, when they hit a real reason to upgrade.

## What changes when you connect to cloud

These are the features that genuinely need server-side infrastructure. Local mode can't do them; cloud mode is where they turn on.

| Capability | Local mode | Cloud mode |
|---|---|---|
| **KB semantic search** | Claude reads markdown files (works for small KBs; degrades past ~hundreds of articles) | Pinkfish-hosted embeddings + `knowledge-base_ask` semantic query |
| **Channel ingest** | Admin types user questions into Claude chat manually | Slack / email / Teams / web form route into the triage agent |
| **Always-on agent** | Off when laptop is asleep / closed | Pinkfish runtime, 24/7 |
| **Multi-device / team** | Single-user, single-machine | Multiple admins share one helpdesk; mobile access |
| **Third-party connectors** | Not available — `gateway_invoke okta`, `gateway_invoke gcp`, etc. unreachable without Pinkfish auth | All 100+ Pinkfish-connected services available via the gateway |
| **Audit log / compliance** | Local git history (real but ad-hoc) | Pinkfish-side audit trail, retention policies, exports |
| **Templates / starter packs** | Bundled in the local install | Updated dynamically; team-wide template libraries |

This table IS the value-prop ladder. A user starts free → hits one of these limits → upgrades. Each row is a clear, defensible reason to pay.

## The architecture flip in one paragraph

Today, on first connect: OpenIT POSTs an agent to Pinkfish, creates default datastores on Pinkfish, asks Pinkfish for the KB collection, then pulls everything down to disk for editing. **The cloud is the source of truth.** In local-first: on first run, OpenIT scaffolds the project folder, writes a default agent JSON, schema files, and an empty KB locally. **Disk is the source of truth.** Pinkfish enters the picture only when the user opts in; from that point on, the existing bidirectional engine + conflict resolution flow takes over and keeps disk + cloud in sync.

The engine work we just shipped — bidirectional sync, conflict resolution, scenario matrix — is exactly the right primitive for this. We're not throwing it away. We're just changing *when* it engages: today it engages from connect-time onward; in local-first it engages from cloud-upgrade-time onward.

## What we keep from PRs #19–#22

The recent stack has good code that survives the flip:

- **PR #19** (perf optimization, UX polish, BugBot fixes) — all general. **Keep, ship.** Nothing to rework.
- **The banner infrastructure** from PR #21 — `EscalatedTicketBanner.tsx`, the subscribe pattern, the CSS. Reuse as-is.
- **The escalated-ticket detection** from PR #21 — `src/lib/ticketStatus.ts`. Reads local files, works fine in local-first; *more* relevant, even (it's how the local-first banner triggers).
- **The conflict-resolve loop** (in main as of PR #17) — relevant the moment a user opts into cloud sync. No change.
- **The vision doc** (`auto-dev/plans/2026-04-26-helpdesk-vision.md`) — still describes the right end state. Add a paragraph at the top noting the local-first framing.

## What gets superseded

The pieces that lean on Pinkfish-as-runtime need rewriting:

- **PR #20's triage agent bootstrap** — currently POSTs to Pinkfish. Rewrite: just write the agent JSON to `agents/openit-triage-<orgId>.json`. No HTTP call. Same idempotent pattern (skip if file exists).
- **PR #21's `answer-ticket` skill body** — currently tells Claude to *"use `gateway_invoke` to log the ticket / search KB."* Rewrite: *"create the ticket by `Write`-ing a JSON file at `databases/openit-tickets-<orgId>/row-<id>.json` matching `_schema.json`. Search the KB by listing `knowledge-base/` and reading the relevant files."*
- **PR #22's `capture-workflow` skill body** — same shape; rewrite the example to use file ops, with gateway calls only for the third-party-action steps within the workflow (those are Pro-tier features).
- **`scripts/openit-plugin/CLAUDE.md`** — currently leads with *"Use the Pinkfish Gateway."* Rewrite to lead with *"Read and edit the local files. Reach for the gateway only when you need a third-party connected system."* Same content, different priority.

The mechanical work for all four is **a few hours of prompt rewriting**. No engine changes.

## What's net-new

These are pieces local-first needs that we don't have today:

1. **A local KB-ask helper.** V1: nothing — Claude reads markdown files directly via `Read` tool. V2: a small embedding index built locally (sentence-transformers via Python, or a tiny native binary).

2. **A local intake mechanism.** V1: the admin types user questions into Claude chat themselves. Demonstrates the loop, no infrastructure. V1.5: a tiny local HTTP server on `localhost:<port>` serving a single-page web form; the form writes a ticket JSON; the fs-watcher fires; banner appears. V2 (Pro tier): Slack/email/Teams bridge from Pinkfish into the local triage flow.

3. **The "Connect to Pinkfish" upgrade flow.** A single button (or skill) that runs the OAuth, mirrors the current state up, and flips the project to bidirectional-sync mode.

4. **A toggle in the UI.** Cloud connection state needs to be visible — "local-only" badge by default, "synced to Pinkfish (org name)" when connected. Plus a path to disconnect.

## Phase plan

The PRs ship in a clean order, each one self-contained and useful on its own.

### Phase 1 — Reframe the existing skills + agent for local-first

- Rewrite `CLAUDE.md` so file ops are the default, gateway is the third-party-system layer.
- Rewrite the triage agent's instructions in `agentSync.ts` to use `Read`/`Write`/`Edit` for own-data ops. No gateway.
- Rewrite `answer-ticket.md` to prefer file ops.
- Rewrite `capture-workflow.md` likewise.
- Update bootstrap so the triage agent gets written to disk only — no POST to Pinkfish.

**Visible outcome:** install OpenIT, run on a fresh project, ask "VPN is broken" — Claude reads `knowledge-base/`, writes a ticket file under `databases/openit-tickets-<orgId>/`, replies. Zero network calls beyond Claude's own.

### Phase 2 — Default project scaffold

- On first run: create the project folder, write `_schema.json` files for the default collections (people, tickets), seed an empty KB (`knowledge-base/welcome.md`), write the triage agent JSON.
- All without authenticating to Pinkfish.
- Update the connect modal: split into "Run locally" (default) and "Connect to Pinkfish (optional)."

**Visible outcome:** the modal is no longer required. User skips it, lands in a working project.

### Phase 3 — Escalated-ticket banner (re-shipped, local-first)

- The detection helper (`ticketStatus.ts`) and banner component carry over verbatim from PR #21.
- The `answer-ticket` skill is the rewritten Phase 1 version (file ops, not gateway).
- Plus the small UI tweaks for "this is the local helpdesk" framing.

**Visible outcome:** edit a ticket file to `status: "open"`. Banner appears. Click "Solve with Claude" → Claude reads the ticket, drafts a reply, writes a KB article. End-to-end local.

### Phase 4 — Local KB-ask V2 (optional)

- For users with bigger KBs (~hundreds of articles), Claude grepping files starts to drag. Add a local embedding index — built once on KB write, cached.
- This is genuinely optional. V1 (Claude reads files) is good enough until it isn't.

### Phase 5 — Local intake (web form)

- A tiny Tauri-spawned HTTP server on `localhost:<port>`. Single-page form. POSTs write a ticket file directly. fs-watcher triggers the banner.
- Now the admin's coworkers can file tickets without OpenIT installed; admin still resolves them in OpenIT.

### Phase 6 — "Connect to Pinkfish" upgrade flow

- The button. Runs OAuth, mirrors local → cloud, flips to sync mode.
- Existing engine handles ongoing bidirectional sync from there.
- A clear messaging moment: *"Your local helpdesk is now backed up to Pinkfish. You can also enable: Slack ingest, always-on agent, multi-device, third-party integrations."*

### Phase 7+ — Cloud-only features

Channel ingest, always-on runtime, third-party integrations. These genuinely need cloud infrastructure; they're the Pro tier.

## What to do with PRs #20, #21, #22

**Close them.** Their *concepts* move forward in Phase 1 / Phase 3 / Phase 6 of this new plan, but the code as written assumes Pinkfish-as-runtime. Trying to mutate-in-place would be confusing both for review and for narrative.

PR #19 stays — its content is general improvement and lands cleanly on top of the local-first work.

The new stack starts on top of PR #19. Order: Phase 1 (the reframe) → Phase 2 (local-default scaffold) → Phase 3 (escalated banner) → Phase 6 (cloud upgrade button) → Phase 4 / Phase 5 / Phase 7 in whatever order priorities suggest.

## Risks and open questions

1. **Will users actually keep cloud disabled?** The pricing model breaks if everyone flips to cloud immediately. Watch carefully whether the local-only mode is genuinely useful for the first session(s); if users flip cloud on within minutes, the framing isn't differentiated.

2. **What's the absolute minimum cloud feature to drive upgrades?** My bet: channel ingest. Slack DM → triage agent → answer is the moment most IT admins say *"I want to pay for this."* If that's the wedge, the rest of the cloud features can lag.

3. **The "third-party integrations" tier is currently bundled with everything else.** If a user's only need is "OpenIT must reset Okta passwords," they have to pay for the whole cloud stack. Worth thinking about whether third-party gateway access could be its own tier — but probably not worth the pricing complexity in V1.

4. **Privacy messaging.** "Local-only by default" needs to be defensible. Audit the actual network calls OpenIT makes by default — plugin manifest fetch is the only one I'm aware of. Make that explicit in onboarding so users trust the framing.

5. **The Pinkfish-as-product question.** This shift makes Pinkfish the *upgrade*, not the *product*. Worth confirming the upstream business is comfortable with that positioning before committing publicly.

## Bottom line

The local-first flip is small in code and big in positioning. We've already built the engine that makes it work. What's left is mostly prompt rewriting + a "Connect to Pinkfish" button. Phases 1–3 are a few days of work. Phase 6 (the upgrade flow) is a few days more. Everything beyond that is the standard Pro-tier feature build-out.
