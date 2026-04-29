/// Tiny typed badge that replaces the generic folder glyph on file
/// cards. The label is the uppercase extension (PDF, MD, PNG, …) so
/// scanning a long list tells you at a glance which entries are
/// runbooks vs screenshots vs scripts. Falls back to "FILE" when the
/// name has no extension.
export function FileTypeBadge({ filename }: { filename: string }) {
  const m = filename.match(/\.([a-z0-9]+)$/i);
  const label = (m?.[1] ?? "file").toUpperCase().slice(0, 4);
  return (
    <span className="entity-card-typebadge" aria-hidden>
      {label}
    </span>
  );
}

/// Human-readable byte count. Stays terse: "12 B", "4.2 KB", "1.7 MB".
/// Returns the empty string for null/undefined so callers can drop it
/// straight into a template without a guard.
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
