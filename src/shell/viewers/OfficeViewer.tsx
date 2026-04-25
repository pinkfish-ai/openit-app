type Props = {
  url?: string;
  filename: string;
};

export function OfficeViewer({ url, filename: _filename }: Props) {
  if (!url) {
    return (
      <div className="office-viewer">
        <p>
          Preview not available for local files. Upload to Pinkfish to enable
          preview.
        </p>
      </div>
    );
  }

  const embedUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;

  return (
    <div className="office-viewer">
      <iframe
        src={embedUrl}
        title="Office document preview"
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    </div>
  );
}
