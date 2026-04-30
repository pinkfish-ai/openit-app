import { useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Button } from "../../ui";

// Bundle the worker locally via Vite — avoids CDN fetch that Tauri blocks
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Props = {
  data: Uint8Array;
};

export function PdfViewer({ data }: Props) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);

  // react-pdf needs { data: ArrayBuffer }
  const file = useMemo(
    () => ({
      data: data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer,
    }),
    [data],
  );

  if (error) {
    return (
      <div className="pdf-viewer">
        <div className="office-viewer-fallback">
          PDF preview error: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-controls">
        <Button
          variant="secondary"
          size="sm"
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber((p) => p - 1)}
        >
          Prev
        </Button>
        <span>
          Page {pageNumber} of {numPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={pageNumber >= numPages}
          onClick={() => setPageNumber((p) => p + 1)}
        >
          Next
        </Button>
      </div>
      <div className="pdf-viewer-page">
        <Document
          file={file}
          onLoadSuccess={({ numPages: n }) => {
            setNumPages(n);
            setPageNumber(1);
          }}
          onLoadError={(err) => setError(String(err?.message ?? err))}
        >
          <Page pageNumber={pageNumber} />
        </Document>
      </div>
    </div>
  );
}
