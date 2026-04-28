// Skill Canvas — primary interactive surface in OpenIT's center
// pane. Renders a state file written by the skill (Claude side) as
// a checklist with the contextual action inline under the active
// step. User actions (paste tokens, click button, copy YAML) call
// the relevant Tauri command directly AND inject a short prompt
// into the Claude session so the orchestrator knows progress was
// made out-of-band.
//
// One canvas at a time per project. The skill writes
// .openit/skill-state/<skill>.json; the existing fs watcher fires;
// App.tsx re-reads and passes us the new state.
//
// Adding a new action kind = (1) extend SkillAction in
// lib/skillCanvas.ts, (2) add a case to renderAction below.

import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type SkillAction,
  type SkillCanvasState,
  type SkillStep,
  injectIntoChat,
  skillStateClear,
  skillStateWrite,
} from "./lib/skillCanvas";
import { SLACK_APP_MANIFEST } from "./lib/slackManifest";
import {
  type SlackStatus,
  slackConnect,
  slackListenerSendIntro,
  slackListenerStatus,
} from "./lib/api";
import "./SkillCanvas.css";

type Props = {
  repo: string;
  orgId: string;
  intakeUrl: string;
  state: SkillCanvasState;
  onClosed: () => void;
};

export function SkillCanvas({
  repo,
  orgId,
  intakeUrl,
  state,
  onClosed,
}: Props) {
  const activeStep = useMemo(
    () => state.steps.find((s) => s.status === "active") ?? null,
    [state.steps],
  );

  async function dismiss() {
    // Soft-close: flip `active: false`, keep the file around so
    // re-running the skill resumes from where we were. Skill can
    // call skillStateClear later (e.g. on disconnect) to fully
    // wipe.
    await skillStateWrite(repo, state.skill, { ...state, active: false });
    onClosed();
  }

  return (
    <div className="skill-canvas">
      <header className="skill-canvas-header">
        <div>
          <h1 className="skill-canvas-title">{state.title}</h1>
          {state.subtitle && (
            <p className="skill-canvas-subtitle">{state.subtitle}</p>
          )}
        </div>
        <button
          type="button"
          className="skill-canvas-dismiss"
          onClick={dismiss}
          title="Close the canvas. Re-run the skill to resume."
        >
          ×
        </button>
      </header>

      <ol className="skill-canvas-steps">
        {state.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            isActive={activeStep?.id === step.id}
            repo={repo}
            orgId={orgId}
            intakeUrl={intakeUrl}
            skill={state.skill}
            currentState={state}
          />
        ))}
      </ol>

      {state.freeform && (
        <section className="skill-canvas-freeform">
          <FreeformBody markdown={state.freeform} />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One step row — title, status pill, body, contextual action.
// ---------------------------------------------------------------------------

function StepRow({
  step,
  isActive,
  repo,
  orgId,
  intakeUrl,
  skill,
  currentState,
}: {
  step: SkillStep;
  isActive: boolean;
  repo: string;
  orgId: string;
  intakeUrl: string;
  skill: string;
  currentState: SkillCanvasState;
}) {
  async function toggleManually() {
    // Manual checkbox click: flip status between completed and
    // active/pending. Inject a prompt so Claude can react.
    const next = step.status === "completed" ? "active" : "completed";
    const updated: SkillCanvasState = {
      ...currentState,
      steps: currentState.steps.map((s) =>
        s.id === step.id ? { ...s, status: next } : s,
      ),
    };
    await skillStateWrite(repo, skill, updated);
    await injectIntoChat(
      next === "completed"
        ? `(canvas) marked '${step.title}' as done`
        : `(canvas) un-checked '${step.title}'`,
    );
  }

  return (
    <li
      className={`skill-step skill-step-${step.status} ${
        isActive ? "skill-step-active-row" : ""
      }`}
    >
      <button
        type="button"
        className="skill-step-checkbox"
        onClick={toggleManually}
        aria-label={`Mark '${step.title}' as ${
          step.status === "completed" ? "not done" : "done"
        }`}
        title="Click to manually toggle this step"
      >
        {/* Only the completed state renders a glyph (✓). Active and
            pending rely on the bordered/pulsing circle in CSS so the
            three states don't all read as filled radios. */}
        {step.status === "completed" ? "✓" : ""}
      </button>
      <div className="skill-step-body">
        <div className="skill-step-title">{step.title}</div>
        {/* Only the active step gets its body. Completed and pending
            collapse to title-only so the canvas doesn't drown the
            user in instructions for steps they're not on. The trade
            is that a user looking back at "what did I do in step
            2?" loses the body — but the title carries the gist and
            they can click the checkbox to toggle the step active
            again if they want details. */}
        {isActive && step.body && <p className="skill-step-text">{step.body}</p>}
        {isActive && step.action && (
          <div className="skill-step-action">
            {renderAction(step.action, { repo, orgId, intakeUrl, skill, currentState })}
          </div>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

function renderAction(
  action: SkillAction,
  ctx: {
    repo: string;
    orgId: string;
    intakeUrl: string;
    skill: string;
    currentState: SkillCanvasState;
  },
) {
  switch (action.kind) {
    case "copy-manifest":
      return <CopyManifestAction label={action.label} />;
    case "token-input":
      return <TokenInputAction {...ctx} />;
    case "verify-dm":
      return <VerifyDmAction defaultEmail={action.defaultEmail} />;
    case "link":
      return <LinkAction label={action.label} href={action.href} />;
    case "button":
      return (
        <ButtonAction label={action.label} injectOnClick={action.injectOnClick} />
      );
    default:
      // Exhaustiveness guard — TS already enforces it; the runtime
      // branch protects against a malformed state file from a future
      // skill version that the FE hasn't shipped support for yet.
      return (
        <div className="skill-action-unknown">
          (unknown action kind — update OpenIT to render this step)
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Action components
// ---------------------------------------------------------------------------

function CopyManifestAction({ label }: { label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setError(null);
    try {
      await navigator.clipboard.writeText(SLACK_APP_MANIFEST);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4_000);
      await injectIntoChat("(canvas) manifest copied to clipboard");
    } catch (e) {
      setError(`Copy failed: ${String(e)}`);
    }
  }

  return (
    <>
      <button
        type="button"
        className="skill-action-primary"
        onClick={handle}
      >
        {copied ? "✓ Copied to clipboard" : (label ?? "Copy Slack app manifest")}
      </button>
      {error && <p className="skill-action-error">{error}</p>}
    </>
  );
}

function TokenInputAction({
  repo,
  orgId,
}: {
  repo: string;
  orgId: string;
  intakeUrl: string;
  skill: string;
  currentState: SkillCanvasState;
}) {
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setError(null);
    if (!botToken.trim().startsWith("xoxb-")) {
      setError("Bot token should start with xoxb-");
      return;
    }
    if (!appToken.trim().startsWith("xapp-")) {
      setError("App token should start with xapp-");
      return;
    }
    setBusy(true);
    try {
      const meta = await slackConnect({
        repo,
        orgId,
        botToken: botToken.trim(),
        appToken: appToken.trim(),
      });
      setBotToken("");
      setAppToken("");
      await injectIntoChat(
        `(canvas) tokens validated. Connected to ${meta.workspace_name} (${meta.workspace_id}) as @${meta.bot_name}. Please advance the canvas to the verify step.`,
      );
    } catch (e) {
      setError(`Connect failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skill-action-token-input">
      <label className="skill-action-field">
        <span>Bot User OAuth Token</span>
        <input
          type="password"
          placeholder="xoxb-..."
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="skill-action-field">
        <span>App-Level Token (Socket Mode)</span>
        <input
          type="password"
          placeholder="xapp-..."
          value={appToken}
          onChange={(e) => setAppToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="skill-action-primary"
        onClick={handle}
        disabled={busy}
      >
        {busy ? "Validating…" : "Connect"}
      </button>
      {error && <p className="skill-action-error">{error}</p>}
    </div>
  );
}

function VerifyDmAction({ defaultEmail }: { defaultEmail?: string }) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SlackStatus | null>(null);

  // Poll listener status while this action is on-screen so we can
  // disable the send button when the listener isn't running and
  // tell the user why.
  useEffect(() => {
    let mounted = true;
    const tick = () =>
      slackListenerStatus()
        .then((s) => {
          if (mounted) setStatus(s);
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, 2_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  async function handle() {
    setError(null);
    setSent(false);
    if (!email.trim() || !email.includes("@")) {
      setError("Enter a valid email");
      return;
    }
    setBusy(true);
    try {
      await slackListenerSendIntro({
        targetEmail: email.trim(),
        text:
          "Hi! I'm the OpenIT triage bot. Try asking me a question — e.g. \"how do I reset my Mac password?\" — and I'll either answer from your knowledge base or escalate to your IT team.",
      });
      setSent(true);
      await injectIntoChat(
        `(canvas) intro DM sent to ${email.trim()}. Asker should see it in Slack now.`,
      );
    } catch (e) {
      setError(`Send failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const listenerNotRunning = status !== null && !status.running;

  return (
    <div className="skill-action-verify-dm">
      <label className="skill-action-field">
        <span>Slack user email to DM</span>
        <input
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="skill-action-primary"
        onClick={handle}
        disabled={busy || listenerNotRunning}
        title={listenerNotRunning ? "Listener must be running to send intro" : ""}
      >
        {busy ? "Sending…" : "Send intro DM"}
      </button>
      {sent && (
        <p className="skill-action-success">
          Sent — check Slack DMs for the bot.
        </p>
      )}
      {listenerNotRunning && (
        <p className="skill-action-error">
          Listener isn't running — restart it from the header pill before
          verifying.
        </p>
      )}
      {error && <p className="skill-action-error">{error}</p>}
    </div>
  );
}

function LinkAction({ label, href }: { label: string; href: string }) {
  return (
    <button
      type="button"
      className="skill-action-secondary"
      onClick={() => openUrl(href).catch((e) => console.warn("openUrl:", e))}
    >
      {label} ↗
    </button>
  );
}

function ButtonAction({
  label,
  injectOnClick,
}: {
  label: string;
  injectOnClick: string;
}) {
  return (
    <button
      type="button"
      className="skill-action-secondary"
      onClick={() => injectIntoChat(injectOnClick)}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Freeform body — minimal markdown rendering. The full
// react-markdown setup is overkill for skill state freeform text;
// we render paragraphs split on blank lines and respect basic
// inline `code` spans. Anything richer can graduate to
// react-markdown later (it's already a project dep for the file
// viewer).
// ---------------------------------------------------------------------------

function FreeformBody({ markdown }: { markdown: string }) {
  const paragraphs = markdown.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className="skill-canvas-freeform-p">
          {renderInlineCode(p)}
        </p>
      ))}
    </>
  );
}

function renderInlineCode(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastEnd) {
      parts.push(text.slice(lastEnd, m.index));
    }
    parts.push(<code key={`c-${key++}`}>{m[1]}</code>);
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) parts.push(text.slice(lastEnd));
  return parts;
}

// Re-export so callers can also clear the state file when the skill
// completes / user disconnects.
export { skillStateClear };
