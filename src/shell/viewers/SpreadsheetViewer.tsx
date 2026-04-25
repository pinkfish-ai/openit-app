import { useEffect, useState } from "react";
import ExcelJS from "exceljs";

type Props = {
  data: Uint8Array;
  filename: string;
};

type SheetData = {
  name: string;
  headers: string[];
  rows: string[][];
};

function parseCsv(text: string): SheetData {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { name: "Sheet1", headers: [], rows: [] };
  }
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map((line) => line.split(","));
  return { name: "Sheet1", headers, rows };
}

async function parseXlsx(data: Uint8Array): Promise<SheetData[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data.buffer as ArrayBuffer);

  const sheets: SheetData[] = [];
  workbook.eachSheet((worksheet) => {
    const headers: string[] = [];
    const rows: string[][] = [];

    worksheet.eachRow((row, rowNumber) => {
      const values = row.values as (string | number | null)[];
      // ExcelJS row.values is 1-indexed; values[0] is undefined
      const cells = values.slice(1).map((v) => (v != null ? String(v) : ""));

      if (rowNumber === 1) {
        headers.push(...cells);
      } else {
        rows.push(cells);
      }
    });

    sheets.push({ name: worksheet.name, headers, rows });
  });

  return sheets;
}

function isCsv(filename: string): boolean {
  return /\.csv$/i.test(filename);
}

export function SpreadsheetViewer({ data, filename }: Props) {
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (isCsv(filename)) {
      const text = new TextDecoder("utf-8").decode(data);
      setSheets([parseCsv(text)]);
    } else {
      parseXlsx(data)
        .then((result) => {
          if (!cancelled) {
            setSheets(result);
            setActiveSheet(0);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [data, filename]);

  if (error) {
    return <div className="spreadsheet-viewer error">{error}</div>;
  }

  const sheet = sheets[activeSheet];
  if (!sheet) {
    return <div className="spreadsheet-viewer">Loading...</div>;
  }

  return (
    <div className="spreadsheet-viewer">
      {sheets.length > 1 && (
        <div className="spreadsheet-viewer-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              className={i === activeSheet ? "active" : ""}
              onClick={() => setActiveSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <table>
        <thead>
          <tr>
            {sheet.headers.map((header, i) => (
              <th key={i}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
