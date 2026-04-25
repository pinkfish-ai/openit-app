import { useEffect, useMemo, useState } from "react";

type Props = {
  data: Uint8Array;
  mimeType: string;
};

export function ImageViewer({ data, mimeType }: Props) {
  const [fitToPane, setFitToPane] = useState(true);

  const objectUrl = useMemo(() => {
    const blob = new Blob([data], { type: mimeType });
    return URL.createObjectURL(blob);
  }, [data, mimeType]);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  return (
    <div className="image-viewer">
      <img
        src={objectUrl}
        alt=""
        onClick={() => setFitToPane((prev) => !prev)}
        style={
          fitToPane
            ? { objectFit: "contain", maxWidth: "100%", maxHeight: "100%" }
            : { objectFit: "none", cursor: "zoom-out" }
        }
      />
    </div>
  );
}
