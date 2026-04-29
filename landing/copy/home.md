# OpenIT — landing copy

## Hero

Status badge: Public Beta · macOS · Open Source

**An IT helpdesk that runs on Claude Code.**

Lede: Claude handles tickets, provisions access, and learns how you work — so you spend your day on the hard problems, not the queue.

CTAs:
- Download for macOS — Beta · Apple Silicon + Intel
- View on GitHub ↗

### Architecture block

**For IT · Desktop app**
Run Claude Code on your desktop.

Install OpenIT on your Mac. Claude works alongside you in the terminal — reading tickets, shaping workflows, writing connectors.

**For employees · Chat**
Ask in Slack, Teams, or email.

No new app to learn. Employees ask wherever they already work — Claude answers, or routes it to you.

---

## §01 — The thesis

### Configure in Claude Code. Not UI.

Every other ITSM is configured the same way: clicky admin screens, proprietary workflow builders, vendor agents you have to learn. The configuration is theirs.

> Claude Code is the operating system.

OpenIT inverts it. You configure in plain English with Claude Code; the result is plain files on your machine. Open them. Edit them. Take them with you.

---

## §02 — Native access

### Every tool. One chat.

Stop logging into five dashboards. Claude has direct access to every system you use — so you ask in one place, and it acts everywhere.

- **Identity** — Okta, Google Workspace, Microsoft Entra
- **Chat** — Slack, Microsoft Teams
- **Endpoints** — Jamf, Kandji, Intune
- **Cloud** — AWS, GCP, Azure
- **Code** — GitHub, GitLab
- **Tickets & docs** — Jira, Linear, Notion, Confluence
- **Anything else** — Claude writes the integration if it's missing

No middleware. No glue scripts. No tab-switching. The investigation, the fix, and the article that documents it all happen in one conversation.

---

## §03 — How it learns

### Answer once. Claude handles the next one.

The first time someone asks something Claude hasn't seen, it escalates to you. After you answer, the moment is captured as a saved automation — so the next time, Claude just handles it.

The chat (illustrated):
- *Marcus:* "i can't log in"
- *OpenIT (escalating to you):* haven't seen this one before
- *You:* "reset your password at company.okta.com/reset"
- **✓ Automation saved — `skills/login-reset.md` · KB article published**
- *(three days later)*
- *Priya:* "can't log in either, what do i do"
- *OpenIT (auto-resolved):* Reset your password at company.okta.com/reset.

Every question Claude can't answer becomes a saved automation. Two weeks in, your queue runs differently.

---

## §04 — What gets saved

### Done once. Saved forever.

Each fix becomes a file you can read, edit, and reuse — plain instructions when that's enough, code when it's not.

**Skill (plain English) — `skills/login-reset.md`**
```
# Login & password reset

When someone says they can't log in:
1. Confirm their email is on file
2. Send the reset link from company.okta.com/reset
3. If no email arrives in 5 min, escalate
```

**Script (for code) — `scripts/offboard.ts`**
```
async function offboard(email) {
  await okta.deactivate(email)
  await jamf.unenroll(email)
  await drive.transferOwnership(email)
  await slack.archiveDMs(email)
}
```

Claude builds them. Then runs them — when you ask, or automatically when a familiar request comes in.

---

## §05 — Local, then cloud

### Try it on your Mac. Deploy when you trust it.

Run OpenIT on your laptop. Real Claude Code, real integrations, real tickets — no paid sandbox.

When it earns your trust, sync to Pinkfish. The same project runs in cloud, 24/7. Slack and Teams stay live, agents act while you sleep, public links stay reachable.

---

## §06 — Status

### Public beta.

macOS (Apple Silicon + Intel), signed and notarized — no first-launch warning. Linux and Windows builds follow.

CTA: Download for macOS — Beta · Apple Silicon + Intel
