# Pane Layout Consistency — Implementation Plan

**Date:** 2026-04-30
**Repo:** `openit-app` (UI-only, no platform / firebase / web changes)
**Predecessor:** v5 foundation (75695db) — this plan finishes the migration that PR started.

---

## 1. Investigation — what's actually shifting, and why

### Symptom (from user)

- Switching **Overview ↔ Sync** in the left pane: the pane appears to resize.
- Switching **Getting Started ↔ Inbox** in the center pane: the middle pane appears to change width.

### Root cause: pane outer widths are stable; pane *inner content* is not

The three panes are sized in % via `react-resizable-panels` ([Shell.tsx:1014-1038](../../src/shell/Shell.tsx#L1014-L1038)). `PANE_DEFAULT = { left: 24, center: 40, right: 36 }` ([Shell.tsx:69-70](../../src/shell/Shell.tsx#L69-L70)). The PanelGroup never remounts on tab/page switches — only when `repo` changes ([App.tsx:925](../../src/App.tsx#L925)). **The card geometry does not change.**

What does change is the inner content's left edge and width, for three reasons:

**Cause A — every pane body is a bespoke wrapper.** Each tab/source.kind invents its own scroller and padding:

| Where | Wrapper | Padding | Defined |
|---|---|---|---|
| Left / Overview | `.left-pane-scroll` (overflow-y:auto, padding 0) → `.workbench` (padding 14/14/6) | 14px | [App.css:4167](../../src/App.css#L4167), [App.css:4172](../../src/App.css#L4172) |
| Left / Sync | `.sc-panel` (overflow-y:auto, no body padding) | rows pad themselves | [App.css:2284](../../src/App.css#L2284) |
| Left / Files | `.explorer` (overflow-y:auto) | none | [App.css:664](../../src/App.css#L664) |
| Center / Getting Started | `.viewer-md` (flex:1, overflow:auto, padding 18/28) | 28px L/R | [App.css:1935](../../src/App.css#L1935) |
| Center / Inbox | `.viewer-summary.viewer-conversations` (flex:1, overflow:auto, 16/20) → `.viewer-thread-list` (flex:1, overflow-y:auto, 16) | 16+20 outer + 16 inner, **double-scroll** | [App.css:3267](../../src/App.css#L3267), [App.css:1095](../../src/App.css#L1095) |
| Center / Datastore-table, agent, workflow, entity-folder, people, etc. | each has its own `.viewer-summary` / `.viewer-content` variant | varies | scattered across App.css |

Switching pages slides the content's left edge by 4–14px. That reads as "the pane shifted."

**Cause B — no scrollbar gutter is reserved.** Every scroller uses `overflow: auto` with no `scrollbar-gutter`. There is no global scrollbar styling apart from one tiny utility ([App.css:3945](../../src/App.css#L3945)). On macOS with overlay scrollbars this is invisible; on macOS with "Always show scrollbars," on Windows, and on Linux, the scrollbar takes ~12–15px and content jumps when it appears or disappears between pages.

**Cause C — Inbox has nested scroll containers.** `.viewer-summary` is `overflow:auto` AND its child `.viewer-thread-list` is also `overflow-y:auto`. Only one ever scrolls in practice, but the extra layer adds inconsistent geometry vs. other pages.

### Critical finding — the v5 fix already exists, unused

[src/ui/Pane.tsx](../../src/ui/Pane.tsx) exports `Pane`, `SectionBar`, `SectionBarSpacer`, and `PaneBody` primitives. `PaneBody` already declares `flex: 1 1 auto; min-height: 0; overflow: auto;` ([Pane.module.css:36-40](../../src/ui/Pane.module.css#L36-L40)).

Grep for adopters: nothing outside [src/ui/index.ts:33](../../src/ui/index.ts#L33) imports them. Commit 75695db landed the primitives but **never migrated the shell** to use them. The shell still uses inline `.left-pane` / `.viewer` / `.right-pane` classes with per-page body wrappers.

**This plan is that migration plus three small hardenings to make `PaneBody` actually fix the issue:** add scrollbar-gutter, add canonical body padding tokens, and forbid nesting another scroller inside it.

---

## 2. Proposed solution

### Approach

One canonical `PaneBody` primitive owns: scroll, scrollbar-gutter, outer padding. Every pane body in the shell renders through it. Per-page components keep their internal layout (cards, gaps, typography) but **delete their outer scroll/padding** — those move up to `PaneBody`.

This eliminates all three causes at once: A (bespoke wrappers → one primitive), B (one place to set `scrollbar-gutter`), C (no more nested scrollers, because `PaneBody` is *the* scroller).

### Design

**Tokens** — add to [src/styles/tokens.css](../../src/styles/tokens.css):

```css
--pane-body-pad-x: 16px;   /* canonical horizontal pad inside any pane body */
--pane-body-pad-y: 14px;   /* canonical vertical pad inside any pane body */
```

(One value per axis, shared across left / center / right. Markdown's wider 28px gutter goes — that was a markdown reading-width opinion, not a pane decision; any reading-width tweaks belong inside the markdown component, not the pane.)

**`PaneBody` primitive** ([src/ui/Pane.module.css](../../src/ui/Pane.module.css)) becomes:

```css
.body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  padding: var(--pane-body-pad-y) var(--pane-body-pad-x);
}
.body.flush { padding: 0; }   /* opt-out for components that want to manage their own padding (e.g. file lists where rows must hit edges) */
```

Add a `flush` prop to `PaneBody` for the opt-out. Used only where an internal toolbar / row needs full-bleed.

**Migration**

Every place currently rendering pane content with a custom scroller/padding gets one of two shapes:

```tsx
// Default: pane body owns padding + scroll
<PaneBody>
  <Workbench />          // delete .workbench's 14px outer padding
</PaneBody>

// Opt-out: full-bleed list / toolbar manages its own
<PaneBody flush>
  <FileExplorer />
</PaneBody>
```

The `.left-pane` / `.viewer` / `.right-pane` outer cards stay where they are (they're the rounded chrome — that part of v5 already works). What changes is the **body slot** inside each pane.

### Files to modify

| File | Change |
|---|---|
| `src/styles/tokens.css` | Add `--pane-body-pad-x`, `--pane-body-pad-y` tokens. |
| `src/ui/Pane.module.css` | Add `scrollbar-gutter: stable`, padding via tokens, `.flush` modifier. |
| `src/ui/Pane.tsx` | Add `flush?: boolean` prop on `PaneBody`. |
| `src/shell/Shell.tsx` | Replace the three `.left-tab-panel` bodies and the center `<Viewer>` slot's outer wrapper to use `PaneBody`. Drop `.left-pane-scroll`. |
| `src/shell/Viewer.tsx` | Replace per-source-kind body wrappers (`.viewer-md`, `.viewer-summary`, `.viewer-thread-list`, `.viewer-content`, `.viewer-conversations`, `.viewer-people`) with a single `<PaneBody>` around the source-specific render. Inline padding/overflow comes off these inner classes. Inbox loses its double-scroll. |
| `src/shell/SourceControl.tsx` | Drop `overflow-y:auto` and `height:100%` from `.sc-panel`; let `PaneBody` own scroll. |
| `src/shell/FileExplorer.tsx` (verify path) | Same: render inside `<PaneBody flush>`; strip own scroll/height. |
| `src/shell/Workbench.tsx` (verify path) | Drop outer padding from `.workbench`; `PaneBody` handles it. Keep internal `gap` and card styling. |
| `src/App.css` | Delete now-dead rules: `.left-pane-scroll`, `overflow-y:auto` on `.sc-panel` / `.explorer` / `.viewer-md` / `.viewer-summary` / `.viewer-thread-list` / `.viewer-content`, plus their own padding. **Surgical deletes only**, not a rewrite. |

Net change: ~one new primitive prop, ~6 component edits, ~80 lines of CSS deleted, ~10 added.

### Unit tests

| File | Test |
|---|---|
| `src/ui/Pane.test.tsx` (new) | `PaneBody` renders with default padding; `<PaneBody flush>` renders with no padding; both expose `scrollbar-gutter: stable` (read computed style via `getComputedStyle` in jsdom — if jsdom doesn't honor `scrollbar-gutter`, snapshot the className list instead). |
| `src/shell/Shell.test.tsx` | Existing tests should pass unchanged; if any assert on `.left-pane-scroll`, update them. |
| `src/shell/Viewer.test.tsx` (if exists) | Same — drop assertions on removed wrapper classes. |

No new behavioral tests needed: this is a refactor that preserves render output minus padding/scroll inconsistencies. Visual regression is covered by the manual scenarios.

### Manual scenarios

Click-through on a built dev binary (not just `vite dev` in browser) to confirm Tauri/macOS scrollbar behavior matches:

1. **Left pane: tab cycle.** Open repo with > screen-height of Overview content and > screen-height of Sync changes. Click Overview → Sync → Files → Overview. Card edges, content left-edge, and any visible scrollbar gutter must not visibly shift between tabs.
2. **Center pane: Getting Started ↔ Inbox.** Open Getting Started; click Inbox. Card edges and content left-edge must not shift. Inbox must scroll smoothly with one scrollbar (not two).
3. **Center pane: less-trafficked sources.** Open a datastore table, an agent detail, a workflow detail, an entity-folder (knowledge / attachments), a person record. Each must use the same body padding and the same scrollbar-gutter behavior. No "this page sits 8px further left than the last one."
4. **Resize the window narrow → wide.** Pane percentages stay at 24/40/36; nothing inside should reflow except by the natural % of the available width.
5. **macOS "Always show scrollbars" on.** System Settings → Appearance → Show scroll bars: Always. Repeat scenarios 1–3. Content left-edge must still not shift; the scrollbar gutter is reserved either way.
6. **Build a release binary** and confirm 1–5 there too — Tauri's webview can differ subtly from `vite dev`.

---

## 3. Implementation checklist

### Step 1 — Primitive hardening

- [ ] Add `--pane-body-pad-x`, `--pane-body-pad-y` to `src/styles/tokens.css`.
- [ ] Update `src/ui/Pane.module.css`: `scrollbar-gutter: stable`, padding via tokens, `.flush` modifier.
- [ ] Add `flush?: boolean` to `PaneBody` in `src/ui/Pane.tsx`.
- [ ] Unit test `PaneBody` (default vs flush).

### Step 2 — Shell migration (left pane bodies + center viewer slot)

- [ ] `Shell.tsx`: replace each `<div className="left-tab-panel">` body with `<PaneBody>` (or `<PaneBody flush>` for FileExplorer). Drop `.left-pane-scroll`.
- [ ] `Workbench.tsx`: remove outer `padding` from `.workbench`; keep internal `gap`.
- [ ] `SourceControl.tsx`: remove `height:100%` and `overflow-y:auto` from `.sc-panel`. Render under `<PaneBody>`.
- [ ] `FileExplorer.tsx`: render under `<PaneBody flush>`; strip own scroll/height.

### Step 3 — Viewer migration

- [ ] `Viewer.tsx`: wrap the body switch in a single `<PaneBody>` (use `flush` for kinds whose internal toolbar must reach pane edge — e.g. spreadsheet, image, datastore-table chrome).
- [ ] Strip `overflow:auto` + outer padding from `.viewer-md`, `.viewer-summary`, `.viewer-thread-list`, `.viewer-content`. Keep `.viewer-md` text styling (lists, code, headings).
- [ ] Collapse Inbox's nested-scroll: `.viewer-summary.viewer-conversations` becomes a content wrapper, not a scroller; `.viewer-thread-list` is just a flex column of cards.

### Step 4 — Dead-CSS sweep

- [ ] Delete now-unused rules in `App.css`: `.left-pane-scroll`, the `overflow:auto` declarations on the migrated containers, their outer padding declarations.
- [ ] `npm run biome:write` and `npm run code-check --workspace=@pinkfish/app` clean.

### Step 5 — Manual sign-off

- [ ] Walk scenarios 1–6 above on a dev build.
- [ ] Walk scenarios 1–6 above on a release build.

### Step 6 — Stop. Wait for human review before stage 03.

---

## Notes

- **Out of scope:** the right pane (chat) is not part of the symptom; its body is a single `<ChatPane>` that already manages its own internal scroll. Leave it. If the audit in Step 3 shows it has a similar wrapper inconsistency, surface it as a follow-up — don't bundle.
- **No new tickets / no `/web` mirror:** this change is openit-app-only and does not touch `scripts/openit-plugin/`.
- **Behavior preserved:** every page renders the same content as before; only the surrounding padding / scroller is consolidated.
- **The minimalist read:** the v5 PR shipped the primitive but stopped at the door. This plan walks it through.

---

## BugBot Review Log

### Iteration 1 (2026-04-30)

| # | Finding | Severity | Disposition | Commit / Reason |
|---|---------|----------|-------------|-----------------|
| 1 | Flush PaneBody leaks unused scrollbar gutter space | Medium | Fixed | `Re: Flush PaneBody leaks unused scrollbar gutter space` — `.flush` now also sets `overflow: hidden` and `scrollbar-gutter: auto`, since flush hands every body concern (scroll, padding, gutter) to the child. Reserving a gutter at the flush layer was painting an empty ~15px strip between content and the pane right border on classic-scrollbar systems. |
