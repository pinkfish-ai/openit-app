import { writeToActiveSession } from "./activeSession";

export type Bubble = { label: string; prompt: string; variant?: "default" | "conflict" };

const DEFAULT_BUBBLES: Bubble[] = [
  { label: "Reports", prompt: "/reports weekly-digest" },
  { label: "Access", prompt: "/access map" },
  { label: "People", prompt: "/people" },
];

export function PromptBubbles({
  bubbles = DEFAULT_BUBBLES,
  extraBubbles = [],
}: {
  bubbles?: Bubble[];
  extraBubbles?: Bubble[];
}) {
  const merged = [...bubbles, ...extraBubbles];

  const click = (b: Bubble) => {
    writeToActiveSession(b.prompt).catch((e) => console.error("bubble write failed:", e));
  };

  return (
    <div className="prompt-bubbles" role="toolbar" aria-label="Prompt bubbles">
      {merged.map((b, i) => (
        <button
          key={`${b.label}-${i}`}
          type="button"
          className={`bubble ${b.variant === "conflict" ? "bubble-conflict" : ""}`}
          onClick={() => click(b)}
          title={b.prompt}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
