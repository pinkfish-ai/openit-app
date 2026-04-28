# OpenIT — UI Creative Directions

A first exploration of how OpenIT could look and feel. Branch: `ui-exploration-2026-04-27`.

The brief: OpenIT is the *Kickstarter* for IT at SMBs with no real ITSM today. Desktop-first, local-first, AI-first, with a cloud upsell. The user is an IT admin — technical-ish but not a developer. The current shell is a VS Code clone with Claude on the right; it works, but it reads as **a tool an engineer built for engineers**, not a product an admin opens with a smile.

This doc is a vibe-check, not a plan. Four directions, each a distinct personality, plus a list of cross-cutting wins that apply regardless of which we pick.

---

## What's already working

- The **warm cream palette** (`#faf9f6` / `#f4f1eb` with the burnt-orange `#d96e3e` accent) is genuinely uncommon in this category. Every other ITSM tool is either cobalt-blue corporate (ServiceNow, Jira) or stark-white tech-bro (Linear, Notion). Keeping a recognizable palette is half the brand — don't throw it out.
- The **pill metaphor** for status (Intake URL, Slack) is good. It makes "the server is running at this URL" feel approachable. Generalize it.
- The **3-pane layout** is the right shape — explorer / canvas / agent — even if the execution is rigid.
- **Local-first as a story** is genuinely differentiating. The UI should *show* the user that everything they see is a real file on their disk.

## What's flat

1. **Visual hierarchy is uniform.** Header, banners, panes, tabs, file tree — all roughly 11–13px, all roughly the same weight. Nothing pulls the eye. The product has no display type, no rhythm, no "hero" surface.
2. **It feels like a code editor pretending to be ITSM.** The left pane is a raw file tree (`databases/`, `knowledge-bases/`, `agents/`). An admin shouldn't have to think in folders to triage a ticket.
3. **The viewer is overloaded.** Tickets, conversations, KB articles, JSON rows, agent traces, diffs, sync output, edit forms — eight render modes, one rectangle, one tiny tabs row. Each entity type deserves a polished surface.
4. **Status surfaces are fragmented.** Three banner stripes (conflict / agent activity / escalated) stack at the top of the shell. Three pills float in the header. Plus a left-pane badge, plus a sync tab. There's no single "what's happening right now."
5. **The chat pane is a black-box terminal.** xterm + Claude Code. To a non-developer admin, this looks like Linux. The most important surface in the app — the AI — has no UI.
6. **Onboarding is a checklist.** Functional, but it doesn't sell the product or set a tone.
7. **No motion, no empty states.** Switching panes, opening a ticket, agent activity — all snap instantly with zero choreography. Empty viewer says nothing.
8. **Tagline + title is a string, not a wordmark.** `OpenIT — get IT done` deserves to be a real lockup.
9. **One accent color is doing five jobs.** The same orange means "active tab," "primary button," "conflict outline," "sync state," "drag target." Statuses need their own palette.
10. **Skill Canvas vs Viewer is a hard swap** — when a canvas is active, the viewer is *gone*. Should be a side surface or a modal, not a takeover.

---

## Direction A — *Studio*: the IT admin as craftsperson

> Lean into the warm palette. Add depth, paper, and weight. Linear meets Things 3 meets a notebook.

**Mood**: a leather-bound desk planner. Soft. Calm. "Open the app, breathe out."

**Palette** — extend the existing one:
```
--paper:        #faf6ec   (warm cream, primary canvas)
--paper-card:   #ffffff   (white-on-cream cards, lifted)
--paper-soft:   #efe8d6   (recessed wells)
--ink:          #2a2620   (text, near-black warm)
--ink-muted:    #6b6357
--ink-faint:    #a59d8e
--accent:       #c75a2c   (deeper, more saturated than current)
--accent-soft:  #f7e1cf
--sage:         #6f8f6a   (success/connected)
--ochre:        #c79a2e   (in-progress/warning)
--clay:         #b34a3a   (error/conflict)
--ink-link:     #4a5cb8
```

