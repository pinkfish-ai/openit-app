import { Button } from "../ui";
import { writeToActiveSession } from "./activeSession";

export type Bubble = { label: string; prompt: string; variant?: "default" | "conflict" };

const DEFAULT_BUBBLES: Bubble[] = [
  { label: "Reports", prompt: "/reports weekly-digest" },
  { label: "Access", prompt: "/access map" },
  { label: "People", prompt: "/people" },
];

/** Prompt bubbles — quick-action chips at the bottom of the chat
 *  pane that paste a slash command into Claude. Visually subtle
 *  (uses the Button "subtle" variant which adapts to the dark chat
 *  surface via currentColor); the special "conflict" variant flips
 *  to a destructive tone when surfaced from the conflict banner. */
export function PromptBubbles({
  bubbles = DEFAULT_BUBBLES,
  extraBubbles = [],
}: {
  bubbles?: Bubble[];
  extraBubbles?: Bubble[];
}) {
  const merged = [...bubbles, ...extraBubbles];

  const click = (b: Bubble) => {
    writeToActiveSession(b.prompt).catch((e) =>
      console.error("bubble write failed:", e),
    );
  };

  return (
    <div className="prompt-bubbles" role="toolbar" aria-label="Prompt bubbles">
      {merged.map((b, i) => (
        <Button
          key={`${b.label}-${i}`}
          variant="subtle"
          size="sm"
          tone={b.variant === "conflict" ? "destructive" : "default"}
          onClick={() => click(b)}
          title={b.prompt}
        >
          {b.label}
        </Button>
      ))}
    </div>
  );
}
