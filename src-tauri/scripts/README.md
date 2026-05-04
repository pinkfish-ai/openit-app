# Stable dev codesigning (stop the keychain prompt loop)

`tauri dev` rebuilds the binary on every change. Each rebuild produces a new
CDHash, so macOS re-prompts for keychain access every time — *even if you
clicked "Always Allow" last run*. The reason is the macOS keychain's
**partition list ACL**: when a binary has no stable Team ID, the partition
falls back to per-binary CDHash, and "Always Allow" only whitelists the
current build.

The fix is to sign every dev build with an **Apple Development cert**, which
embeds a stable Team ID. The partition becomes `teamid:<YOUR_TEAM_ID>` and
sticks across all future rebuilds. Self-signed certs do **not** work for
this — they have no Team ID. (See note at bottom.)

This is wired up via `src-tauri/.cargo/config.toml` + `scripts/dev-codesign.sh`
(a cargo runner). It runs automatically; you just need an Apple Development
cert in your keychain.

## One-time setup

1. Make sure you have an **Apple Development** cert in your login keychain
   (the one Xcode auto-creates when you sign in with your Apple ID under
   Xcode → Settings → Accounts → Manage Certificates → +). Verify with:
   ```
   security find-identity -p codesigning -v
   ```
   You should see a line like:
   ```
   1) 7055A9EDD1434A8B76AED162032D74633E1CC41D "Apple Development: Your Name (TEAMID12345)"
   ```
2. If your identity string is different from the default in
   `dev-codesign.sh`, set it via env var (see "Custom identity" below).

That's it. Next `npm run tauri dev` will sign the dev binary with this cert
before launching.

## What to expect on first launch

You'll get one keychain prompt **per keychain slot the app uses** (Slack bot
token, Slack app token, pinkfish.client_id, pinkfish.client_secret, …). Click
**Always Allow** on each. They'll only appear once because the partition is
now bound to your stable Team ID, not the rebuild-specific CDHash.

You may also see a one-time `codesign wants to sign using key ...` prompt —
"Always Allow" that one too, so future rebuilds sign silently.

After those clicks, all subsequent `tauri dev` runs are silent — across
rebuilds, worktrees, reboots, anything.

## If old prompts still show up

Existing keychain entries written before you switched to the Apple Dev cert
are bound to the old partition list (self-signed CDHashes). Delete them once
and let the app rewrite them — the new entries will bind to your Team ID.

```
while security delete-generic-password -s ai.pinkfish.openit >/dev/null 2>&1; do :; done
```

The loop is needed because `delete-generic-password -s` only deletes one
slot at a time, and the app uses multiple (Slack, Pinkfish OAuth, etc.).

If you're still being prompted on every rebuild after deleting and clicking
Always Allow, double-check that the binary is actually being signed with the
Apple Dev cert:
```
codesign -dvvv src-tauri/target/debug/openit-app 2>&1 | grep -E "Authority|TeamIdentifier"
```
You want `Authority=Apple Development: ...` and `TeamIdentifier=<your team>`.
If TeamIdentifier shows `not set`, you're still signing with a self-signed
cert and the partition fix won't kick in.

## Custom identity

The script defaults to a specific identity string. If yours differs, override
via env var before `npm run tauri dev`:

```
export OPENIT_DEV_SIGNING_IDENTITY="Apple Development: Your Name (YOURTEAMID)"
```

(Match the exact string from `security find-identity -p codesigning -v`,
including the parens around the Team ID.)

## What if I skip the setup?

`dev-codesign.sh` falls back to running unsigned with a warning — dev still
works, you just keep getting keychain prompts on every rebuild.

## Why self-signed certs don't fix this

Older versions of this README walked you through creating a self-signed
`OpenIT Dev` cert. That fixes the *application ACL* check (designated
requirement matches across rebuilds) but **not** the partition list check.
Self-signed certs have no Team ID, so the partition list is populated with
per-CDHash entries — and CDHash changes every rebuild. The prompts come back.

Apple Development certs carry a Team ID, which is what the partition list
actually keys on for non-Apple-signed binaries. That's the only thing that
makes "Always Allow" persist for self-built dev binaries on modern macOS.
