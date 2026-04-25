import { useEffect, useMemo, useState } from "react";

type Props = {
  data: Uint8Array;
};

export function PdfViewer({ data }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  const blob = useMemo(() => new Blob([data], { type: "application/pdf" }), [data]);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  if (error) {
    return (
      <div className="pdf-viewer">
        <div className="office-viewer-fallback">
          PDF preview error: {error}
        </div>
      </div>
    );
  }

  if (!objectUrl) return null;

  return (
    <div className="pdf-viewer">
      <iframe
        src={objectUrl}
        style={{ flex: 1, border: "none", width: "100%", height: "100%" }}
        title="PDF viewer"
        onError={() => setError("Failed to load PDF")}
      />
    </div>
  );
}
