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
4. **Trust the cert for code signing.** This is the step that makes "Always
   Allow" actually stick across rebuilds — without it, macOS binds keychain
   ACLs to the binary's CDHash (which changes every rebuild) instead of its
   designated requirement (which is stable). You'll re-prompt forever.
   - In Keychain Access, find **OpenIT Dev** under **login → My Certificates**
     (or **Certificates**), double-click it.
   - Expand **Trust**, set **Code Signing: Always Trust**.
   - Close the window — macOS will ask for your login password to save.
5. Verify it shows up:
   ```
   security find-identity | grep "OpenIT Dev"
   ```
   You should see a line with a SHA-1 hash and `"OpenIT Dev"`. (We sign by
   SHA-1, so the line works regardless of trust status — but the trust
   setting from step 4 is what makes ACLs bind to the DR.)

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
old ACL (CDHash of a previous unsigned/differently-signed binary). Delete
them once and let the app rewrite them — the new entries will bind to the
stable DR.

```
security delete-generic-password -s ai.pinkfish.openit 2>/dev/null
```

(Repeat per slot until it says "could not be found"; the service name is
`ai.pinkfish.openit`.)

If you're still being prompted on every rebuild after deleting + clicking
Always Allow, you almost certainly skipped the trust step (one-time setup,
step 4). Without it, the ACL binds to CDHash and re-prompts forever.

## Custom identity name

If you'd rather use a different cert name, set:

```
export OPENIT_DEV_SIGNING_IDENTITY="My Cert Name"
```

before `npm run tauri dev`.

## What if I skip the setup?

`dev-codesign.sh` falls back to running unsigned with a warning — dev still
works, you just keep getting keychain prompts.
