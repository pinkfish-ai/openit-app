import { fsRead, fsList } from "../lib/api";
import type { ViewerSource } from "./types";
import type { DataCollection } from "../lib/skillsApi";

/**
 * Given an absolute file path, determine if it's an entity file
 * (database row, agent, workflow, schema) and return the appropriate
 * ViewerSource. Falls back to { kind: "file", path } for regular files.
 */
export async function resolvePathToSource(
  path: string,
  repo: string | null,
): Promise<ViewerSource> {
  if (!repo) return { kind: "file", path };

  const rel = path.startsWith(repo + "/") ? path.slice(repo.length + 1) : null;
  if (!rel) return { kind: "file", path };

  // databases/<collection>/_schema.json → datastore-schema
  const schemaMatch = rel.match(/^databases\/([^/]+)\/_schema\.json$/);
  if (schemaMatch) {
    try {
      const raw = await fsRead(path);
      const schema = JSON.parse(raw);
      return {
        kind: "datastore-schema",
        collection: { id: "", name: schemaMatch[1], type: "datastore", numItems: 0, schema },
      };
    } catch {
      return { kind: "file", path };
    }
  }

  // databases/<collection>/<row>.json → datastore-row
  const rowMatch = rel.match(/^databases\/([^/]+)\/([^/]+)\.json$/);
  if (rowMatch) {
    try {
      const raw = await fsRead(path);
      const content = JSON.parse(raw);
      // Read schema from the same collection directory
      let schema;
      try {
        const schemaPath = `${repo}/databases/${rowMatch[1]}/_schema.json`;
        const schemaRaw = await fsRead(schemaPath);
        schema = JSON.parse(schemaRaw);
      } catch { /* no schema file */ }
      return {
        kind: "datastore-row",
        collection: { id: "", name: rowMatch[1], type: "datastore", numItems: 0, schema },
        item: { id: rowMatch[2], key: rowMatch[2], content, createdAt: "", updatedAt: "" },
      };
    } catch {
      return { kind: "file", path };
    }
  }

  // databases/<collection>/ directory → datastore-table (read schema + all row files)
  const dirMatch = rel.match(/^databases\/([^/]+)$/);
  if (dirMatch) {
    try {
      const colName = dirMatch[1];
      let schema;
      try {
        const schemaRaw = await fsRead(`${path}/_schema.json`);
        schema = JSON.parse(schemaRaw);
      } catch { /* no schema file */ }

      const col: DataCollection = { id: "", name: colName, type: "datastore", numItems: 0, schema };

      // Read all row files
      const nodes = await fsList(path);
      const items = [];
      for (const node of nodes) {
        if (node.is_dir || node.name === "_schema.json") continue;
        try {
          const raw = await fsRead(node.path);
          const content = JSON.parse(raw);
          const key = node.name.replace(/\.json$/, "");
          items.push({ id: key, key, content, createdAt: "", updatedAt: "" });
        } catch { /* skip unparseable */ }
      }

      return { kind: "datastore-table", collection: col, items };
    } catch {
      return { kind: "file", path };
    }
  }

  // agents/<name>.json → agent
  const agentMatch = rel.match(/^agents\/(.+)\.json$/);
  if (agentMatch) {
    try {
      const raw = await fsRead(path);
      const agent = JSON.parse(raw);
      return { kind: "agent", agent };
    } catch {
      return { kind: "file", path };
    }
  }

  // workflows/<name>.json → workflow
  const workflowMatch = rel.match(/^workflows\/(.+)\.json$/);
  if (workflowMatch) {
    try {
      const raw = await fsRead(path);
      const workflow = JSON.parse(raw);
      return { kind: "workflow", workflow };
    } catch {
      return { kind: "file", path };
    }
  }

  return { kind: "file", path };
}
