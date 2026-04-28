// Skill Canvas — TypeScript schema + Tauri API wrappers.
//
// The canvas is OpenIT's primary interactive surface. The shared
// state file at <repo>/.openit/skill-state/<skill>.json is the
// source of truth between Claude (orchestrator) and React
// (renderer). See auto-dev/plans/2026-04-27-skill-canvas-plan.md
// for the full design.
//
// This module owns:
//   - The TS shape of a skill state file (mirrored in the
//     skill-side markdown so Claude knows what to write).
//   - Wrappers around the three Tauri commands.
//   - A tiny helper for the bubble/pill click pattern that injects
//     a slash command into the active Claude session.

import { invoke } from "@tauri-apps/api/core";
import { writeToActiveSession } from "../shell/activeSession";

export type StepStatus = "pending" | "active" | "completed" | "skipped";

/// Discriminated union of action kinds the canvas knows how to
/// render. A step with no `action` renders as just title + body.
/// Adding a new kind = (1) new variant here, (2) new <case> in the
/// canvas component's renderAction switch, (3) skill writes a
/// state with that kind.
export type SkillAction =
  | {
      kind: "copy-manifest";
      /// Optional override label. Defaults to "Copy Slack app manifest".
      label?: string;
    }
  | {
      kind: "token-input";
      /// What to do when the user clicks Connect. The canvas calls
      /// the matching Tauri command directly; the skill is told
      /// what happened via a follow-up injected prompt.
    }
  | {
      kind: "verify-dm";
      /// Default email pre-filled into the input (e.g. the admin's
      /// own email so they can DM themselves).
      defaultEmail?: string;
    }
  | {
      kind: "link";
      label: string;
      href: string;
    }
  | {
      kind: "button";
      label: string;
      /// Slash command (or any text) to inject into the Claude
      /// session when the user clicks. Use this for "the user has
      /// done X manually, tell Claude to advance".
      injectOnClick: string;
    };

export type SkillStep = {
  id: string;
  title: string;
  status: StepStatus;
  /// Markdown body shown under the step title. Optional.
  body?: string;
  action?: SkillAction;
};

export type SkillCanvasState = {
  /// Stable skill identifier — also the file name under
  /// `.openit/skill-state/`. Must match the skill's slash-command
  /// (without the `/`).
  skill: string;
  title: string;
  subtitle?: string;
  /// When false, the canvas hides. Skill sets this when the user
  /// disconnects or the flow is fully complete.
  active: boolean;
  steps: SkillStep[];
  /// Optional freeform markdown shown beneath the checklist. The
  /// skill uses this for FAQ answers, status notes, etc.
  freeform?: string;
};

export async function skillStateRead(
  repo: string,
  skill: string,
): Promise<SkillCanvasState | null> {
  return invoke("skill_state_read", { repo, skill });
}

export async function skillStateWrite(
  repo: string,
  skill: string,
  state: SkillCanvasState,
): Promise<void> {
  return invoke("skill_state_write", { repo, skill, state });
}

export async function skillStateClear(
  repo: string,
  skill: string,
): Promise<void> {
  return invoke("skill_state_clear", { repo, skill });
}

/// Inject a slash command (or any line of text) into the active
/// Claude PTY. Trailing carriage return commits the line. No-op
/// (with a console warning) when no Claude session is active —
/// callers can show a toast if they want.
export async function injectIntoChat(text: string): Promise<boolean> {
  const trimmed = text.endsWith("\n") || text.endsWith("\r") ? text : `${text}\r`;
  return writeToActiveSession(trimmed);
}

/// Refresh a skill canvas's content (titles, bodies, actions) from
/// the latest defaults while preserving the user's per-step status
/// from the existing on-disk state. Called on every pill click so
/// admins always see the current default content without manual
/// state-file cleanup, but mid-flow progress survives FE updates.
///
/// Matching is by step `id`. Steps in defaults but not in existing
/// → pending. Steps in existing but not in defaults → dropped
/// (ids no longer exist; we trust defaults as the source of
/// truth for which steps are real). The `active` flag and the
/// freeform footer come from defaults; everything else copy-only
/// for matched ids.
export function mergeSkillState(
  existing: SkillCanvasState,
  defaults: SkillCanvasState,
): SkillCanvasState {
  const existingStatusById = new Map(
    existing.steps.map((s) => [s.id, s.status]),
  );
  return {
    ...defaults,
    steps: defaults.steps.map((step) => {
      const previousStatus = existingStatusById.get(step.id);
      if (previousStatus) {
        return { ...step, status: previousStatus };
      }
      return step;
    }),
    // Re-flip to active on refresh (caller already does this for
    // the dismissed-then-reclicked path; doing it here too is a
    // belt-and-suspenders so a stale active:false state never
    // strands the user with a hidden canvas after an update).
    active: true,
  };
}
