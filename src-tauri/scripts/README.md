# Stable dev codesigning (stop the keychain prompt loop)

`tauri dev` rebuilds the binary on every change. Each rebuild changes the
binary's hash, so macOS treats it as a "new app" and the keychain ACL you
approved last time is invalidated — the keychain prompt comes back. Signing
every dev build with a **stable self-signed identity** makes "Always Allow"
stick across rebuilds.

This is wired up via `src-tauri/.cargo/config.toml` + `scripts/dev-codesign.sh`
(a cargo runner). It runs automatically; you just need the cert in your keychain.

## One-time setup

1. Open **Keychain Access** → menu **Keychain Access → Certificate Assistant
   → Create a Certificate…**
2. Set:
   - **Name:** `OpenIT Dev`
   - **Identity Type:** Self Signed Root
   - **Certificate Type:** Code Signing
3. Click **Create** and accept the warning. The cert lands in your **login**
   keychain.
4. Verify it shows up (note: no `-p codesigning` filter — self-signed certs aren't policy-trusted by default, but we don't need that for local signing):
   ```
   security find-identity | grep "OpenIT Dev"
   ```
   You should see a line with a SHA-1 hash and `"OpenIT Dev"`. If it says `CSSMERR_TP_NOT_TRUSTED`, that's fine — we sign by SHA-1, which bypasses the trust check.

That's it. Next `npm run tauri dev` will sign the dev binary with this cert
before launching.

## What to expect on first launch

You'll get **two** keychain prompts, in this order. Click **Always Allow** on
each — they only appear once.

1. **`codesign wants to sign using key "OpenIT Dev"`** — `codesign` asking
   permission to use the cert's private key to sign the binary. Granting
   "Always Allow" lets every future rebuild sign silently.
2. **A prompt from the OpenIT app itself** — the first time the app
   reads/writes its keychain entries under service `ai.pinkfish.openit`.
   "Always Allow" sticks here because the binary now has a stable signature
   (any future rebuild signed with the same cert satisfies the same ACL).

After those two clicks, all subsequent `tauri dev` runs are silent.

## If old prompts still show up

Existing keychain entries written before you set this up are bound to the
old (unsigned) ACL. Delete them once and let them get rewritten:

```
security delete-generic-password -s ai.pinkfish.openit 2>/dev/null
```

(Repeat per slot if needed; the service name is `ai.pinkfish.openit`.)

## Custom identity name

If you'd rather use a different cert name, set:

```
export OPENIT_DEV_SIGNING_IDENTITY="My Cert Name"
```

before `npm run tauri dev`.

## What if I skip the setup?

`dev-codesign.sh` falls back to running unsigned with a warning — dev still
works, you just keep getting keychain prompts.
