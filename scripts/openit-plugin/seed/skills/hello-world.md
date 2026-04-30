---
name: hello-world
description: Sample skill — Claude greets the admin and lists the next three resolved tickets that don't have a KB article yet. A starter shape for what /conversation-to-automation produces; safe to delete or rewrite.
requires_admin: true
---

# Hello, world (sample skill)

This is a sample skill that landed via "Create sample dataset" on the
getting-started page. It demonstrates the shape `/conversation-to-automation`
produces when it captures a multi-step admin workflow as a skill.

## When to use

Slash-invoke `/hello-world` from the desktop Claude pane. Useful as a
"does my OpenIT setup work?" check before you wire anything real.

## Steps

1. Greet the admin by name (read `git config user.name` if available;
   fall back to "admin").
2. Walk `databases/tickets/`, sort by `updatedAt` descending, find the
   three most recently `resolved` tickets.
3. For each one, list its subject and check whether
   `knowledge-bases/default/` has an article whose title matches any
   substantial word from the ticket subject.
4. Surface the gap in chat: *"Of your last 3 resolved tickets, N have
   no matching KB article — Mark as resolved them again to capture, or
   ask me to draft articles for them."*
5. Stop. This is a sample; no destructive actions.

## What this is for

Skills are how OpenIT remembers admin workflows. The real ones are
captured automatically when you click "Mark as resolved" on a ticket —
this one's just here to prove the path works end-to-end. Delete it
when you're ready, or rewrite it as a real skill for your own first
recurring workflow.
