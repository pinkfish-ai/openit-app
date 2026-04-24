import { writeToActiveSession } from "./activeSession";

export type Bubble = { label: string; prompt: string };

const DEFAULT_BUBBLES: Bubble[] = [
  { label: "Reports", prompt: "/reports weekly-digest" },
  { label: "Access", prompt: "/access map" },
  { label: "People", prompt: "/people" },
];

export function PromptBubbles({ bubbles = DEFAULT_BUBBLES }: { bubbles?: Bubble[] }) {
  const click = (b: Bubble) => {
    // Insert the prompt at the cursor; user reviews and presses Enter to send.
    writeToActiveSession(b.prompt).catch((e) => console.error("bubble write failed:", e));
  };

  return (
    <div className="prompt-bubbles" role="toolbar" aria-label="Prompt bubbles">
      {bubbles.map((b) => (
        <button
          key={b.label}
          type="button"
          className="bubble"
          onClick={() => click(b)}
          title={b.prompt}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
