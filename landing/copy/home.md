# Home page — draft copy

Source of truth for `landing/src/pages/index.astro` (and a proposed
palette swap for `landing/src/styles/global.css`). Edit here. When this
reads right, I'll port it back into the .astro and .css files and we
review in the rendered Astro page.

The spine of the story:

> **An IT helpdesk on your laptop. In Claude Code. Drop the bloated,
> expensive tools and do exactly what you want — with the full power of
> Claude Code.**

---

## Hero

**An IT helpdesk. On your laptop. In Claude Code.**

OpenIT pins a real Claude Code session to a project folder on your
machine and bundles in the helpdesk shape — tickets, knowledge, agents,
reports — all plain files Claude reads and edits in your repo. Sync to
Pinkfish when you want it in production.

**Buttons:**

- `Download for macOS — Beta · Apple Silicon + Intel`
- `View on GitHub`

---

## Why on your laptop, with Claude Code

Today's ITSM tools are bloated for a reason. They ship a workflow engine,
an admin console, a reporting UI, a forms builder, a chat bot, and a
mountain of integration plumbing — all priced to clear an enterprise
sales cycle.

Mid-market IT doesn't need any of that. It needs the **outcomes**:
tickets handled, knowledge captured, access provisioned, reports written,
problems prevented. Claude Code already produces all of those when it
has the right files and the right tools — that's its day job. OpenIT
bundles the files and the tools, pins them to a folder on your machine,
and gets out of the way.

---

## The full power of Claude Code

This isn't a stripped-down agent or a Claude-shaped chat bubble. It's
the real Claude Code — every skill, every MCP, every model setting you'd
get in a terminal — pinned to a project folder you control.

- **Investigate across every system.** Tail the AD logs, query Okta,
  pivot to Jira, draft a remediation plan — one conversation, every
  system. Claude Code is your IT command line.
- **Author any report you want.** No fixed dashboards. Describe the
  report; Claude reads the audit log and writes it as a markdown file.
- **Extend the integration yourself.** When the catalog is missing
  something, Claude writes the connector in your repo. You ship it the
  same day.
- **Capture the answer once.** Every escalated ticket leaves a KB article
  behind. The same question gets auto-answered next time.

---

## What's in the project

A clean directory of plain Markdown and JSON. No proprietary database,
no clicky admin UI, no paid sandbox.

- `databases/` — tickets, people, anything else as structured rows.
- `knowledge-bases/` — markdown KB articles. The "answer once" target.
- `agents/` — agent configs (triage, onboarding, audit).
- `filestores/` — uploaded attachments, runbooks, library files.
- `reports/` — generated markdown reports, newest-first.

Open the folder in any editor. Everything is readable, diffable, and
yours.

---

## Sync when you want production

Connect to Pinkfish and the desktop app syncs your repo with your cloud
workspace bidirectionally. Local edits push on save. Cloud changes pull
on connect. Multi-device, channel webhooks, public chat URLs — all light
up the moment cloud is connected.

You don't have to. Local-only mode is a real helpdesk: a chat-intake URL
askers can use right now, a Claude pane for admin work, the answer-once
loop running on your laptop. Cloud is the deploy target, not the
dependency.

---

## Why files in git

ITSM as code, in git. Diffs you can read. PRs you can review. Branches
for staging vs prod. Rollback by `git revert`. Edit alongside Claude in
any editor. Hand the repo to your terminal-native engineers and they're
productive immediately — every file OpenIT writes is identical to what
plain Claude Code would write. If you ever leave OpenIT, you take your
config with you.

---

## Status

Public beta. macOS only (Apple Silicon + Intel), signed and notarized —
no first-launch warning. Linux and Windows builds follow.

---

## Proposed palette swap (for `landing/src/styles/global.css`)

Right now the landing is dark cream-on-charcoal with a hot-pink accent.
The desktop app is the opposite: warm cream background with a terracotta
accent. Aligning them makes the landing feel like the app's home, not a
separate marketing site.

```css
:root {
  /* old (current) */
  --bg: #0b0b0d;
  --surface: #14141a;
  --surface-2: #1c1c25;
  --border: rgba(255, 255, 255, 0.08);
  --text: #ececf1;
  --text-dim: #a8a8b3;
  --accent: #ff5fa8;
  --accent-hover: #ff7ab9;

  /* new — pulled from src/App.css in the desktop app */
  --bg: #fbf7ec;            /* warm cream */
  --surface: #ffffff;       /* card surface */
  --surface-2: #f5edd8;     /* secondary card / soft cream */
  --border: #e7decb;        /* soft tan rule */
  --text: #25201a;          /* deep brown-black */
  --text-dim: #67604f;      /* muted brown */
  --accent: #c75a2c;        /* terracotta */
  --accent-hover: #ad4a22;  /* terracotta pressed */
}
```

A few small consequences to spot-check after the swap:

- `.btn` still has white text on the terracotta — keep it; contrast is
  fine.
- `.btn.secondary` is `--surface-2` (soft cream) on cream `--bg` — may
  need a faint border to pop. One line: `border: 1px solid var(--border);`
- The header / footer rules become very subtle on cream. That's
  intentional — the app uses the same low-contrast chrome.
- `<code>` blocks in `.callout` use `--surface-2` — peach-cream on cream
  reads OK; let's see if we want a tint of accent on the inline code
  background.

---

## Notes / open questions

- **Hero**. Current pick is the three-beat fragment:
  *"An IT helpdesk. On your laptop. In Claude Code."* Reads as one
  rhythmic line, ~9 words, each beat carrying weight (what / where /
  engine). Other contenders if we want a single sentence instead:
  - "An IT helpdesk that runs in Claude Code."
  - "Your IT helpdesk in Claude Code."
  - "Run your IT helpdesk in Claude Code."
- **The pain framing**. "Bloated, expensive" is honest but mild. Worth
  going harder ("the $50K/year ITSM stack")? Risks sounding tabloid;
  reads stronger to a CIO than to an IT admin.
- **"Full power of Claude Code"** section. Currently 4 bullets. Could
  collapse to a single paragraph if it slows the page down — but I think
  this is the differentiator and deserves the room.
- **Mid-market framing**. Implicit in "Why local." Worth a dedicated "Who
  it's for" section, or does the rest of the page make it obvious?
- **No mention of "plain English"** — per your direction. If you want to
  bring it back as a secondary phrase ("describe what you want") I can
  fold it into the Claude Code section.