**Typography** — actual pairing, not just a system stack:
- Display: **Söhne / Geist / GT America** (or fallback to system) — for the wordmark, section headers, ticket subjects.
- Body: keep system stack but step up to 14px base.
- Mono: **JetBrains Mono** or **Berkeley Mono** for the chat shell, file paths, and status pills. Replaces Menlo everywhere.
- Real type scale: 11 / 13 / 15 / 18 / 24 / 32 — not "11, 12, 13."

**Signature moves**:
- **Cards float**, with `0 1px 0 rgba(0,0,0,.04), 0 4px 16px -8px rgba(60,40,20,.10)`. Tickets, KB articles, agents — all cards on cream.
- The left pane stops being a file tree. It becomes a **workbench** with named, hand-curated sections: *Intake*, *People*, *Knowledge*, *Workflows*, *Agents*, *Sync*. Each with its own icon and count badge. The raw file tree lives behind a "Show files" toggle for power users.
- The middle pane gets a **breadcrumb ribbon**: `Intake › Open tickets › #42 — Laptop won't boot`. Clickable, persistent.
- The chat pane gets a **shell** around xterm: a small "Claude" header strip with a connection dot, an avatar, and a "thinking…" pulse when a turn is in flight. xterm becomes the inner content, not the whole pane.
- The header becomes a **top bar with a real wordmark**: `OpenIT` in Söhne, `get IT done` in italic ochre as a tagline below. App icon on the left.
- Banners collapse into **one status rail** at the bottom of the shell: conflict count, agent activity, escalated tickets, sync state, intake URL — all chips, all click-through.
- Onboarding becomes a **single illustrated card** with three steps and a big "Let's get started." Not a numbered list.

**Risk**: easy to drift into "another Linear clone." Saved by the cream palette and the IT-specific entity views.

---

## Direction B — *Cockpit*: mission control for IT

> Information-dense, dark, alive. Datadog × Grafana × early-Vercel × the inside of a 90s thinkpiece on cyberpunk.

**Mood**: you sit down at this and feel *operational*. Tickets are coming in, agents are working, syncs are flowing — and you can see all of it at once.

**Palette** — full pivot, dark mode primary:
```
--ink:          #0c0e12   (canvas)
--surface:      #14181f   (panes)
--surface-soft: #1c2230   (cards)
--border:       #262d3b
--text:         #e6e8ec
--text-muted:   #8a93a4
--text-faint:   #5a6275
--accent-cyan:  #4cd0e1   (primary)
--accent-amber: #f6b94c   (in-flight)
--accent-rose:  #ff5f87   (alert)
--accent-lime:  #a8e060   (ok)
```

**Signature moves**:
- A **live stats top-bar** replaces the static title row: open tickets · response time (24h avg) · agents running · sync state · listener health. Numbers tick. Sparklines.
- Each pane has a **status LED** in its header — a tiny dot that breathes when the pane is doing something async (sync running, agent composing, watcher firing).
- **Cmd-K command palette** is the front door. Default keystroke. "Open ticket #...", "Run /reports weekly-digest", "Connect Slack", "Pull from cloud" — everything reachable in two keystrokes.
- The chat pane becomes a **live agent trace**: the xterm output is one tab, but the default tab is a structured timeline of agent thoughts → tool calls → tool results, rendered as cards. (You already write a trace file per turn; surface it visually.)
- **Banners die.** Replaced by a single status rail at the bottom — chip per concern, color-coded LED, click to expand.
- File explorer becomes an **entity rail** like VS Code's activity bar — vertical icon column on the far left (Tickets, KB, People, Agents, Workflows, Files). Each opens a panel. Raw file tree is one of the panels, not the default.
- Type: tighter mono everywhere except the agent timeline, which uses a sans body for readability. Headers in something like **Inter Display** at semibold.
- Motion: **state transitions**. New ticket arriving slides in at the top. Agent finishing a turn fades a "completed" toast. Sync running pulses the LED.

