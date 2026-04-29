# Stage 01 — Brief

Enrich a sparse Linear ticket through conversation with the engineer. Output: a Linear ticket with **Problem**, **Desired Outcome**, **Scope**, and **Success Criteria**.

Read the codebase as needed to understand current behavior and verify facts. **Do not propose implementation solutions yet** — that's stage 02.

---

## Process

### 1. Read the ticket

Use the Linear ticket as the starting point for your conversation. If the engineer pointed you at an existing ticket, fetch it; if not, ask which ticket to work against (or whether to create a new one).

### 2. Have a conversation

Explore the problem with the engineer. Keep questions short. **Batch all clarifying questions into a single message** to minimize back-and-forth — don't trickle one at a time.

The five questions to anchor the conversation:

- What's the objective?
- What does the user experience today?
- What should they experience instead?
- What's in scope? What's out?
- How would we know this is done?

Read the codebase to understand how things work, verify what the engineer tells you, and fill gaps in your understanding. The relevant repos:

- `openit-app` (this repo) — the Tauri shell, sync engines, fetch adapter, plugin dev source
- `/web` — plugin production home, FE pattern reference
- `/platform` — MCPs and service endpoints
- `/firebase-helpers` — resource API contracts (`skills*.pinkfish.ai`)
- `/pinkfish-connections` — connections proxy (`proxy*.pinkfish.ai`)

See `auto-dev/00-autodev-overview.md` for the "which repo answers which question" cheatsheet.

Use the codebase to explore *what* the problem might be and how we might *eventually* solve it — but don't propose solutions yet. Still in problem-understanding phase.

### 3. Update the ticket

Once you and the engineer agree on the problem and scope, update the Linear ticket body with these four sections:

**Problem** — What's broken or missing, from the user's perspective.

**Desired Outcome** — What the world looks like when this is solved.

**Scope** — What's in, what's out. Be explicit about both.

**Success Criteria** — Observable, testable outcomes:

```markdown
- [ ] When [condition], [expected behavior]
- [ ] [Existing behavior] is not regressed
```

**Metadata:**

- Team: Pinkfish
- Priority + labels as appropriate (`Bug`, `Feature`, `Improvement`)
- Predecessor: link to the prior ticket if this builds on previously-merged work

If the problem should be split into multiple tickets, create them. Each must stand on its own.

### 4. Confirm with the engineer

Present the updated ticket. Iterate until they approve it.

---

## Phase transition checklist (before moving to stage 02)

- [ ] Linear ticket has Problem / Desired Outcome / Scope / Success Criteria filled in
- [ ] Engineer has approved the brief
- [ ] If scope was narrowed, deferred work is captured as a separate Linear ticket
- [ ] Predecessor / related tickets linked

The brief is the contract. Stage 02 (implementation plan) builds on it.
