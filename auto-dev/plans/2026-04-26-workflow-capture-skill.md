# 2026-04-26 — Workflow capture skill (Phase C)

**Status:** Draft. Stacks on `feat/escalated-ticket-banner` (Phase B).

## Why

Phase B handles answer-shaped escalations: admin writes a reply, Claude captures it as a KB article, next identical question gets auto-answered. But some tickets are action-shaped — "reset my VPN password", "give me access to staging GCP", "provision a Slack channel for project X" — and a KB article doesn't help: the admin still has to do the work next time.

Phase C closes that loop by turning the admin's *actions* into a Pinkfish workflow JSON. After the admin handles an action-shaped ticket, Claude offers to capture the steps as a workflow that future identical requests run on autopilot.

## What

Two pieces (skill-only V1):

1. **`capture-workflow` skill** (`scripts/openit-plugin/skills/capture-workflow.md`):
   - Read the ticket; map field IDs to plain language via `_schema.json`.
   - Reconstruct the admin's actions from the recent chat / tool-call history.
   - Confirm a trigger pattern with the admin (what kind of incoming ticket should match this workflow).
   - Draft a workflow JSON in `workflows/<kebab-case-name>.json` with the trigger + steps + any human-approval checkpoints.
   - Show the diff before writing; tell the admin how to push and how to verify.

2. **`answer-ticket` update**: route action-shaped tickets to `capture-workflow`. The skill body now distinguishes answer-shaped (capture as KB article) vs action-shaped (capture as workflow) and asks the admin which it is.

## What this PR does NOT do

- **Auto-route incoming tickets** to a captured workflow. The triage agent's instructions still say "search KB and escalate if unsure"; teaching it to recognize action-shape patterns and pick the right workflow is V2 (Phase C.5 or its own PR).
- **Workflow runtime integration.** Pinkfish workflow infrastructure already exists (`workflow_run` gateway tool, `pinkfish-sidekick` server). The skill lands a workflow JSON; running it is independent of this PR.
- **Captured-workflow registry.** No special index file; workflows are just JSON files in `workflows/`. The triage agent can read them directly when it learns to use them.

## Testing

The skill is markdown only — no code paths to unit-test. Manual validation:

- Stage an action-shaped ticket (e.g., `f_<question>: "Please give me access to the staging GCP project"`, status: open).
- Click "Solve with Claude" → answer-ticket invocation lands.
- When Claude asks "answer or action?", say action.
- Confirm Claude invokes `capture-workflow` → walks the trigger pattern + steps prompts → writes `workflows/<name>.json`.
- Push via `deploy`. Verify the workflow file lands in Pinkfish.

## Out of scope

- All of the above. The full autopilot loop ("triage agent matches incoming ticket → invokes captured workflow → user gets the action without admin involvement") needs the V2 routing piece. This PR ships the *capture* half of the cycle.