**Risk**: dark + neon can read as "for engineers, not admins." Mitigated by the timeline view (which is more readable than a terminal) and a light variant.

---

## Direction C — *Concierge*: soft, conversational, magazine-like

> The chat is the front door. Everything else is a side surface. The app is *talking* with the admin, not waiting for them to navigate.

**Mood**: Notion meets Stripe meets a really nice email client. Reads like a publication. The admin types, things happen.

**Palette** — soft pastels on cream:
```
--paper:        #fbf8f1
--paper-card:   #ffffff
--blush:        #f4d8d4   (accent surfaces)
--sage:         #d8e6d2
--ochre:        #f0d9a8
--ink:          #2c2722
--ink-muted:    #6e6863
--ink-link:     #5b6cd8
```

**Signature moves**:
- The **chat is center stage**, full-bleed in the middle of the screen, with a giant "What can I help with?" input on first open. Not a terminal — a real composer with attachments, slash commands as inline pills, drafts.
- The viewer becomes a **right-side drawer** that slides in when context is needed: clicking a ticket reference in chat opens it on the right. Closing it returns full attention to the chat.
- Tickets render as **actual readable threads** — bubbles, avatars, timestamps, asker name in display type, status chip, reply composer at the bottom. (The conversation-thread view almost gets there today; this finishes the job.)
- KB articles render as **prose**: serif body font (Source Serif / Charter), wide line-height, pull-quotes for callouts. Reading a KB article should feel like reading.
- The **left rail is collapsed by default** — a thin column of entity icons, expands on hover. The admin doesn't need a file tree visible at rest.
- Onboarding is a **conversation**: "Hi, I'm OpenIT. Let's set you up. First — is Claude installed? …" Each step feels like a chat turn rather than a form.
- Status pills consolidate into **one "everything's good" chip** in the header that expands on click into a status sheet.

**Risk**: power users (real IT admins who *want* the file tree) may feel hand-held. Mitigate with a "switch to advanced layout" toggle.

---

## Direction D — *Tooling*: the prettiest VS Code clone in the world

> Don't run from the IDE metaphor — *win* it. If admins are going to live in a VS-Code-shaped thing, make this the most polished one they've ever used.

**Mood**: Zed × Warp × Raycast. Hyper-tactile, keyboard-first, every detail considered.

**Palette**: dual-mode (cream light + warm dark). Same hue family across both — never lose the OpenIT identity.

**Signature moves**:
- **Activity bar** on the far left (vertical icon column, VS Code style). Tickets, KB, People, Agents, Workflows, Files, Sync, Settings — each opens a side panel.
- **Breadcrumb header** above the viewer, always present: `local › databases › conversations › #42`. Clickable segments.
- **Bottom status bar**: project name · branch · uncommitted count · sync state · intake URL · slack listener health · cloud connection. Replaces every banner currently stacked at the top.
- **Cmd-K** universal command palette. **Cmd-P** entity finder ("find a ticket / KB article / agent by name"). **Cmd-Shift-P** Claude commands.
- **Inline diff gutters** in the file viewer so the admin can see what's changed since last sync without opening the Sync tab.
- **Rich entity icons** in the file tree — not VS Code's generic-document icon but custom: ticket envelope, KB book, agent face, workflow arrow.
- **Hover cards**: hover a ticket reference anywhere in the app, get a popover with subject + asker + status. Hover an agent name, see what it does.
- The chat pane gets a **proper shell** (header strip, message-style stream above the xterm input). The xterm becomes the input/output region only.
- **Skill Canvas becomes a side panel**, not a viewer takeover — opens on the right of the viewer, leaves the viewer visible.
- Theme: **dark mode** as a real first-class variant, not just an inversion.

**Risk**: most "evolutionary" of the four, least visually distinct. Wins on craft, not on imagination.

---

## Direction E — *Brutalist OS* (the wildcard)

> Half-joking, half-serious. What if we lean into the terminal and make it the aesthetic?

**Mood**: monochrome, high-contrast, terminal-as-feature. Vercel × early-Linear × actual `vi`. One electric accent (Pantone-something orange or acid green). Dot grid background. ASCII flourishes.

