// Renders a row of attachment previews for a single conversation
// turn. Mirrors the web chat's inline rendering: image attachments
// preview inline; everything else surfaces as a click-to-open chip.
//
// Image bytes are loaded via `fsReadBytes` and turned into blob URLs
// because the WebKit content origin (`tauri://localhost`) can't
// `<img src="/Users/...">` directly. Non-image links open in the OS
// default handler via Tauri's openUrl plugin (file:// URL).

import { useEffect, useState } from "react";
import { fsOpen, fsReadBytes } from "../lib/api";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function AttachmentImage({ absPath, label }: { absPath: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const bytes = await fsReadBytes(absPath);
        if (cancelled) return;
        // Sniff a likely MIME from the extension; the actual type
        // doesn't matter much for `<img>` rendering, but blob URLs
        // round-trip mime headers to anything that consumes them
        // later (e.g. drag back out of the app).
        const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
        const mime =
          ext === "png" ? "image/png" :
          ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
          ext === "gif" ? "image/gif" :
          ext === "webp" ? "image/webp" :
          ext === "svg" ? "image/svg+xml" :
          "application/octet-stream";
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [absPath]);
  if (error) {
    return (
      <span className="attach-chip attach-chip-error" title={error}>
        ⚠ {label}
      </span>
    );
  }
  if (!url) {
    return <span className="attach-chip">Loading {label}…</span>;
  }
  return (
    <button
      type="button"
      className="attach-image-btn"
      onClick={() => {
        // Open in the OS handler via openUrl — the in-app webview
        // can't navigate to a blob URL of arbitrary type cleanly,
        // and a full-screen modal would be a different feature.
        void fsOpen(absPath).catch((err) =>
          console.warn("[attachment] fs_open failed:", err),
        );
      }}
      title={label}
    >
      <img className="attach-image" src={url} alt={label} />
    </button>
  );
}

function AttachmentLink({ absPath, label }: { absPath: string; label: string }) {
  return (
    <button
      type="button"
      className="attach-chip"
      onClick={() => {
        void fsOpen(absPath).catch((err) =>
          console.warn("[attachment] fs_open failed:", err),
        );
      }}
      title={`Open ${label}`}
    >
      <span className="attach-chip-icon">📎</span>
      <span className="attach-chip-name">{label}</span>
    </button>
  );
}

export function AttachmentList({
  attachments,
  repo,
}: {
  attachments: string[];
  repo: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-list">
      {attachments.map((rel) => {
        const abs = `${repo}/${rel}`;
        const label = basename(rel);
        if (IMAGE_EXT.test(rel)) {
          return <AttachmentImage key={rel} absPath={abs} label={label} />;
        }
        return <AttachmentLink key={rel} absPath={abs} label={label} />;
      })}
    </div>
  );
}
