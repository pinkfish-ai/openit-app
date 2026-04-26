# 2026-04-26 — Triage agent bootstrap

**Status:** Draft.

## Why

OpenIT bootstraps default datastores (`openit-tickets`, `openit-people`) and a default filestore (`openit-docs`) for every new connect. Agents are still empty. The user's first question — "send a question to an agent and have it answer or escalate" — hits a dead end because there's no agent to talk to.

This adds an auto-created triage agent (`openit-triage-<orgId>`) as part of the connect bootstrap, mirroring the datastore/filestore defaults pattern. The agent is configured to:

1. **Always log the ticket** in `openit-tickets-<orgId>` so there's a paper trail.
2. **Search the knowledge base** for an answer.
3. **Reply with the answer** if one is found, or escalate (status: open, flagged for human) if not.

End-to-end, the user can ask a question → triage agent picks it up → KB answer or escalation.

## What

A new `resolveOrCreateTriageAgent(creds, onLog)` function in `agentSync.ts` paralleling `resolveProjectDatastores`/`resolveProjectFilestores`:

1. List existing agents (`/service/useragents`).
2. If an agent named `openit-triage-<orgId>` exists, return it (idempotent).
3. Otherwise POST `/service/useragents` with a minimal-but-functional triage payload:
   - `name: "openit-triage-<orgId>"`
   - `description: "Triage IT tickets — check KB, answer if found, log + escalate if not."`
   - `instructions`: detailed steps (see below)
   - `selectedModel: "sonnet"`
   - All resource arrays empty (the agent uses the Pinkfish gateway for KB and datastore access; explicit resource bindings + API key plumbing is V2).

Hook the call into `startAgentSync` before the first pull tick — the new agent will then surface in the next `listRemote` and land on disk via the existing engine.

## Instructions text (the agent's brain)

The agent's instructions need to deliver the whole flow by gateway tool calls. Draft:

```
You are openit-triage, an IT helpdesk triage agent.

When a user sends you a question or ticket, do this in order:

1. LOG THE TICKET FIRST. Always create a row in the openit-tickets-<orgId>
   datastore via the datastore-structured MCP (use capabilities_discover →
   gateway_invoke if you don't already know the tool). Include who asked,
   what they asked, when, and a short summary. This happens for EVERY
   question, before any answer or escalation.

2. SEARCH THE KNOWLEDGE BASE. Use knowledge-base_ask (gateway, server
   knowledge-base) with the user's question. Pass the org's KB collection
   when you can identify it.

3. IF THE KB RETURNS A CONFIDENT ANSWER: write a clear, concise reply
   using that information. Update the ticket row with the answer + the
   KB source(s).

4. IF NOT: reply to the user with something like "I don't have an answer
   for that yet — I've logged the question and a human will follow up."
   Update the ticket: status = "open", flagged = true (or whatever the
   schema's "needs human" field is — read _schema.json if unsure).

Rules:
- Never invent answers. If KB doesn't know, escalate.
- Be concise. Lead with the answer or the next step.
- If the question is unclear, ask ONE focused clarifying question before
  logging and searching.
- Always log, always reply.
```

## Implementation plan

1. **`src/lib/agentSync.ts`** — add `resolveOrCreateTriageAgent(creds, onLog)` modeled on the datastore resolve pattern (in-flight dedup, org-scoped cache, cooldown to avoid rapid recreate on multiple polls).
2. **`startAgentSync`** — call `resolveOrCreateTriageAgent` BEFORE the first `tryResolveAndPull`. On success, the next pull picks the agent up.
3. **REST helper** — single `POST /service/useragents` call. Reuse `makeSkillsFetch(token, "bearer")` (matches the existing list call). Body matches `entities.UserAgent` minimal shape per `/web`'s `useSaveAgent.ts` payload pattern.
4. **Logging** — surface "▸ created openit-triage agent" in the modal's onLog so the user sees the bootstrap step happen.

## Tests

- Mock fetch: when list returns no triage agent, POST is called with the right payload.
- Mock fetch: when list returns a triage agent, POST is NOT called (idempotent).
- Mock fetch: error during create is logged but doesn't crash the sync (graceful degradation — the user can still use other entities).
- In-flight dedup: two concurrent calls share one POST.

## Out of scope (V1)

- **Resource bindings** (API key + canRead/canWrite per datastore/KB). The agent uses the gateway to access resources, which works org-wide without per-agent bindings. Adding explicit bindings means a multi-step create flow per `/web`'s `useSaveAgent.ts` (create agent → create API key → save again with bindings). Phase 5b proper.
- **Actually running the agent against incoming tickets** (channels, triggers, agent invocation flow). The agent exists, instructions are right, but routing user input → triage → output is separate work.
- **Updating an existing triage agent's instructions** if we change them in code. The instructions are server-side once created; future updates to the constant won't propagate. Manual edit via web UI for now.