Entity names rendered in chunky display type (**56px Söhne Mono**). Status flags in `[BRACKETS]`. Page transitions that *type out*. Loading states that show actual ASCII spinners. The skill canvas shows a "diagram view" rendered in box-drawing characters that the user can copy-paste.

Probably too much for a real product but *some pieces* (typography boldness, dot grid, the ASCII flair) could pull a more conservative direction toward something memorable.

---

## Cross-cutting wins (do regardless)

These apply under any direction. Could be a "polish pass" sprint that's mostly orthogonal to the bigger creative bet.

1. **One real wordmark + app icon.** Replace the inline `OpenIT — get IT done` with a designed lockup and a Tauri-bundled icon. (Currently no icon set in `src-tauri/icons/`? — quick check needed.)
2. **A status bar at the bottom of the shell.** Move the conflict / agent-activity / escalated banners into chips. Free up vertical space and stop the stacked-banner shake when multiple fire at once.
3. **Cmd-K command palette.** A small surface that lists every action: open entity, run skill, jump to project section, connect/manage Slack, push, pull. Reachable from anywhere, no mouse.
4. **Per-entity viewers, not "viewer with tabs."** Tickets, KB articles, agents, workflows, datastores, filestores — each with its own surface, its own header pattern, its own empty state. Stop overloading one rectangle.
5. **A real chat shell** wrapping xterm. Header with a Claude badge + status dot. "Thinking…" indicator when a turn is mid-flight. Slash-command auto-complete inline above the input.
6. **A status-color system.** Three families: success (sage/lime), in-progress (ochre/amber), error (clay/rose). Used everywhere — pills, banners, badges, ticket statuses, sync chips. Stops the orange accent from doing five jobs.
7. **Empty states with personality.** Empty viewer says something. Empty tickets list says "Nothing in your queue. Nice." Empty KB says "Drop a doc in or ask Claude to summarize one." Each is a tiny opportunity to set tone.
8. **Skeleton loaders.** Right now, async loads show nothing until the data lands. Skeletons would make slow paths (cloud relaunch bootstrap, plugin sync) feel intentional instead of frozen.
9. **Subtle motion.** 200ms ease-out on pane resizes, banner slide-ins, modal opens. Nothing flashy — just enough that the app feels alive.
10. **Theme support (dark mode).** Even Direction A should ship a dark variant. Admins who work late want it.
11. **Onboarding cinematic-ish.** A first-launch sequence with a real welcome, not a step list. Doesn't need to be 30 seconds — 5 seconds of "here's what OpenIT is, here's the one thing you need to do" is enough.
12. **Stop showing the absolute repo path.** Anywhere `~/OpenIT/local` shows up, replace with the project name + a small "(reveal in Finder)" affordance.

---

## Recommended next step

Pick **one direction** and prototype the **shell + one entity viewer** in this branch. Suggested cut:

- **Direction A (Studio)** if we want to deepen what's already there. Lowest risk, highest "feels like the same product, just better."
- **Direction B (Cockpit)** if we want a bold reset and lean into the AI/automation story.
- **Direction C (Concierge)** if we believe non-technical admins are the wedge and chat is the front door.
- **Direction D (Tooling)** if we believe the IT admin loves IDEs and we should just be the best one.

My personal lean: **A with a sprinkle of B's command palette and live agent trace**. Keeps the warmth, adds the operational confidence, doesn't alienate the non-developer admin. Direction C is the most ambitious bet — would change the product, not just the skin.

Once we pick, the prototype path is roughly: new `src/theme/` with tokens → swap `App.css` variables → rework `Shell.tsx` layout (status bar, no banner stack) → custom chat shell wrapping xterm → one entity viewer (proposed: ticket thread, since it's the highest-value surface). One day of work for a prototype on this branch.

---

*Branch: `ui-exploration-2026-04-27`. Nothing in this doc has been implemented — it's a vibe-check before we touch real CSS.*
