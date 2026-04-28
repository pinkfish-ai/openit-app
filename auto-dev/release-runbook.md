# Release runbook

How to cut a public release of the macOS desktop app and what to do when CI
goes sideways. Pairs with [`.github/workflows/release.yml`](../.github/workflows/release.yml)
and [`auto-dev/plans/2026-04-28-ship-current-main-plan.md`](plans/2026-04-28-ship-current-main-plan.md).

## Cutting a release

```bash
# 1. Bump the version in lockstep — both must match the tag.
#    src-tauri/tauri.conf.json    "version": "0.1.0"
#    src-tauri/Cargo.toml         version = "0.1.0"
#    package.json                 "version": "0.1.0"
#    landing/package.json         "version": "0.1.0"
# 2. Commit the bump on main.
# 3. Tag and push.
git tag v0.1.0
git push origin v0.1.0
```

That's it. The `Release` workflow runs on tag push, builds both DMGs in
parallel on `macos-14`, signs the updater archives, and publishes a GitHub
Release at `https://github.com/pinkfish-ai/openit-app/releases/tag/v0.1.0`.

The in-app updater (configured in `tauri.conf.json` to point at
`/releases/latest/download/latest.json`) picks up the new version on next
launch for any user already on a prior release.

## Required GitHub secrets

### v0.1.0 (unsigned) — minimum

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.openit/openit_updater.key` (paste verbatim, the whole multi-line file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty string (key was generated without a password) |

**The Tauri private key is the load-bearing piece.** If it's lost, every
existing OpenIT install becomes unable to verify updates and is orphaned —
they'd have to manually download a new DMG. Keep a backup in 1Password or
similar, not just in GH Secrets.

The matching public key is committed at `src-tauri/tauri.conf.json` →
`plugins.updater.pubkey` and ships with every build.

### v0.2.0+ (signed + notarized) — additional

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` exported from Keychain. `base64 -i Cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | Password set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Exact identity name, e.g. `Developer ID Application: Pinkfish Inc (TEAMID)` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_PASSWORD` | App-specific password generated at appleid.apple.com (NOT your Apple ID password) |
| `APPLE_TEAM_ID` | 10-char alphanumeric team ID from developer.apple.com |

The workflow auto-detects these. If they're set, the build is signed with
Developer ID and notarized via `notarytool`. If `APPLE_SIGNING_IDENTITY`
is empty, the build is ad-hoc-signed and skips notarization. No workflow
changes needed to flip between paths — it's purely secrets-driven.

## Pre-flight checklist before tagging

- [ ] All four version fields match the tag you're about to push
- [ ] CI is green on `main`
- [ ] You can launch a local `npm run tauri build` (catches Rust/TS regressions before burning a CI run)
- [ ] If this is the first release: `TAURI_SIGNING_PRIVATE_KEY` secret is set
- [ ] Tag does not already exist locally or on the remote (`git ls-remote --tags origin`)

## When CI fails

### `npm ci` exits with a lockfile mismatch

The lockfile drifted from `package.json`. Fix locally with `npm install`,
commit the updated `package-lock.json`, and retag.

### `cargo` build fails on `x86_64-apple-darwin`

Cross-compiling Tauri to Intel from an Apple Silicon runner is the most
fragile step. Check the error; common causes:

- A native dep doesn't expose an Intel build (rare for our deps)
- A C dependency mis-detects the target arch
- A patched fork of a Rust crate doesn't build for the cross target

Quick fallback: comment out the `x86_64-apple-darwin` matrix entry in
`release.yml`, retag with the same version (delete the failed release first),
ship arm64-only, and update the landing page to mark Intel as "coming soon."
File a follow-up ticket.

### Tauri updater signature mismatch

If the public key in `tauri.conf.json` doesn't match the private key used to
sign updater archives, every running OpenIT install will reject updates
silently. Symptom: users stay on old versions despite new releases. Fix:
re-generate the keypair, update `pubkey` in `tauri.conf.json`, push a new
release. Existing users will need a fresh DMG download once because their
installed version still has the old `pubkey` baked in — there is no recovery
path that reaches them automatically.

**Don't rotate the keypair casually.** Once it's in users' hands, it's load-bearing.

### Notarization rejection (v0.2.0+ only)

`xcrun notarytool log <submission-id>` returns the structured rejection. The
common ones:

| Reason | Fix |
|---|---|
| `The signature does not include a secure timestamp` | Tauri should add this automatically; verify the runner has network during signing |
| Hardened runtime not enabled | Ensure `entitlements.plist` is wired in `tauri.conf.json` and not corrupted |
| `com.apple.security.get-task-allow` entitlement present | Debug-only entitlement; remove from `entitlements.plist` |
| Embedded binary not signed | Some bundled resource is unsigned; check the build logs for which one |

Iterate on the entitlements/build, retag with a new patch version, ship.

### Release already exists

`tauri-action` won't overwrite an existing GH Release. To re-cut the same
version: delete the GH Release in the UI, delete the tag locally and on the
remote (`git push --delete origin v0.1.0`), then retag and push.

## Validating a release on a clean Mac

After CI publishes, before you announce the release:

1. Download the DMG from the GH Release page on a Mac that has never run OpenIT
2. Drag to `/Applications`, double-click — confirm the Gatekeeper dialog
   appears (expected on v0.1.0)
3. Open via System Settings → Privacy & Security → "Open Anyway"
4. Confirm the app launches and the embedded terminal renders Claude
5. With a *prior* version installed, push a new release and confirm the
   in-app update prompt fires on next launch
6. Confirm the update installs cleanly and OpenIT relaunches into the new version

Step 5 is the one that catches the most bugs. The first time we cut v0.1.1
after v0.1.0 ships, walk through this end-to-end.
