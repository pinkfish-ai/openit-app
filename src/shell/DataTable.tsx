import { useMemo, useState } from "react";
import type { DataCollection, MemoryItem } from "../lib/skillsApi";

type Props = {
  collection: DataCollection;
  items: MemoryItem[];
  hasMore?: boolean;
  onLoadMore?: () => void;
};

type SortState = { fieldId: string; direction: "asc" | "desc" } | null;

function formatCell(value: unknown, fieldType: string): string {
  if (value == null) return "";
  if (fieldType === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function DataTable({ collection, items, hasMore, onLoadMore }: Props) {
  const [sort, setSort] = useState<SortState>(null);

  const fields = collection.schema?.fields ?? [];

  const handleHeaderClick = (fieldId: string) => {
    setSort((prev) => {
      if (prev?.fieldId === fieldId) {
        return prev.direction === "asc"
          ? { fieldId, direction: "desc" }
          : null;
      }
      return { fieldId, direction: "asc" };
    });
  };

  const parsedRows = useMemo(() => {
    return items.map((item) => {
      let parsed: Record<string, unknown> = {};
      try {
        if (typeof item.content === "object" && item.content !== null) {
          parsed = item.content as Record<string, unknown>;
        } else if (typeof item.content === "string") {
          parsed = JSON.parse(item.content);
        }
      } catch {
        // content is not valid JSON; leave parsed empty
      }
      return { key: item.key, parsed };
    });
  }, [items]);

  const sortedRows = useMemo(() => {
    if (!sort) return parsedRows;

    const { fieldId, direction } = sort;
    const sorted = [...parsedRows];
    sorted.sort((a, b) => {
      const aVal = fieldId === "key" ? a.key : a.parsed[fieldId];
      const bVal = fieldId === "key" ? b.key : b.parsed[fieldId];

      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      if (typeof aVal === "number" && typeof bVal === "number") {
        return direction === "asc" ? aVal - bVal : bVal - aVal;
      }

      const aStr = String(aVal);
      const bStr = String(bVal);
      const cmp = aStr.localeCompare(bStr);
      return direction === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [parsedRows, sort]);

  return (
    <div className="data-table">
      <table>
        <thead>
          <tr className="data-table-header">
            <th
              onClick={() => handleHeaderClick("key")}
              style={{ cursor: "pointer" }}
            >
              Key{sort?.fieldId === "key" ? (sort.direction === "asc" ? " \u25B2" : " \u25BC") : ""}
            </th>
            {fields.map((field) => (
              <th
                key={field.id}
                onClick={() => handleHeaderClick(field.id)}
                style={{ cursor: "pointer" }}
              >
                {field.label}
                {sort?.fieldId === field.id
                  ? sort.direction === "asc"
                    ? " \u25B2"
                    : " \u25BC"
                  : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, idx) => (
            <tr key={row.key || idx} className="data-table-row">
              <td className="data-table-cell">{row.key}</td>
              {fields.map((field) => (
                <td key={field.id} className="data-table-cell">
                  {formatCell(row.parsed[field.id], field.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {hasMore && (
        <button className="data-table-load-more" onClick={onLoadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
