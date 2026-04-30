# Design System v5 — Foundation + Shell Migration

**Branch**: `design-system-v5`
**Worktree**: `/Users/sankalpgunturi/Repositories/openit-app-v5`
**Spec**: `auto-dev/design-explorations/2026-04-29-shell-chrome/v5/index.html`
**Audit basis**: ~542 CSS classes, 20+ button variants, 16 distinct radii, 5 banner/toast components, off-palette purple, wrong-color accent fallbacks. See conversation transcript for the full audit.

## Problem

The current UI has six structural issues, all visible in the running app:

1. **Misaligned chrome** — header is full-bleed; panes are inset 14px; status bar is inset on sides but flush at the bottom. Cards visually "chopped" at the bottom edge.
2. **Inconsistent baselines** — left-tabs (37px), viewer-head (46px), chat-head (50px) all use different heights and different border treatments. Horizontal rules don't line up.
3. **`position: fixed` escalated banner** ([App.css:425](src/App.css#L425)) clips OVER the chat pane's rounded top-right corner.
4. **Duplicate Toasts** — [src/Toast.tsx](src/Toast.tsx) (provider, 3000ms) and [src/shell/Toast.tsx](src/shell/Toast.tsx) (hook+view, 2500ms) implement the same idea differently.
5. **20+ button classes** for ~5 actual roles. `.icon-btn` redefined three times. Off-palette purple in [SkillActionDock.css:20](src/shell/SkillActionDock.css#L20).
6. **No spacing/type/weight scale** — odd numbers (5, 7, 9, 11, 17px) scattered everywhere.

## Desired outcome (this PR)

A foundation that the rest of the codebase can migrate onto incrementally. After this PR:

- New design tokens are imported and live alongside the old ones (additive, non-breaking).
- A new `src/ui/` directory exports `<Button>`, `<Chip>`, `<Badge>`, `<Banner>`, `<Toast>`, `<Input>`, `<Field>`, `<Modal>`, `<SectionBar>`, `<Pane>`, `<Wordmark>` primitives.
- The Shell, App header, StatusBar, and EscalatedTicketBanner are migrated to use the new primitives — the user can run the app and see the v5 Quieter B layout (equal gutters, transparent rails, banner re-parented inside the chat pane).
- Toasts consolidated to one implementation. The shell/Toast.tsx is deleted; viewer is updated to use the global `useToast`.
- `npm run code-check` passes.

This is **Phase 1 of N**. FileExplorer, Viewer, ChatPane, ConflictBanner, AgentActivityBanner, SourceControl, Onboarding, OAuth modal, command palette, and ToolsPanel migrations come in subsequent PRs and can each delete their old classes.

## Scope (out of)

- Subsequent surfaces (FileExplorer / Viewer body / ChatPane internals / OAuth / cmdk / Onboarding / SourceControl / RowEditForm)
- Deleting old App.css classes — old classes stay valid this PR; only delete classes whose only consumer is migrated in this PR (StatusBar's `.status-chip*`, EscalatedTicketBanner's `.escalated-ticket-banner*`, both Toast CSS files)
- Mobile / responsive (the app is desktop only)

## Files to modify

| Action | File | What |
|---|---|---|
| **add** | `src/styles/tokens.css` | New design-system tokens (color, type scale, spacing, radius, shadow, motion) |
| **add** | `src/ui/Button.tsx` + `Button.module.css` | One Button: primary / secondary / ghost / link / destructive · sm / md / lg · icon modifier |
| **add** | `src/ui/Chip.tsx` + `Chip.module.css` | One Chip: neutral / strong / info / success / warn / critical |
| **add** | `src/ui/Badge.tsx` | Count indicator, mono numerals |
| **add** | `src/ui/Banner.tsx` + `Banner.module.css` | Inline notification (never `position: fixed`); 4 variants |
| **add** | `src/ui/Toast.tsx` + `Toast.module.css` | Single floating notification (rebuild of `src/Toast.tsx` using new chrome) |
| **add** | `src/ui/Input.tsx`, `Field.tsx` | One input + label + help/error wrapper |
| **add** | `src/ui/Modal.tsx` + `Modal.module.css` | Single modal panel (used by future cmdk/oauth/onboard migrations — exposed but not consumed this PR) |
| **add** | `src/ui/SectionBar.tsx` + `Pane.tsx` + their CSS | 44px-locked rail + pane card chrome |
| **add** | `src/ui/Wordmark.tsx` | Wordmark with italic Fraunces "I" + serif tagline |
| **add** | `src/ui/index.ts` | Re-export all primitives |
| **modify** | `src/main.tsx` | Import `./styles/tokens.css`. Swap `ToastProvider` import to `./ui` (same API) |
| **modify** | `src/App.tsx` | Replace header markup with `<Wordmark>` + `<Button>` primitives. Remove `.app-header`/`.icon-btn`/`.header-cmdk-hint` markup |
| **modify** | `src/shell/Shell.tsx` | (a) Remove the `<EscalatedTicketBanner />` from the top of the shell. (b) Pass `repo` and `fsTick` and `onOpenPath` down to the right-pane container so the banner can render inside the chat pane. (c) Update the shell layout to use the new equal-gutter / transparent-rail wrapper from `src/ui/Pane`. (d) Wrap each pane in `<Pane>` + `<SectionBar>` |
| **modify** | `src/shell/StatusBar.tsx` | Replace `.status-chip*` + `.status-bar*` markup with `<Chip>` primitives. Status rail becomes transparent (Quieter B). |
| **modify** | `src/shell/EscalatedTicketBanner.tsx` | Render as `<Banner variant="success">` (sage). Remove `position: fixed` styling. |
| **modify** | `src/shell/Viewer.tsx` | Replace `useToast`/`ToastView` import from `./Toast` with `../Toast` (global). Drop `ToastView` from JSX (global Toast renders itself). |
| **delete** | `src/shell/Toast.tsx` | Folded into `src/ui/Toast.tsx` |
| **delete** | `src/Toast.css` | Replaced by `src/ui/Toast.module.css` |
| **modify** | `src/Toast.tsx` | Re-export from `src/ui/Toast` to preserve the existing `ToastProvider` / `useToast` API |
| **modify** | `src/App.css` | Delete only the migrated classes: `.app-header`, `.app-header-actions`, `.app-pane`, `.shell-loading`, `.status-bar`, `.status-chip*`, `.escalated-ticket-banner*`, `.toast-notice`, `.openit-toast`. **Keep** all other classes (FileExplorer, Viewer, ChatPane, etc.) — those migrate in later PRs. Add `@import "./styles/tokens.css";` at the top. |
| **add** | `src/ui/__tests__/Button.test.tsx` | Renders each variant; click handler fires; disabled prevents click |
| **add** | `src/ui/__tests__/Chip.test.tsx` | Renders variants; LED appears for status variants |
| **add** | `src/ui/__tests__/Banner.test.tsx` | Renders variants; close button dismisses; banner action fires |
| **add** | `src/ui/__tests__/Toast.test.tsx` | Provider renders; show() displays + auto-dismisses; consecutive calls preempt |

## Manual test scenarios

1. **Boot the app** (`npm run dev` + `tauri dev`). Header shows wordmark with italic Fraunces "I", ⌘K hint, Getting Started, Connect to Cloud — all aligned on the same baseline, with cream gutter equal on left/right/top.
2. **Resize the window** wide and narrow. Header rail and status rail keep equal cream gutters. Status chips wrap on narrow widths instead of clipping.
3. **Trigger an escalated ticket** (have a ticket file in `databases/tickets/` with `status: "escalated"`). The "Needs your reply" banner appears INSIDE the chat pane (below the chat header, above the chat stream). It clips to the chat pane's rounded corners. Dismissing it does NOT cause a layout jump elsewhere.
4. **Click "Connect to Cloud"** — header button shows hover state; click opens the existing onboarding flow (no functional regression).
5. **Click ⌘K hint** — the existing command palette opens.
6. **Trigger a Toast** by uploading a file in the Viewer. The toast appears at the bottom-right of the window (not inside the viewer). Auto-dismisses after 4s. Clicking the × dismisses it immediately.
7. **Status bar interactions** — Slack chip click opens the connect-slack flow. Intake URL chip opens the URL in browser.
8. **Cloud-connected state** — the "Connect to Cloud" button changes to "Cloud · {orgName}". Clicking it opens onboarding to update creds.
9. **Pull rotation** — clicking the ↻ button in the left tab rail rotates while pulling.
10. **Sync tab badge** — make a local change. The Sync tab shows the change count badge in the new accent-pill style. Counts use mono tabular numerals.

## Implementation checklist

- [ ] Create `src/styles/tokens.css` with full v5 token list
- [ ] Add `@import "./styles/tokens.css";` at the top of `src/App.css`
- [ ] Build `src/ui/` primitives (Button, Chip, Badge, Banner, Toast, Input, Field, Modal, SectionBar, Pane, Wordmark)
- [ ] Add `src/ui/index.ts` barrel
- [ ] Rewrite `src/Toast.tsx` to re-export from `src/ui/Toast` (preserves public API)
- [ ] Update `src/main.tsx` (no API change but the import resolves to the new module via re-export)
- [ ] Migrate `src/App.tsx` header
- [ ] Migrate `src/shell/StatusBar.tsx`
- [ ] Migrate `src/shell/EscalatedTicketBanner.tsx`
- [ ] Move EscalatedTicketBanner mount in `src/shell/Shell.tsx` from top-of-shell to inside-right-pane
- [ ] Update `src/shell/Shell.tsx` outer layout (equal gutters, transparent rails)
- [ ] Wire `src/shell/Viewer.tsx` to use the global Toast (drop `ToastView`)
- [ ] Delete `src/shell/Toast.tsx` and `src/Toast.css`
- [ ] Delete migrated CSS classes from `src/App.css`
- [ ] Write/update unit tests
- [ ] Run `npm run code-check --workspace=@pinkfish/app`
- [ ] Run `npm run biome:write`
- [ ] Boot smoke test (manual)
- [ ] Commit on `design-system-v5` branch

## Risk + rollback

- **Risk**: an old class deletion breaks a non-migrated surface. Mitigation: only delete classes whose only consumers are migrated this PR; verify with `grep` before deleting.
- **Risk**: `src/Toast.tsx` re-export breaks the fs-watcher flash flow. Mitigation: preserve the same `ToastProvider` + `useToast` exports and the same `.show(message)` signature; the implementation is rebuilt but the API stays identical.
- **Risk**: Shell layout regression (panes don't render at all). Mitigation: keep the existing `PanelGroup` / `Panel` / `PanelResizeHandle` library calls untouched; only change the wrapper chrome.
- **Rollback**: branch isolated; `git worktree remove`.

## Subsequent phases (out of scope this PR)

- **Phase 2**: Migrate FileExplorer, Viewer, ChatPane internals to use the new primitives. Delete their CSS classes from App.css.
- **Phase 3**: Migrate ConflictBanner, AgentActivityBanner to use `<Banner>`.
- **Phase 4**: Migrate CommandPalette, PinkfishOauthModal, Onboarding, ConfirmModal to use `<Modal>` + `<Field>`.
- **Phase 5**: Migrate SourceControl, RowEditForm, ToolsPanel, SkillActionDock — kill the off-palette purple.
- **Phase 6**: Delete remaining unused CSS from App.css (target: shrink from 5459 lines to ~1500).
