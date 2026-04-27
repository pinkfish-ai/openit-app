import { fsRead, fsList } from "../lib/api";
import type { ConversationThreadSummary, ConversationTurn, ViewerSource } from "./types";
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

  // databases/conversations/ (top level) → conversations-list. List
  // each thread subfolder, look up its ticket for subject/date/status,
  // count its messages. Sorted newest-first by lastTurnAt. Click a
  // card → conversation-thread view.
  if (rel === "databases/conversations") {
    try {
      const subdirs = await fsList(path);
      const threads: ConversationThreadSummary[] = [];
      for (const sd of subdirs) {
        if (!sd.is_dir) continue;
        const ticketId = sd.name;
        // Default empty fields; backfill from ticket + msgs below.
        let subject = "";
        let asker = "";
        let status = "";
        let createdAt = "";
        // Try the corresponding ticket file for subject/date/status.
        try {
          const ticketRaw = await fsRead(`${repo}/databases/tickets/${ticketId}.json`);
          const ticket = JSON.parse(ticketRaw);
          if (ticket && typeof ticket === "object") {
            subject = typeof ticket.subject === "string" ? ticket.subject : "";
            asker = typeof ticket.asker === "string" ? ticket.asker : "";
            status = typeof ticket.status === "string" ? ticket.status : "";
            createdAt = typeof ticket.createdAt === "string" ? ticket.createdAt : "";
          }
        } catch {
          /* ticket missing — keep defaults */
        }
        // Walk the thread to count msgs + find last activity.
        let turnCount = 0;
        let lastTurnAt = "";
        let firstBody = "";
        try {
          const msgs = await fsList(sd.path);
          // Sort by name asc — names start with msg-<unix-ms>- so older comes first.
          msgs.sort((a, b) => a.name.localeCompare(b.name));
          for (const m of msgs) {
            if (m.is_dir) continue;
            if (!m.name.endsWith(".json")) continue;
            if (m.name.includes(".server.")) continue;
            turnCount += 1;
            try {
              const raw = await fsRead(m.path);
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
                if (ts > lastTurnAt) lastTurnAt = ts;
                if (!firstBody && parsed.role === "asker" && typeof parsed.body === "string") {
                  firstBody = parsed.body;
                }
              }
            } catch {
              /* skip unparseable */
            }
          }
        } catch {
          /* empty subdir */
        }
        threads.push({
          ticketId,
          subject: subject || firstBody.split("\n")[0].slice(0, 80) || ticketId,
          asker,
          status,
          createdAt: createdAt || lastTurnAt,
          lastTurnAt,
          turnCount,
        });
      }
      // Newest activity first.
      threads.sort((a, b) => b.lastTurnAt.localeCompare(a.lastTurnAt));
      return { kind: "conversations-list", threads };
    } catch {
      return { kind: "file", path };
    }
  }

  // databases/conversations/<ticketId>/ directory → conversation-thread
  // (read every msg-*.json under the subfolder, sort by timestamp).
  // Match before the generic datastore-table rule so conversation
  // subfolders don't get rendered as tables.
  const threadMatch = rel.match(/^databases\/conversations\/([^/]+)$/);
  if (threadMatch) {
    try {
      const ticketId = threadMatch[1];
      const nodes = await fsList(path);
      const turns: ConversationTurn[] = [];
      for (const node of nodes) {
        if (node.is_dir) continue;
        if (!node.name.endsWith(".json")) continue;
        if (node.name.includes(".server.")) continue;
        try {
          const raw = await fsRead(node.path);
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            turns.push({
              id: typeof parsed.id === "string" ? parsed.id : node.name,
              ticketId: typeof parsed.ticketId === "string" ? parsed.ticketId : ticketId,
              role: typeof parsed.role === "string" ? parsed.role : "asker",
              sender: typeof parsed.sender === "string" ? parsed.sender : "",
              timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
              body: typeof parsed.body === "string" ? parsed.body : "",
            });
          }
        } catch {
          /* skip unparseable */
        }
      }
      turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return { kind: "conversation-thread", ticketId, turns };
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
