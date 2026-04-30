---
name: conversation-to-automation
description: After a ticket is resolved, harvest the resolution into a reusable artifact — a KB article (agent auto-answers next time), a skill (admin-side workflow markdown), or a script (deterministic executable). Search existing artifacts first; prefer updates over duplicates. Invoked automatically when the admin clicks "Mark as resolved", or directly via `/conversation-to-automation <ticketId>`.
---

## When you're invoked

Two paths get you here:

1. **Admin clicked "Mark as resolved"** in the conversation viewer. The viewer pasted `/conversation-to-automation <ticketId>` into this session.
2. **Admin typed it directly** with a ticketId argument.

Either way, your job is the same: turn what just happened in this ticket into something that lowers the cost of the *next* identical ticket.

## What you write — the three artifact types

| Artifact | When to write it | Audience | Where it lands |
|---|---|---|---|
| **KB article** | Resolution is information the asker can act on directly — a setting, a link, a one-line instruction, a known limitation. | Triage agent → asker (auto-answer next time). | `knowledge-bases/default/<slug>.md` |
| **Skill** | Resolution is an admin process with **branches, judgment, or per-context decisions** that need a human or Claude to interpret. | Admin or Claude (with admin approval). | `filestores/skills/<slug>.md` (mirrored to `.claude/skills/<slug>/SKILL.md` for slash discovery). |
| **Script** | Resolution is an admin process that's **fully deterministic** — same inputs always produce same outputs, no mid-flow judgment. | Admin (or Claude with approval) invokes; runtime executes. | `filestores/scripts/<slug>.<ext>` (mirrored to `.claude/scripts/<slug>.<ext>`). |

Combos are allowed when the resolution legitimately spans audiences (asker-facing answer + admin-side script). Justify the combo in your final summary.

**Edge:** an admin process that's deterministic *today* but might branch *later* should be a script first; refactor to skill when the branching is real. Don't pre-emptively encode flexibility you don't yet need.

## Process

### 1. Read the resolved conversation

`$ARGUMENTS` is the `<ticketId>`.

- `Read databases/tickets/<ticketId>.json` — the ticket metadata (subject, asker, status — should be `resolved`).
- List `databases/conversations/<ticketId>/`, sort by `timestamp`, `Read` each turn in order. The full back-and-forth between asker, agent, and admin lives here.
- If the ticket has attachments, list `filestores/attachments/<ticketId>/` for context.

### 2. Search existing artifacts (before writing anything)

Run all three searches before deciding what to write:

- **KB articles** — list `knowledge-bases/default/`. If there's a `kb-search` script available (`.claude/scripts/kb-search.mjs`), use it with terms from the ticket subject + asker question; otherwise grep for keywords across the article bodies.
- **Skills** — list `filestores/skills/*.md`. Read the YAML frontmatter `description` of each to find related workflows.
- **Scripts** — list `filestores/scripts/*` and skim file headers (shebang, docstring, first few lines).

### 3. Decide

Pick the artifact type that fits the resolution. Default tie-breakers:

- If the asker can fix it themselves with the info in the resolution → **KB article**.
- If the admin had to make a judgment call mid-flow ("if this department, do X; else do Y") → **skill**.
- If the admin ran a CLI / dashboard sequence that always works the same way → **script**.

Then check whether an existing artifact already covers this. Prefer **update existing** over **create new** when:

- An existing KB article addresses the same asker symptom (extend / clarify it).
- An existing skill describes the same admin workflow (refine the steps).
- An existing script does the same job (improve / parameterize it).

If you're updating, read the existing file first and extend it rather than overwriting. If you're creating, give the new file a slug-cased filename based on the ticket subject (`vpn-reset.md`, `provision-okta-access.mjs`).

### 4. Write the artifact

#### KB article

```markdown
# <Asker-facing title>

<Plain-language explanation of the answer. Written for the asker, not the admin.>

## Steps

1. ...
2. ...

## When this applies

<Symptoms that should trigger this article during triage.>
```

Land at `knowledge-bases/default/<slug>.md`.

#### Skill

```markdown
---
name: <slug>
description: <one-liner for slash-command discovery — what does this skill do and when should it fire>
requires_admin: true
---

# <Title>

## When to use

<Symptoms / triggers — when should the admin (or Claude on their behalf) invoke this?>

## Steps

1. ...
2. ...

## Decision points

<For each branch the workflow takes, describe what to check and how to choose.>
```

Land at `filestores/skills/<slug>.md`. The mirror will copy it to `.claude/skills/<slug>/SKILL.md` automatically — don't write to `.claude/` directly (that copy is overwritten on every sync).

#### Script

Pick the language by what fits:

- `.mjs` (Node) — for anything calling HTTP APIs, parsing JSON, talking to cloud services.
- `.sh` — for OS-level work (file moves, permission flips, brew installs).
- `.py` — only if a specific library makes Python clearly easier than Node.

Start with a shebang or be invocable via the right interpreter. Land at `filestores/scripts/<slug>.<ext>`. The mirror copies it to `.claude/scripts/<slug>.<ext>`.

Always include a header comment block describing:
- What the script does.
- The inputs it expects (env vars, args, files it reads).
- Side effects it has (which systems it touches, what it writes).
- The ticket this was harvested from (`# Captured from PIN-<id> on <date>` if you know the IDs; otherwise just date).

### 5. Surface a summary in chat

Tell the admin:

- **What you wrote** — file path(s), update vs create.
- **Why** — one-line justification per artifact.
- **What to do next** — review the diff in the Sync tab; commit when ready.

Example summary:

> Captured the resolution as **two artifacts**:
>
> - Updated `knowledge-bases/default/vpn-password-reset.md` (added the upper-left forgot-password note; the article already covered the general flow).
> - Created `filestores/scripts/notify-asker-vpn-reset.mjs` (deterministic Slack DM the admin runs after the asker resets — the existing skill `notify-asker.md` was too generic).
>
> Review in the Sync tab. The script will mirror to `.claude/scripts/` on commit.

## Don'ts

- **Don't write directly to `.claude/`** — that copy is generated by the mirror from the filestore source. Direct edits are silently overwritten next sync.
- **Don't create duplicates** — search first. Updating an existing artifact is almost always better than a parallel new one.
- **Don't pad** — if the resolution is genuinely thin (one-line forgot-password), a five-paragraph KB article is worse than a five-line one.
- **Don't combo-greedily** — write KB+script only when the asker-side answer and admin-side workflow are both substantive. If 90% of the value is on one side, just write that one.
