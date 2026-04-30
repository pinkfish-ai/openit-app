# PIN-5829: Mark-as-resolved → /conversation-to-automation

**Ticket:** [PIN-5829](https://linear.app/pinkfish/issue/PIN-5829/openit-mark-as-resolved-conversation-to-automation-capture-solutions)
**Branch:** `ben/pin-5829-conversation-to-automation`
**Worktree:** `/Users/benrigby/Documents/GitHub/worktrees/pin-5829/openit-app`
**Date:** 2026-04-30

---

## Brief (locked, see Linear)

Capture every ticket resolution as one of three reusable artifacts so the next identical ticket costs less. The full brief lives in Linear; this doc is the implementation plan + working surface.

- **KB article** — agent reads, asker acts on directly. `knowledge-bases/default/`.
- **Skill** — admin-side, judgment-heavy markdown prompt. `filestores/skills/`.
- **Script** — admin-side, deterministic executable. `filestores/scripts/`.

Trigger paths: explicit "Mark as resolved" click + proactive Claude offer when 3+ steps & admin-only action observed.

---

## Phase 1 — Implementation plan

### Files to touch

| File | Change |
| --- | --- |
| `src/shell/Viewer.tsx` (or wherever the conversation reply composer lives) | Move "Mark as resolved" to left of textarea row. On click, in addition to existing status flip, dispatch `openit:resolve-and-capture` with `{ ticketId }` payload. |
| `src/App.tsx` | Listen for `openit:resolve-and-capture` and inject `/conversation-to-automation <ticketId>` into the active Claude session via `writeToActiveSession`. Mirror the existing `openit:start-cloud-onboarding` listener pattern. |
| `src/shell/Workbench.tsx::STATIONS` | Append `{ id: "skills", kind: "skills", rel: "filestores/skills", countMode: "files" }` and `{ id: "scripts", kind: "scripts", rel: "filestores/scripts", countMode: "files" }`. |
| `src/shell/entityIcons.tsx` | Add `"skills"` + `"scripts"` to `EntityKind` and `ENTITY_META` (icon SVGs + tones + labels). |
| `src/lib/filestoreSync.ts::getDefaultFilestores` | Append `openit-skills` + `openit-scripts`. |
| `scripts/openit-plugin/skills/conversation-to-automation.md` (new) | The skill itself. Search-first → decide KB / skill / script / combo → write artifact(s). Detailed prompt below. |
| `scripts/openit-plugin/CLAUDE.md` | Add proactive-offer rule (3+ steps + admin-only action + not-already-captured threshold; skill-vs-script picker; one-offer-per-session). |
| `scripts/openit-plugin/manifest.json` | Add `skills/conversation-to-automation.md`; bump version. |
| `src/lib/skillMirror.ts` (new, ~80 LOC) | One-way mirror logic: `filestores/skills/<name>.md` → `.claude/skills/<name>/SKILL.md`; `filestores/scripts/<name>.<ext>` → `.claude/scripts/<name>.<ext>`. Watcher gate, delete propagation, frontmatter generation. |
| Hook into `src/lib/filestoreSync.ts` push/pull paths and the `touched` callback to invoke the mirror after writes. |

### `/conversation-to-automation` skill prompt — outline

```
You are processing a just-resolved ticket. Your job: harvest reusable knowledge.

Inputs:
- $ARGUMENTS = ticketId
- Read databases/conversations/$ticketId/*.json (in order) for the conversation.
- Read databases/tickets/$ticketId.json for ticket metadata.

Search first:
1. List knowledge-bases/default/ — find any article matching the ticket subject or asker symptom.
2. List filestores/skills/ — find any skill matching the resolution workflow.
3. List filestores/scripts/ — find any script matching the resolution workflow.

Decide:
- KB article when the resolution is information the asker can act on directly (a setting, link, one-line instruction, known limitation).
- Skill when the resolution is an admin process with branches / judgment / per-context decisions.
- Script when the resolution is an admin process that's fully deterministic + automatable.
- Combo allowed if it spans audiences. Justify in the chat summary.
- If a matching artifact already exists, prefer UPDATE over CREATE.

Write:
- KB article: knowledge-bases/default/<slug>.md (markdown, asker-friendly).
- Skill: filestores/skills/<slug>.md (markdown with YAML frontmatter: name, description, requires_admin, triggers).
- Script: filestores/scripts/<slug>.<ext> (executable; .mjs preferred).

Surface a chat summary: which artifacts were created/updated, why each, and where to commit.
```

### Mirror logic — sketch

```ts
// src/lib/skillMirror.ts
const SKILLS_PREFIX = "filestores/skills/";
const SCRIPTS_PREFIX = "filestores/scripts/";

export async function mirrorAfterFilestoreWrite(repo: string, relPath: string): Promise<void> {
  if (relPath.startsWith(SKILLS_PREFIX)) {
    const name = basename(relPath, ".md");
    const filestoreContent = await fsRead(`${repo}/${relPath}`);
    const claudePath = `.claude/skills/${name}/SKILL.md`;
    // Filestore copy is expected to start with YAML frontmatter; pass through.
    // (If first line isn't `---`, parse first heading + paragraph and synthesize.)
    await entityWriteFile(repo, dirname(claudePath), basename(claudePath), filestoreContent);
  } else if (relPath.startsWith(SCRIPTS_PREFIX)) {
    const filename = basename(relPath);
    const filestoreContent = await fsRead(`${repo}/${relPath}`);
    await entityWriteFile(repo, ".claude/scripts", filename, filestoreContent);
  }
}

export async function mirrorAfterFilestoreDelete(repo: string, relPath: string): Promise<void> {
  if (relPath.startsWith(SKILLS_PREFIX)) {
    const name = basename(relPath, ".md");
    await fsDelete(`${repo}/.claude/skills/${name}`); // remove the directory
  } else if (relPath.startsWith(SCRIPTS_PREFIX)) {
    const filename = basename(relPath);
    await fsDelete(`${repo}/.claude/scripts/${filename}`);
  }
}
```

Hook into `filestoreSync.ts` after `entityWriteFile` for skills/scripts collections; after `entityDeleteFile` for the same. The gate (paths starting with `filestores/skills/` or `filestores/scripts/`) prevents the mirror from re-firing when its own write to `.claude/` lands.

### Manifest frontmatter — what `/conversation-to-automation` writes

Skill files (filestore copy) start with:

```
---
name: <slug>
description: <one-liner for slash-command discovery>
requires_admin: true
---

# <Title>

<body>
```

The `.claude/skills/<name>/SKILL.md` mirror is a literal copy — Claude Code's skill registry consumes the same frontmatter.

### Tests

| File | Test |
| --- | --- |
| `src/lib/skillMirror.test.ts` (new) | (a) write to `filestores/skills/foo.md` → mirror lands at `.claude/skills/foo/SKILL.md` with same content. (b) delete → mirror removed. (c) write to `.claude/skills/foo/SKILL.md` directly does NOT trigger filestore-side mirror (gate verified). (d) script mirror analogous. |
| `src/lib/filestoreSync.test.ts` | Defaults include `openit-skills` and `openit-scripts`. |
| `src/shell/Workbench.test.tsx` (if exists; otherwise add) | Two new tiles render with correct labels + counts. |

### Manual scenarios

1. **KB capture.** Open a ticket where the resolution is "click forgot-password upper-left of login page." Click Mark as resolved → `/conversation-to-automation` fires → KB article appears in `knowledge-bases/default/`.
2. **Skill capture.** Resolution is "depending on department, run X (sales) or Y (eng)." → Skill appears in `filestores/skills/`, mirrored to `.claude/skills/<name>/SKILL.md`.
3. **Script capture.** Resolution is "ran `jamf-bind --mac=X --ou=Y`." → Script in `filestores/scripts/<name>.mjs` + mirror.
4. **Update over create.** Re-resolve a ticket whose answer matches an existing KB. Should produce an update, not a duplicate.
5. **Proactive offer fires.** In Claude chat, walk through a 4-step deterministic provisioning. Claude offers script capture; yes → file lands.
6. **Proactive offer doesn't fire.** "How do I unzip a tar?" — no offer (1 step, no admin action).

---

## Phase 2 — Stage gates / risk notes

- **Mirror cycle.** Tested explicitly: writing the .claude copy must not re-trigger the mirror.
- **Frontmatter handling.** If `/conversation-to-automation` doesn't write valid frontmatter, the mirror falls back to synthesizing one from the first heading + paragraph. Document in skillMirror.ts.
- **Tile icon clash.** Confirm Skills + Scripts icons read distinctly against existing Knowledge / Tools / Files icons. Stage 02 picks final glyphs.
- **Cross-repo mirror at merge.** Same as PIN-5793 — copy `scripts/openit-plugin/{skills/conversation-to-automation.md, CLAUDE.md, manifest.json}` into `/web/packages/app/public/openit-plugin/` post-merge.

---

## Status log

- **2026-04-30** — Worktree + branch + plan doc created. Linear PIN-5829 moved to In Progress.
