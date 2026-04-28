import { useEffect, useState } from "react";
import { fsReadBytes } from "../lib/api";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export function isImageFile(path: string): boolean {
  return IMAGE_EXT.test(path);
}

/**
 * 30x30 image thumbnail for entity-card glyph slots. Reads the file
 * via fsReadBytes and renders it as a blob URL — same pattern the
 * inline conversation attachments use, since the WebKit content
 * origin can't load `<img src="/Users/…">` directly.
 *
 * Falls back to nothing while loading or if the read fails; the
 * caller should keep the kind icon as a default for non-image files
 * (this component is only mounted when isImageFile returns true).
 */
export function FileThumbnail({ absPath }: { absPath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const bytes = await fsReadBytes(absPath);
        if (cancelled) return;
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
      } catch {
        /* unreadable — leave url null, parent shows the kind glyph */
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [absPath]);
  if (!url) return null;
  return <img className="file-thumb" src={url} alt="" />;
}
