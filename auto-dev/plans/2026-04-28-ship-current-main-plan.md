# Ship current `main` as a public macOS download

**Date:** 2026-04-28
**Goal:** Take whatever is on `main` today and turn it into a signed, notarized, auto-updating macOS DMG that anyone can download from a public landing page. No feature work, no stability freeze, no self-serve onboarding — admins still get tokens hand-provisioned.

## Scope

**In:**
- **Unsigned, ad-hoc-signed DMGs** — two of them, one per arch (`aarch64-apple-darwin`, `x86_64-apple-darwin`), built in parallel via CI matrix. Apple Developer ID cert + notarization is **deferred to v0.2.0** (Pinkfish enrolls in Apple Developer Program in parallel; ETA 1–2 weeks). Users will see a Gatekeeper warning on first launch — handled by clear instructions on the download page.
- Tauri auto-updater wired to GitHub Releases (so v0.1.0 users automatically get v0.1.1+); per-arch update channels in `latest.json`
- GitHub Actions release pipeline triggered by `v*.*.*` tag push
- Static landing page in a new `/landing` folder at repo root, with: home, downloads (two CTAs — "Apple Silicon" + "Intel" — pulled from latest GH release), privacy stub, terms stub
- **Local-only for now** — `npm run dev` in `/landing` to view. Deployment (Cloudflare Pages, GH Pages, or wherever) is a follow-up once you've eyeballed the site and decided where it lives.
- README updates documenting release flow

**Out:**
- Self-serve onboarding / org auto-provision (M2)
- Windows / Linux builds
- Billing, pricing, license enforcement
- Real legal copy for ToS / Privacy (stubs only)
- Real domain / DNS — ship to `*.pages.dev` first, custom domain later
- Stability freeze on features
- **Apple Developer ID signing + notarization** — follow-up release (v0.2.0) once the Apple Developer Program enrollment completes. The pipeline is structured so flipping signing on later is a config change, not a rewrite.

## Branch + worktree

- Branch: `ship/public-distribution`
- Worktree: `/Users/sankalpgunturi/Repositories/openit-app-ship` (sibling of main checkout)
- Plan lands as commit 1; implementation as subsequent commits

## What I need from you (hard dependencies)

The mechanical work I can do on my own. These I cannot — they require your accounts and credentials:

1. **Tauri updater secrets** (I generate the keypair locally, hand you the private key to paste in):
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
2. **In parallel, start Apple Developer Program enrollment for Pinkfish.** D-U-N-S number first (free, 1–5 days, dnb.com), then organization enrollment ($99/yr, 1–2 weeks). Doesn't block this release — but the sooner you start, the sooner v0.2.0 can ship signed.

## Workstreams

### 1. Auto-updater (in-app)

- Add `tauri-plugin-updater` to `src-tauri/Cargo.toml`
- Generate keypair via `npm run tauri signer generate`; commit public key to `tauri.conf.json`, hand private key to you for secrets
- Configure `plugins.updater.endpoints` in `tauri.conf.json` to point at GH Releases `latest.json` pattern
- Add minimal React hook on app launch: check for update → prompt → install + relaunch
- Fail-soft: no crash if endpoint unreachable

### 2. Bundle metadata + future-proofing for signing

- **Ad-hoc signing only** for v0.1.0. Tauri does this by default when no `signingIdentity` is set — produces an `.app` macOS will execute, but Gatekeeper flags it on first launch.
- Update bundle config: `category`, `shortDescription`, `longDescription`, `copyright`
- Bump version field discipline — pipeline tags must match `tauri.conf.json` version
- **Pre-write `entitlements.plist`** with the hardened-runtime entitlements we'll need later (network client, JIT if needed for any embedded WebView features). Wired into `tauri.conf.json` as `macOS.entitlements` but a no-op without `signingIdentity`. When the Developer ID arrives, flipping signing on is: add `signingIdentity` env in CI + populate the 6 Apple secrets. No code rewrite.
- Add a small placeholder `.cargo/config.toml`-style env hook so the same workflow file can produce signed-or-unsigned based on whether `APPLE_SIGNING_IDENTITY` secret is present — keeps v0.1.0 and v0.2.0 on one workflow.

### 3. Release CI (`.github/workflows/release.yml`)

- Trigger: push of tag matching `v*.*.*`
- Runner: `macos-14` (Apple Silicon)
- **Matrix strategy:** two parallel jobs, one per `target` ∈ `{aarch64-apple-darwin, x86_64-apple-darwin}`. Apple Silicon and Intel users get separate, smaller, native DMGs.
- Per-job steps (v0.1.0 unsigned path):
  1. Checkout
  2. Setup Node 20 + Rust stable + add the matrix target
  3. `npm ci`
  4. `npm run tauri build -- --target ${{ matrix.target }}` — produces ad-hoc-signed `.app` + `.dmg`
  5. Sign updater archive `.app.tar.gz` with Tauri's minisign key (independent of Apple)
- Per-job steps (v0.2.0+ signed path, gated on `APPLE_SIGNING_IDENTITY` secret being set):
  1–4 as above, plus:
  5. Import signing cert from `APPLE_CERTIFICATE` into a temp keychain
  6. Tauri build picks up the identity from env and signs with hardened runtime + secure timestamp
  7. Notarize the `.app` via `xcrun notarytool submit --wait`
  8. Staple the ticket to the `.dmg`
  9. Verify with `spctl -a -t open --context context:primary-signature *.dmg`
