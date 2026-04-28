import { useEffect, useMemo, useRef, useState } from "react";
import { injectIntoChat } from "../lib/skillCanvas";

type Action = {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Run" | "Connect" | "Sync";
  shortcut?: string;
  run: () => void | Promise<void>;
};

export function CommandPalette({
  open,
  onClose,
  onConnectCloud,
  onConnectSlack,
  onManualPull,
  onOpenWelcome,
  onSwitchToSync,
}: {
  open: boolean;
  onClose: () => void;
  onConnectCloud: () => void;
  onConnectSlack: () => void;
  onManualPull: () => void;
  onOpenWelcome: () => void;
  onSwitchToSync: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions: Action[] = useMemo(
    () => [
      {
        id: "welcome",
        label: "Open Welcome",
        hint: "Show the getting-started doc",
        group: "Navigate",
        run: () => onOpenWelcome(),
      },
      {
        id: "sync-tab",
        label: "Open Sync panel",
        hint: "See pending changes",
        group: "Navigate",
        run: () => onSwitchToSync(),
      },
      {
        id: "reports",
        label: "Run /reports weekly-digest",
        hint: "Generate the weekly digest",
        group: "Run",
        run: async () => { await injectIntoChat("/reports weekly-digest"); },
      },
      {
        id: "access",
        label: "Run /access map",
        hint: "Map who has access to what",
        group: "Run",
        run: async () => { await injectIntoChat("/access map"); },
      },
      {
        id: "people",
        label: "Run /people",
        hint: "Open the people directory",
        group: "Run",
        run: async () => { await injectIntoChat("/people"); },
      },
      {
        id: "connect-cloud",
        label: "Connect to Pinkfish Cloud",
        hint: "Sign in & sync",
        group: "Connect",
        run: () => onConnectCloud(),
      },
      {
        id: "connect-slack",
        label: "Connect Slack",
        hint: "Set up the OpenIT bot",
        group: "Connect",
        run: () => onConnectSlack(),
      },
      {
        id: "pull",
        label: "Pull from Pinkfish",
        hint: "Refresh from cloud now",
        group: "Sync",
        run: () => onManualPull(),
      },
    ],
    [onConnectCloud, onConnectSlack, onManualPull, onOpenWelcome, onSwitchToSync],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.hint?.toLowerCase().includes(q) ?? false) ||
        a.group.toLowerCase().includes(q),
    );
  }, [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const runActive = async () => {
    const a = filtered[active];
    if (!a) return;
    onClose();
    try {
      await a.run();
    } catch (e) {
      console.warn("[command-palette] action failed:", e);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void runActive();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Group filtered results
  const groups: Record<string, { action: Action; index: number }[]> = {};
  filtered.forEach((a, i) => {
    if (!groups[a.group]) groups[a.group] = [];
    groups[a.group].push({ action: a, index: i });
  });

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-search">
          <span className="cmdk-search-icon" aria-hidden>⌘</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="What do you want to do?"
          />
          <span className="cmdk-esc" onClick={onClose}>esc</span>
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 ? (
            <div className="cmdk-empty">
              No matches. Try <em>"connect"</em>, <em>"reports"</em>, <em>"sync"</em>.
            </div>
          ) : (
            Object.entries(groups).map(([group, items]) => (
              <div key={group} className="cmdk-group">
                <div className="cmdk-group-label">{group}</div>
                {items.map(({ action: a, index }) => (
                  <button
                    key={a.id}
                    className={`cmdk-item ${index === active ? "active" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      setActive(index);
                      void runActive();
                    }}
                  >
                    <span className="cmdk-item-label">{a.label}</span>
                    {a.hint && <span className="cmdk-item-hint">{a.hint}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cmdk-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
          <span className="cmdk-footer-brand">OpenIT</span>
        </div>
      </div>
    </div>
  );
}
