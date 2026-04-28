# PIN-5774 — Connect to Cloud V1 (auth handoff)

**Date:** 2026-04-28
**Linear:** [PIN-5774](https://linear.app/pinkfish/issue/PIN-5774)
**Branch:** `ben/pin-5774-openit-connect-to-cloud-v1-browser-handoff-auth-no-manual`
**Status:** Draft, awaiting approval before implementation.
**Goal:** Reduce "Connect to Pinkfish" from ~7 manual steps to ~3 clicks. **V1 is auth only** — get valid client credentials into the keychain via a browser handoff. Sync (and the four cloud capabilities it unlocks) is V2; the local-first refactor likely broke pieces of the existing sync flow and that needs its own pass.

## Why now

The local-first flip shipped. Everything that *can* run on a single laptop already does. "Connect to Cloud" is the path to multi-person sync, always-on agents, Slack/Teams routing, and a hosted intake page — but **none of those features work until creds are in the keychain.** Auth is the gating step.

V1 ships only the auth handoff. After it lands, the keychain holds valid creds and the existing token-refresh loop runs. V2 picks up sync — which we should assume is broken until proven otherwise (the local-first work moved enough underneath it that the previous bidirectional flow can't be trusted without a re-verification pass).

The blocker today isn't the cloud features themselves; it's the onboarding gauntlet — 4 fields the user has to find in a separate browser tab and paste back in.

## Today's flow (the thing we're replacing)

1. Click "Sign Up" → app.pinkfish.ai/signup.
2. Email + password → confirm via email code (Google OAuth skips this step).
3. Sign in → land in dashboard.
4. Settings → Account Keys → Create.
5. Name the key.
6. Copy `client_id` + `client_secret`.
7. Find `org_id` (URL or settings).
8. Switch back to OpenIT, paste 3 strings, click Connect.

Sources of friction: the manual paste, finding `org_id`, knowing what an "account key" is, the context-switch between two windows.

## Constraint that shapes the design

Account keys are minted by `POST /api/account-keys`, which is **gated by a Cognito session**. There is no public API to self-serve a key without first authenticating in a browser. That means the cred-creation step has to happen *in the browser, after sign-in* — we can only cut the manual-paste step, not the sign-in step itself.

Google OAuth signup skips the email-confirmation step and is the fastest path to a usable account; we should default users toward it.

## V1 architecture — localhost callback handoff

One new web route + one localhost listener. No deep-link scheme registration, no new email infrastructure, no backend changes to the auth model.

### Flow

1. User clicks **Connect to Cloud** in OpenIT.
2. App starts an axum listener on `http://127.0.0.1:<random-port>/cb` with a one-time `state` token (~64 bits of entropy).
3. App opens browser to:
   ```
   https://app.pinkfish.ai/openit/connect
     ?cb=http://127.0.0.1:<port>/cb
     &state=<state>
     &name=<machine-name>
   ```
4. **Web `/openit/connect` route:**
   - **Not signed in:** render "You need a Pinkfish account first" with a button **"Sign in / Sign up (opens new tab)"**. Clicking opens `/signup` in a new browser tab. The `/openit/connect` tab stays open and polls auth state every ~2s. When the user finishes signup/sign-in in the other tab, Cognito's session lands in shared browser storage; the polling tab notices, advances to the org-pick state, and the user closes the now-redundant tab. **No changes required to the signup flow itself.** (We considered threading a `redirect` query param, but it doesn't exist today — `SignupForm`, `AuthWithProviders`, and `confirm-account` all hardcode `navigate(ROUTES.MAIN)`. Adding one would touch ~6 files. The new-tab + poll approach is V1-er and avoids that whole detour.)
   - **Signed in:** read the user's currently-selected org from session/store. Mint the key against that org. **No picker in V1.** Switching the active org turns out to involve Cognito session attributes — not worth the scope. Multi-org users must switch to the right org in the main Pinkfish app first, then return to `/openit/connect`. Surface this as a one-line hint near the org-name display: *"Connecting OpenIT to: <org>. Switch orgs in the main app first if this is wrong."*
   - Click **"Authorize OpenIT"** → call existing `useCreateAccountKey` with `name = "OpenIT — <machine-name>"`. Returns `{id, keyValue, orgId}`.
   - Auto-submit a hidden form POSTing JSON `{client_id: id, client_secret: keyValue, org_id: orgId, token_url, state}` to the `cb` URL.
   - Show "✓ Connected to OpenIT. You can close this tab."
5. App's listener:
   - Verifies `state` matches.
   - Writes the four creds to keychain via the existing `saveCreds`.
   - Calls existing `refresh()` to mint the first JWT (proves the creds work end-to-end before declaring success).
   - Calls existing `pinkfishListOrgs` to resolve the org name for the UI.
   - Shuts the listener down.
   - **Does not run sync.** UI flips to "Connected to <org>" but no datastore / agent / workflow / filestore / KB pull. That's V2.

User-visible steps: **click → Google sign-up → click Authorize → done.** Three clicks. Email/password adds one email-confirmation step.

### Why localhost callback (and not the alternatives)

- **vs. native deep links (`openit://`):** would need `tauri-plugin-deep-link`, Info.plist entries on macOS, registry on Windows, and breaks under sandboxes/Linux variants. Localhost is the standard CLI pattern (`gh auth`, `gcloud auth`, `az login`, `vercel`, etc.) and works identically across platforms.
- **vs. magic-link email:** adds a backend service, slows the path with an email round-trip.
- **vs. device code (paste a 6-char code):** same number of context switches, more visible UX overhead.
- **vs. embedded webview for sign-in:** hostile to Cognito's hosted UI and password managers.

## Implementation

### Repo: `web` — new `/openit/connect` route

Single new page. Reuses:

- Existing `/signup` flow (just adds a `redirect` param it already supports).
- Existing `useCreateAccountKey` and `useGetOrganizations` hooks.

New code (~150 LOC):

- `web/packages/app/src/routes/openit-connect/OpenITConnect.tsx` — the page component.
  - Pulls `cb`, `state`, `name` from query string.
  - If not authed: `Navigate` to `/signup?redirect=...` (carries the same query through).
  - If authed: org list → auto-pick or render `OrgPicker`.
  - "Authorize" button → mint key → auto-POST to `cb` via a hidden form (form POST works regardless of CORS; the localhost listener accepts the POST and we don't need a fetch response).
  - Success state: "✓ You can close this tab."
- Route registration in `web/packages/app/src/app/App.tsx`.
- Lead the page with the Google button if available — it's the fastest path. Add a one-line note on the signup detour: *"OpenIT needs you to authorize it in your browser — this is a one-time step."*

Verify the existing signup `redirect` param survives email confirmation. If it doesn't, that's a small parallel fix (likely passing the param through the confirmation URL).

### Repo: `openit-app` — new Rust command + Connect button

New Rust command `oauth_callback_start` in `src-tauri/src/pinkfish.rs` (or a new `oauth_callback.rs` mirroring `intake.rs`):

```rust
// Returns { url: String, port: u16, state: String }
// Spawns an axum server on 127.0.0.1:0
// Single route POST /cb that:
//   - Validates `state` matches what we generated
//   - Forwards { client_id, client_secret, org_id, token_url } to
//     a tokio oneshot channel
//   - Returns 200 with a tiny "you can close this tab" HTML
// Times out after 5 minutes and shuts itself down
```

Frontend (`src/lib/api.ts` + `src/Onboarding.tsx`):

- New helper `oauthCallbackStart()` → invokes the Rust command, returns `{cb_url, state}`.
- Replace the **Connect** button's behavior:
  - Old: `setAuthOpen(true)` → opens `PinkfishOauthModal`.
  - New: `startBrowserConnect()` → calls `oauthCallbackStart`, opens browser to the web URL, awaits a follow-up command that resolves when the listener receives creds (via a Tauri event or a second `oauth_callback_await` invoke).
- On success: `saveCreds` → `refresh` → resolve org name. **Stop there for V1.** Don't call any of the `start*Sync` helpers. The modal currently chains them; we factor the cred-validation prefix out into a shared `connectAndValidate(creds)` function and call only that.
- Keep `PinkfishOauthModal` as **Advanced › Paste credentials manually** (one collapsed disclosure) — useful for headless dev, troubleshooting, and CI. **Same scope cut applies:** Advanced path also stops after validation; no sync.

### Repo: `openit-app` — Claude Code skill (after main flow lands)

Same web route, different client. Update `scripts/openit-plugin/skills/connect-to-cloud.md` and add `scripts/openit-plugin/scripts/connect-cloud.mjs`:

```js
// Spawns http.createServer on 127.0.0.1:<random>/cb
// open()s the same /openit/connect URL
// On POST: writes creds to:
//   - macOS: `security add-generic-password ...` for each slot
//   - Other: ~/.openit/cloud.json (mode 600)
// Triggers a first sync via the platform REST API
```

The skill becomes: a few sentences telling the user what's about to happen, then `node .claude/scripts/connect-cloud.mjs`.

This unlocks "connect from a terminal without ever opening the OpenIT app" — useful for power users and CI.

## Token refresh & re-auth

Existing behavior we keep:

- `pinkfishAuth.ts` already auto-refreshes the JWT every ~55 minutes using the stored client credentials. **No change.** As long as the keychain still has valid creds, the user stays signed in.

New behavior:

- If `refresh()` returns 401 (creds revoked/deleted from the Pinkfish dashboard), surface a banner with **"Reconnect to Cloud"** that re-runs the localhost handoff. Don't open the manual modal by default — only via the Advanced disclosure.

## Multi-org

V1: org picker shown only when the user has >1 org. Most early users have one (signup creates one — the starter plan).

Forward notes (NOT in this PR — parked for V2):

- **New pricing tier required.** Today's starter plan allows one org per account. The dev/stage/prod pattern (with dev being local) needs a tier that permits **2 orgs** (stage + prod). Stripe work + a new plan SKU on the Pinkfish side.
- **Credit allocation.** That same tier needs enough credits headroom for an always-on agent + sync traffic. Right-size before the tier ships.
- **"Switch org" affordance** in the OpenIT header — needs to exist before multi-org is useful in the app.

V1 ships against today's starter plan (one org). The picker code path is built, but in practice almost no one will see it until the new tier exists.

## Enterprise-plan gate (known V1 limitation)

`POST /api/account-keys` is enforced server-side as **enterprise-plan-only** (`platform/services/account-keys.go` → `requireEnterprisePlan`). Starter-plan users physically cannot mint a key — the server returns 403 / "enterprise plan required."

V1 does **not** change this. Implications:

- **Internal / dogfooding works** — the Pinkfish org is enterprise; we and any enterprise customer can use V1 end-to-end today.
- **External starter users will hit the gate.** The Authorize step must surface this as a clear, dignified error: *"Your current plan doesn't include API credentials. OpenIT cloud is coming to all plans soon — for now it requires an Enterprise subscription."* with a link to `/change-plan`. **Not** a stack trace, not a generic error toast.
- **This is the V2 pricing-tier work** the brief calls out. V1 ships behind that gate intentionally and unblocks the engineering side; the pricing/Stripe side ships in V2 in parallel.

The new-tab + poll approach above keeps the gate failure recoverable: the user lands back on `/openit/connect`, sees the error message, and can either upgrade or close the tab. No keychain corruption, no "half-connected" state in the desktop app.

## What we are NOT doing in V1

- **No sync.** Connecting writes creds + verifies they work. It does not pull datastores, agents, workflows, filestores, KB, or the plugin manifest. The local-first refactor likely broke pieces of the existing sync flow; V2 is a dedicated "make sync work again" pass with a re-verification of every entity type. Today's modal happens to chain sync after auth — V1 cuts that chain.
- No `openit://` URL scheme registration.
- No backend changes to OAuth or account-key creation.
- No public/email-based signup that bypasses Cognito.
- No "headless" device-code flow.
- No org creation from inside OpenIT (signup creates one; that's enough).
- No Stripe tier work.

## V2 scope (not this PR, just naming it)

After V1 lands, "Connected" means creds work but nothing has been pulled yet. V2 picks up:

- Audit each `*Sync` engine against the local-first file layout — they were built for cloud-as-source-of-truth and the disk shapes have shifted.
- Re-verify the conflict-resolution scenarios from `2026-04-25-bidirectional-sync-plan.md` against current main.
- Decide where the "Sync now" affordance lives (Deploy tab? auto-on-connect? both?).
- Then re-enable sync from the V1 connect path.

Splitting these means V1 is reviewable on its own merits (a focused auth PR) and V2 is honest about the engineering work — not hidden behind "we just need to wire the button."

## Phasing

Two PRs, each independently shippable.

**PR 1 — Web `/openit/connect` route.** Can ship first; the existing manual modal keeps working against it (you'd just have to copy/paste from the page, no worse than today).

**PR 2 — App localhost callback + new Connect button.** Lands on top of PR 1. Replaces the modal as the default; modal stays as Advanced.

**PR 3 (optional, follow-up) — Claude Code `/connect-to-cloud` skill.** Same web backend, terminal client. ~half a day.

## Risks

1. **Cognito redirect chain dropping the `?redirect=` param** through email confirmation. If it does, fix in the same PR — likely a one-line forwarding through the confirmation URL.
2. **Localhost listener blocked by host firewall / EDR software.** Unlikely on `127.0.0.1` but worth one explicit mention in the error path: "Couldn't reach the OpenIT app on localhost. Check that no security software is blocking 127.0.0.1." Provide the Advanced manual-paste path as the explicit fallback.
3. **Browser doesn't actually open** (`openUrl` failure on weird desktop configs). Same fallback — surface the URL as copyable text.
4. **Multiple OpenIT instances running.** Each picks a fresh port; the `state` token disambiguates which instance the callback belongs to. Worst case, the wrong instance gets a "state mismatch" 400 and silently shuts down; the right one keeps waiting.
5. **Stale `state` from a previous abandoned attempt.** Handled by the 5-minute listener timeout.

## Success criteria

- A user with no Pinkfish account can go from "Connect to Cloud" click to **"creds in keychain, JWT minted, org name showing"** in under 60 seconds via Google sign-up.
- A user with an existing account can do the same in under 30 seconds.
- The manual-paste modal still works for advanced/dev/CI use (also auth-only, no sync).
- Token refresh continues to "just work" — no user-visible re-auth prompts unless creds are actually revoked.
- "Connected" state is honest: the UI does not imply data is synced when V1 only wired auth. Use copy like "Connected to <org>. Sync coming soon." until V2 lands.

---

## Implementation checklist

Ordered for the smallest reviewable steps. Each checkbox is a discrete commit; PRs grouped at the end.

### A. Web — `/openit/connect` route (PR 1)

- [ ] Add the route component at `web/packages/app/src/routes/openit-connect/OpenITConnect.tsx`.
- [ ] Register the route in `web/packages/app/src/app/App.tsx` (lazy import, public — does not require an org-scoped layout, since "not signed in" is a valid initial state).
- [ ] Pull `cb`, `state`, `name` from the query string. Validate `cb` starts with `http://127.0.0.1:` (reject anything else — mitigates open-redirect risk).
- [ ] If not authenticated, render "Sign in / Sign up (opens new tab)" — `window.open('/signup', '_blank')`. Stay on `/openit/connect`, poll `useIsAuthenticated` every ~2s; when it flips, advance.
  - [ ] No changes to signup flow needed. Cognito session is shared across tabs in the same browser, so the poll catches it.
  - [ ] One-line "after you sign in, come back to this tab" hint near the button.
- [ ] If authenticated, read the user's currently-selected org from `useGetOrganizationId` (zustand). Show the org name. No picker in V1; multi-org users must switch in the main app first.
- [ ] "Authorize OpenIT" button → call `useCreateAccountKey({ name: \`OpenIT — ${name}\` })` against the selected org.
- [ ] On key creation success, render a hidden form with `method="POST" action="${cb}"` containing `client_id`, `client_secret`, `org_id`, `token_url`, `state`. Auto-submit it on mount.
  - [ ] Form-POST (not `fetch`) so CORS is not an obstacle and the localhost listener gets the body.
- [ ] Render the success state: "✓ Connected. You can close this tab." (Browser stays on the auto-submit response page from the localhost listener; the form-POST navigates the tab to the listener's response.)
- [ ] Error states: org-list fetch failed, key-create failed, missing/invalid query params. Each gets a clear message + retry where applicable.
- [ ] Honest copy on the auth page: one-line "OpenIT will get a credential to read and write your Pinkfish org's data on this machine. You can revoke it any time in Settings → Account Keys."

### B. App — Rust localhost callback listener (PR 2)

- [ ] New module `src-tauri/src/oauth_callback.rs` mirroring the structure of `intake.rs`.
- [ ] State struct holds: optional running server, `cmd_lock` Mutex, oneshot sender for the inbound creds.
- [ ] Tauri command `oauth_callback_start(state: String) -> { url: String }`:
  - [ ] Bind axum on `127.0.0.1:0` (OS-assigned port).
  - [ ] Single route `POST /cb` accepting form-urlencoded `client_id`, `client_secret`, `org_id`, `token_url`, `state`.
  - [ ] Validate inbound `state` matches the one passed to `oauth_callback_start`. Mismatch → return 400 + brief HTML; **do not** fire the oneshot. Listener keeps waiting.
  - [ ] Match → fire the oneshot with the creds, return 200 with a tiny "✓ You can close this tab" HTML page.
  - [ ] After the oneshot fires, schedule listener shutdown (200ms grace so the response actually flushes to the browser).
- [ ] Tauri command `oauth_callback_await() -> { client_id, client_secret, org_id, token_url }`:
  - [ ] Awaits the oneshot with a 5-minute timeout.
  - [ ] Timeout → return error "no callback received in 5 minutes"; force-shutdown the listener.
- [ ] Tauri command `oauth_callback_cancel()`:
  - [ ] User-cancellable mid-flow (closes browser tab, hits Cancel in the app).
  - [ ] Force-shuts the listener, drops the oneshot.
- [ ] Register the three commands in `src-tauri/src/lib.rs` `invoke_handler`.
- [ ] Register the state in the Tauri builder.

### C. App — Frontend wiring (PR 2)

- [ ] Add `oauthCallbackStart`, `oauthCallbackAwait`, `oauthCallbackCancel` helpers to `src/lib/api.ts`.
- [ ] Add a small helper in `src/lib/pinkfishAuth.ts`: `connectAndValidate(creds): Promise<{ orgName: string }>` that does `saveCreds → refresh → pinkfishListOrgs → return orgName`. **No sync calls.** Refactored out of `PinkfishOauthModal.submit` so both code paths share it.
- [ ] In `src/Onboarding.tsx`, replace the **Connect** button's `onClick`:
  - [ ] Generate a random `state` (use `crypto.randomUUID()`).
  - [ ] Pull machine name (re-use whatever the app already exposes, or a static "this machine" placeholder for V1).
  - [ ] Call `oauthCallbackStart(state)` → get `{ url: cb_url }`.
  - [ ] Build the web URL: `https://app.pinkfish.ai/openit/connect?cb=<cb_url>&state=<state>&name=<name>`. Make the host configurable via the same env var the existing signup link uses.
  - [ ] `openUrl(webUrl)`.
  - [ ] Show in-modal "Waiting for browser…" state with a Cancel button.
  - [ ] `await oauthCallbackAwait()` → on success, `connectAndValidate(creds)` → `onPinkfishConnected(orgName)` → close modal.
  - [ ] On error or cancel: surface clear message, leave modal open with the manual fallback exposed.
- [ ] Add an `Advanced ›` disclosure in the same modal that reveals the existing 4-field paste form. Submit path also routes through `connectAndValidate` (auth only — no sync).
- [ ] Update on-screen copy: "Connected to <org>. Sync coming soon." (Onboarding step 1 detail, header pill, anywhere else that says "Connected").

### D. App — Re-auth path (PR 2)

- [ ] In `src/lib/pinkfishAuth.ts`, when `refresh()` returns 401 (creds revoked server-side), set `current = null`, notify, and emit a typed event the shell can listen for.
- [ ] In the shell header, listen for that event and render a "Reconnect to Cloud" banner that re-opens the connect modal at the browser-handoff step.

### E. Shared / cleanup

- [ ] Remove the chained `start*Sync` calls from the connect path in `PinkfishOauthModal.submit` (they move to V2). Sync engines themselves stay — they're called from app launch (`App.tsx`) when creds already exist, which is V2's problem to fix, not V1's.
- [ ] Update `auto-dev/00-autodev-overview.md`'s "What syncs on connect" section with a note that V1 connect does **not** sync, pointing at the V2 ticket.

---

## Test plan

### Manual scenarios (must all pass before PR)

| # | Scenario | Expected |
|---|---|---|
| 1 | Fresh user, no Pinkfish account, Google sign-up | Click → browser opens → Google → org auto-picked → Authorize → keychain has creds → JWT minted → "Connected to <org>. Sync coming soon." Under 60s. |
| 2 | Fresh user, no Pinkfish account, email/password | Same as #1 plus one email-confirm step. Confirmation link returns to `/openit/connect`, completes the flow. |
| 3 | Existing signed-in user | Click → browser opens directly to authorize step → 1 click → connected. Under 30s. |
| 4 | Existing user, signed out | Click → browser opens → `/signin` → back to authorize → connected. |
| 5 | Multi-org user | Picker appears, selection respected, key minted under selected org. |
| 6 | User closes the browser tab without authorizing | App shows "Waiting for browser…" until 5-min timeout, then error + "Try again" button. |
| 7 | User clicks Cancel in the app | Listener shuts down cleanly. App returns to disconnected state. Re-clicking Connect works. |
| 8 | Stale callback (state mismatch — manually craft a curl POST to the listener with wrong state) | Listener returns 400, keeps waiting. Real callback still works. |
| 9 | Two OpenIT instances running | Each gets its own port + state. The right instance receives its own callback; the wrong one ignores cross-talk via state mismatch. |
| 10 | Manual paste fallback (Advanced disclosure) | Same `connectAndValidate` path works. No sync side effects. |
| 11 | Creds revoked server-side mid-session | Next refresh → 401 → "Reconnect to Cloud" banner appears → click re-runs the handoff. |
| 12 | Token refresh while connected | Existing 55-min refresh continues to work silently. No user-visible re-auth prompt. |
| 13 | App quit / relaunch with valid creds | Auth state restored from keychain, JWT minted, no re-prompt. |
| 14 | Browser blocked by host firewall (simulate by binding the listener but blocking 127.0.0.1 traffic in a firewall rule, if feasible) | Clear error: "Couldn't reach OpenIT on localhost — check your security software. Or use Advanced › to paste credentials manually." |

### Automated tests

- [ ] **Rust unit tests** in `oauth_callback.rs`: `state` mismatch returns 400 without firing oneshot; matching state fires oneshot and returns 200; timeout path drops the listener cleanly; `cancel` path is idempotent.
- [ ] **Rust integration test:** start listener, POST a real form to the bound port, assert the oneshot resolves with the right values, assert listener tears down within 1s.
- [ ] **TypeScript test in `src/lib/pinkfishAuth.test.ts`**: `connectAndValidate` calls `saveCreds → refresh → pinkfishListOrgs` in order, returns org name, **does not** invoke any `start*Sync` mock.
- [ ] **Web unit test** for `OpenITConnect.tsx`: rejects non-localhost `cb`; auto-redirects to `/signup` when unauthed; submits the hidden form with the right field set on success.

### Cross-environment matrix

- [ ] macOS — Chrome, Safari, Firefox.
- [ ] Windows — Edge, Chrome. (Skip if no Windows access; flag in PR.)
- [ ] Token URL points at `dev*.pinkfish.dev` and `app.pinkfish.ai` — both resolved correctly through `derivedUrls`.

### Don't ship without

- [ ] All scenarios 1–7 pass on macOS Chrome (the primary path).
- [ ] Scenario 11 verified end-to-end (revoke a real key in the Pinkfish dashboard, observe the banner).
- [ ] Cross-family review gate (`review_implementation`) APPROVED per `autonomous-dev/scripts/gates/README.md`.
- [ ] No regressions in existing token-refresh behavior — verify by leaving the app running for >1 hour with creds and confirming a refresh fires.
