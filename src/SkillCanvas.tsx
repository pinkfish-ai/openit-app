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
  slackListenerStart,
  slackListenerStatus,
  slackValidateBotToken,
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

  // Bot token staged in component state between the bot-token-input
  // step (paste-as-you-copy from Slack's Install App page) and the
  // app-token-input step (paste-as-you-generate the app-level
  // token). Held in memory only — never persisted to disk except
  // via Keychain in the eventual slack_connect call. Survives
  // canvas re-renders from state-file watcher updates; lost on
  // dismiss/remount, in which case the user re-pastes (annoying
  // but not catastrophic, and Keychain is the only durable home
  // for tokens anyway).
  const [stagedBotToken, setStagedBotToken] = useState<string | null>(null);

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
            stagedBotToken={stagedBotToken}
            setStagedBotToken={setStagedBotToken}
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
  stagedBotToken,
  setStagedBotToken,
}: {
  step: SkillStep;
  isActive: boolean;
  repo: string;
  orgId: string;
  intakeUrl: string;
  skill: string;
  currentState: SkillCanvasState;
  stagedBotToken: string | null;
  setStagedBotToken: (t: string | null) => void;
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
        {isActive && step.body && (
          <div className="skill-step-text">
            <RichText markdown={step.body} />
          </div>
        )}
        {isActive && step.action && (
          <div className="skill-step-action">
            {renderAction(step.action, {
              repo,
              orgId,
              intakeUrl,
              skill,
              currentState,
              stagedBotToken,
              setStagedBotToken,
            })}
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
    stagedBotToken: string | null;
    setStagedBotToken: (t: string | null) => void;
  },
) {
  switch (action.kind) {
    case "copy-manifest":
      return <CopyManifestAction label={action.label} />;
    case "token-input":
      return <TokenInputAction {...ctx} />;
    case "bot-token-input":
      return (
        <BotTokenInputAction
          stagedBotToken={ctx.stagedBotToken}
          setStagedBotToken={ctx.setStagedBotToken}
        />
      );
    case "app-token-input":
      return (
        <AppTokenInputAction
          repo={ctx.repo}
          orgId={ctx.orgId}
          intakeUrl={ctx.intakeUrl}
          stagedBotToken={ctx.stagedBotToken}
          setStagedBotToken={ctx.setStagedBotToken}
        />
      );
    case "verify-dm":
      return (
        <VerifyDmAction
          defaultEmail={action.defaultEmail}
          repo={ctx.repo}
          orgId={ctx.orgId}
          intakeUrl={ctx.intakeUrl}
        />
      );
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

/// Step 2's input — paste the xoxb- bot token as soon as you've
/// copied it from Slack's Install App page. Validates against
/// auth.test (no storage), then stages the token in canvas-level
/// state for step 3 to combine with the app token. Shows
/// "Validated for <workspace> as @<bot>" inline so the user knows
/// the paste landed before moving on.
function BotTokenInputAction({
  stagedBotToken,
  setStagedBotToken,
}: {
  stagedBotToken: string | null;
  setStagedBotToken: (t: string | null) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ workspace: string; bot: string } | null>(
    stagedBotToken
      ? { workspace: "(staged)", bot: "(staged)" } // re-render after navigation; keep an indicator that token is held
      : null,
  );
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setError(null);
    if (!token.trim().startsWith("xoxb-")) {
      setError("Bot token should start with xoxb-");
      return;
    }
    setBusy(true);
    try {
      const validated = await slackValidateBotToken(token.trim());
      setStagedBotToken(token.trim());
      setMeta({
        workspace: validated.workspace_name,
        bot: validated.bot_name,
      });
      setToken("");
      await injectIntoChat(
        `(canvas) bot token validated for ${validated.workspace_name} as @${validated.bot_name}. Please mark the install step done and advance to the app-token step.`,
      );
    } catch (e) {
      setError(`Validate failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setStagedBotToken(null);
    setMeta(null);
    setError(null);
  }

  if (meta) {
    return (
      <div className="skill-action-token-input">
        <p className="skill-action-success">
          ✓ Bot token validated for <strong>{meta.workspace}</strong> as @
          {meta.bot}. Hold here while you generate the app-level token in the
          next step.
        </p>
        <button
          type="button"
          className="skill-action-secondary"
          onClick={clear}
        >
          Paste a different token
        </button>
      </div>
    );
  }

  return (
    <div className="skill-action-token-input">
      <label className="skill-action-field">
        <span>Bot User OAuth Token</span>
        <input
          type="password"
          placeholder="xoxb-..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
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
        {busy ? "Validating with Slack…" : "Save bot token"}
      </button>
      {error && <p className="skill-action-error">{error}</p>}
    </div>
  );
}

/// Step 3's input — paste the xapp- app-level token. Two atomic
/// halves so the user finds out about a bad app token immediately
/// (not 5s later from a polling effect):
///
///   1. slack_connect — combines with the staged bot token, stores
///      both in Keychain, writes .openit/slack.json. Validates
///      the bot token (auth.test) but NOT the app token; that
///      only fails when the SocketModeClient handshakes.
///   2. slack_listener_start — spawns the bundled Node listener,
///      waits for "socket-mode connected" on stderr (10s timeout).
///      A bad app token surfaces here as a connect failure.
///
/// On success, inject "tokens stored AND listener up" so the skill
/// reports truth instead of "auto-starting" optimism. On failure
/// at the listener-start step, surface the captured error inline
/// and tell the user to fix the app token (or use the recovery
/// path on the verify step).
function AppTokenInputAction({
  repo,
  orgId,
  intakeUrl,
  stagedBotToken,
  setStagedBotToken,
}: {
  repo: string;
  orgId: string;
  intakeUrl: string;
  stagedBotToken: string | null;
  setStagedBotToken: (t: string | null) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "connecting" | "starting">(null);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setError(null);
    if (!stagedBotToken) {
      setError("Paste and save the bot token in the previous step first.");
      return;
    }
    if (!token.trim().startsWith("xapp-")) {
      setError("App token should start with xapp-");
      return;
    }
    setBusy("connecting");
    let meta;
    try {
      meta = await slackConnect({
        repo,
        orgId,
        botToken: stagedBotToken,
        appToken: token.trim(),
      });
      setStagedBotToken(null); // tokens are in keychain now; drop in-memory
    } catch (e) {
      setBusy(null);
      setError(`Connect failed: ${String(e)}`);
      return;
    }
    setBusy("starting");
    try {
      await slackListenerStart({ repo, intakeUrl, orgId });
      setToken("");
      await injectIntoChat(
        `(canvas) tokens stored in Keychain and listener confirmed up. Connected to ${meta.workspace_name} as @${meta.bot_name}. Please mark the app-token step done and advance to verify.`,
      );
    } catch (e) {
      // Slack accepted the bot token (slack_connect succeeded) but
      // the listener failed — almost always a bad app token caught
      // by SocketModeClient on the first websocket frame. Tell the
      // skill so the chat side reflects reality, and tell the user
      // they can fix the token via the verify-step Start button.
      const msg = String(e);
      await injectIntoChat(
        `(canvas) tokens stored in Keychain BUT listener failed to come up: ${msg}. Most likely cause: the xapp- token is wrong (typo, missing connections:write scope, or never generated). The user can either re-paste a fresh xapp- here or use the Start listener button on the verify step to retry.`,
      );
      setError(`Listener failed to start: ${msg}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="skill-action-token-input">
      {!stagedBotToken && (
        <p className="skill-action-hint">
          Save the bot token in the previous step before generating the app
          token.
        </p>
      )}
      <label className="skill-action-field">
        <span>App-Level Token (Socket Mode)</span>
        <input
          type="password"
          placeholder="xapp-..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="skill-action-primary"
        onClick={handle}
        disabled={busy !== null || !stagedBotToken}
      >
        {busy === "connecting"
          ? "Validating tokens…"
          : busy === "starting"
            ? "Starting listener…"
            : "Connect"}
      </button>
      {error && <p className="skill-action-error">{error}</p>}
    </div>
  );
}

function VerifyDmAction({
  defaultEmail,
  repo,
  orgId,
  intakeUrl,
}: {
  defaultEmail?: string;
  repo: string;
  orgId: string;
  intakeUrl: string;
}) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [busy, setBusy] = useState<null | "sending" | "starting">(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SlackStatus | null>(null);

  // Poll listener status while this action is on-screen so we can
  // disable the send button when the listener isn't running and
  // surface the captured exit error in-canvas.
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

  async function sendIntro() {
    setError(null);
    setSent(false);
    if (!email.trim() || !email.includes("@")) {
      setError("Enter a valid email");
      return;
    }
    setBusy("sending");
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
      setBusy(null);
    }
  }

  /// Recovery path: when the listener is down (failed to start, or
  /// crashed mid-session), let the user retry start-up directly
  /// from this canvas instead of having to bounce out to the
  /// header pill (which doesn't restart anyway — pill click just
  /// re-renders the canvas). On success, status flips to running:
  /// true on the next poll and the Send-intro button enables.
  async function startListener() {
    setError(null);
    setBusy("starting");
    try {
      await slackListenerStart({ repo, intakeUrl, orgId });
      // Force an immediate status read so the UI doesn't wait 2s
      // for the next interval tick.
      const s = await slackListenerStatus();
      setStatus(s);
      await injectIntoChat(
        `(canvas) listener started from the verify step recovery button.`,
      );
    } catch (e) {
      setError(`Start failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const listenerNotRunning = status !== null && !status.running;
  const lastError = status?.last_error ?? null;

  return (
    <div className="skill-action-verify-dm">
      {listenerNotRunning && (
        <div className="skill-action-listener-down">
          <p className="skill-action-error">
            <strong>Listener isn't running.</strong>
            {lastError ? ` Last error: ${lastError}` : ""}
          </p>
          <p className="skill-action-hint">
            Most common cause is a bad app-level token (xapp-) — wrong scope,
            typo, or never generated. Re-check the previous step's token, then
            try starting the listener:
          </p>
          <button
            type="button"
            className="skill-action-primary"
            onClick={startListener}
            disabled={busy !== null}
          >
            {busy === "starting" ? "Starting…" : "Start listener"}
          </button>
        </div>
      )}

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
        onClick={sendIntro}
        disabled={busy !== null || listenerNotRunning}
        title={listenerNotRunning ? "Listener must be running to send intro" : ""}
      >
        {busy === "sending" ? "Sending…" : "Send intro DM"}
      </button>
      {sent && (
        <p className="skill-action-success">
          Sent — check Slack DMs for the bot.
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
// RichText — minimal markdown rendering shared between step bodies
// and the freeform footer. Splits paragraphs on blank lines,
// preserves intra-paragraph newlines (so `1. step\n2. step` reads
// as a list), and renders `inline code`, **bold**, and basic links
// `[text](url)`. The full react-markdown setup is overkill for
// short instruction strings; if a skill ever needs lists / tables /
// images we can graduate to react-markdown (already a project
// dep for the file viewer).
// ---------------------------------------------------------------------------

function FreeformBody({ markdown }: { markdown: string }) {
  return <RichText markdown={markdown} paragraphClassName="skill-canvas-freeform-p" />;
}

function RichText({
  markdown,
  paragraphClassName,
}: {
  markdown: string;
  paragraphClassName?: string;
}) {
  const paragraphs = markdown.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className={paragraphClassName}>
          {renderInlineWithLineBreaks(p)}
        </p>
      ))}
    </>
  );
}

/// Render one paragraph: preserve intra-paragraph `\n` as <br/>
/// so numbered sub-steps (`1. ...\n2. ...`) render line-by-line,
/// then run inline-code / bold parsing per line.
function renderInlineWithLineBreaks(text: string): React.ReactNode[] {
  const lines = text.split(/\n/);
  const out: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`br-${i}`} />);
    out.push(...renderInline(line, `${i}-`));
  });
  return out;
}

/// Tokenize one line for inline `code` and **bold**. Order matters:
/// code first (so backticks inside bold don't get re-parsed), then
/// bold over what's left.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // Tokenize on `code` first.
  const codeRe = /`([^`]+)`/g;
  const out: React.ReactNode[] = [];
  let lastEnd = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > lastEnd) {
      pushBoldOrText(text.slice(lastEnd, m.index), out, `${keyPrefix}t${key++}`);
    }
    out.push(<code key={`${keyPrefix}c${key++}`}>{m[1]}</code>);
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    pushBoldOrText(text.slice(lastEnd), out, `${keyPrefix}t${key++}`);
  }
  return out;
}

function pushBoldOrText(text: string, out: React.ReactNode[], baseKey: string) {
  const boldRe = /\*\*([^*]+)\*\*/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > lastEnd) out.push(text.slice(lastEnd, m.index));
    out.push(<strong key={`${baseKey}b${key++}`}>{m[1]}</strong>);
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) out.push(text.slice(lastEnd));
}

// Re-export so callers can also clear the state file when the skill
// completes / user disconnects.
export { skillStateClear };