- **After matrix completes:** a final aggregate job creates the GitHub Release with `softprops/action-gh-release` and uploads both DMGs + both `.app.tar.gz` archives + a single `latest.json` updater manifest (which contains separate `signature` + `url` entries keyed by `darwin-aarch64` and `darwin-x86_64`).
- Concurrency guard so two tag pushes don't fight
- Artifact retention: keep release files; clean up CI build dir

### 4. Landing page (`/landing`)

- Stack: **Astro** with TypeScript, Tailwind. Zero-JS by default, deploys as static, fast to build, easy to extend.
- Folder: `/landing` at repo root, own `package.json`, own `node_modules`, no shared workspace overhead.
- Pages:
  - `/` — what OpenIT is, who it's for (SMB IT admins), one screenshot, "Download for Mac" CTA
  - `/download` — pulls latest release tag from GH API at build time. **Two prominent buttons:** "Download for Apple Silicon (M1/M2/M3/M4)" and "Download for Intel Mac." Small "Not sure which Mac you have?" link → Apple's "About This Mac" instructions. No auto-detect — easier UX, avoids `userAgentData` cross-browser inconsistency, harder to get wrong.
  - **First-time install instructions** prominently below the buttons, since the v0.1.0 build is unsigned: "macOS will say *'OpenIT can't be opened.'* That's expected for the beta. To open: **System Settings → Privacy & Security → scroll down → 'Open Anyway' next to OpenIT.** Or run `xattr -cr /Applications/OpenIT.app` in Terminal." Plus a small "Why?" expandable: "We're in the process of getting an Apple Developer ID. Future versions will install without this step." Removed once v0.2.0 ships signed.
  - `/privacy` — stub: what data leaves the machine (telemetry, Pinkfish API calls), retention, contact email
  - `/terms` — stub: beta software, no warranty, contact email
- Build output: static `dist/` deployed to GH Pages
- README in `/landing` documenting how to run locally and how deploy happens

### 5. Landing CI — **deferred**

No deploy workflow this round. You'll review the site locally via `npm run dev` in `/landing`. Once you decide the host (Cloudflare Pages, GH Pages once repo goes public, Vercel, etc.), the deploy workflow is a 30-minute follow-up — Astro builds to a static `dist/` directory, every host on earth accepts that.

### 6. Documentation

- Update root [README.md](../README.md) (or create one — not sure it exists yet) with: how to cut a release (`git tag v0.1.1 && git push --tags`), where releases land, how the landing page deploys
- Add `auto-dev/release-runbook.md` with the "something failed in CI, here's how to debug" checklist

## Execution order (after plan approval)

1. Create branch + worktree
2. Commit this plan (already on disk after approval)
3. Land workstream 1 (updater) — touches `src-tauri/` and `tauri.conf.json`, generates keypair (hand you private key out-of-band)
4. Land workstream 2 (signing config + entitlements)
5. Scaffold `/landing` (workstream 4) — verify it builds locally
6. Land workstream 3 (release.yml) — cannot fully test until you add updater secrets; will dry-run via a draft tag
7. (Workstream 5 deferred — no landing CI this round)
8. Land workstream 6 (docs)
10. Open PR
11. You add the 2 updater GH secrets
12. Cut a `v0.1.0` tag, watch the pipeline, fix whatever breaks
13. Verify download → install → "Open Anyway" → launch → auto-update flow works end-to-end on a clean Mac

## Risks + things that will probably go sideways

- **Gatekeeper friction on first install.** Every v0.1.0 user will hit it. Mitigation: clear, calm instructions on the download page (above). Audience is IT admins, not consumers — they can handle a Settings panel click. Real fix is v0.2.0 with Developer ID.
- **Auto-update behavior on unsigned builds.** Tauri's updater downloads via Rust's HTTP client, which **does not** set the macOS quarantine bit. So the Gatekeeper warning *should* only fire on the very first install (browser download). Subsequent auto-updates *should* install silently. This is the expected behavior but I want to verify on a real Mac before we celebrate — adding to the v0.1.0 release-validation checklist.
- **Cross-compile to `x86_64-apple-darwin` on Apple Silicon CI runners** is occasionally flaky. Fallback if it breaks: ship arm64-only for v0.1.0, "Intel build coming soon" on the download page, fix as a follow-up.
- **Updater key custody.** Lose the private key and you can't ship updates anymore — every existing install becomes orphaned. Store the private key somewhere durable beyond GH secrets (1Password, etc.) before we cut v0.1.0.
- **No stability gate.** You explicitly chose to ship `main` as-is. First user reports of broken sync / connect flows are likely. Sentry will catch them; the auto-updater is what makes that survivable.
- **Tag/version drift.** If `tauri.conf.json` version doesn't match the git tag, updater manifests get confused. Add a small CI check that asserts they match.

## Decisions locked

- Bundle identifier: `ai.pinkfish.openit` (no change)
- Sentry: not in scope for v0.1.0
- Domain: not in scope; landing page is local-only this round

## v0.2.0 follow-up (when Apple Developer ID is ready)

- Add 6 Apple secrets to GH (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID`)
- Same workflow auto-detects the secrets and switches to the signed-and-notarized path
- Cut a `v0.2.0` tag — pipeline produces signed DMGs, no Gatekeeper warning for users
- Remove the "First-time install" workaround instructions from the download page
- Existing v0.1.0 users get auto-updated to v0.2.0 silently (no quarantine bit on updater downloads)
