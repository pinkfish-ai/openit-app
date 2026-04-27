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
      const conversationsPrefix = `${path}/`;
      for (const sd of subdirs) {
        if (!sd.is_dir) continue;
        // Depth-1 filter — fs_list walks recursively; without this we'd
        // pick up sub-sub-folders if any sync artifact ever drops one
        // inside a thread, and treat them as separate threads.
        const tail = sd.path.startsWith(conversationsPrefix) ? sd.path.slice(conversationsPrefix.length) : "";
        if (!tail || tail.includes("/")) continue;
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
          const threadPrefix = `${sd.path}/`;
          for (const m of msgs) {
            if (m.is_dir) continue;
            // Depth-1 filter; see comment on the outer loop.
            const mTail = m.path.startsWith(threadPrefix) ? m.path.slice(threadPrefix.length) : "";
            if (!mTail || mTail.includes("/")) continue;
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
      const tPrefix = `${path}/`;
      for (const node of nodes) {
        if (node.is_dir) continue;
        // Depth-1 filter — fs_list is recursive.
        const tail = node.path.startsWith(tPrefix) ? node.path.slice(tPrefix.length) : "";
        if (!tail || tail.includes("/")) continue;
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
      const colPrefix = `${path}/`;
      for (const node of nodes) {
        if (node.is_dir || node.name === "_schema.json") continue;
        // Depth-1 filter — fs_list walks recursively, so without this
        // a collection like `conversations` would slurp every msg file
        // out of every thread folder as if it were a top-level row.
        const tail = node.path.startsWith(colPrefix) ? node.path.slice(colPrefix.length) : "";
        if (!tail || tail.includes("/")) continue;
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

  // Top-level entity folders. The conversations folder already has its
  // own dedicated list view above; the rest share a single generic
  // entity-folder kind so the viewer can show a friendly empty-state
  // notice when nothing is inside yet.
  // Map the click target to the entity-folder `entity` key. The
  // 2026-04-27 filestore split made the top-level dir `filestores/`
  // (plural) with `library/` and `attachments/` inside. Library is
  // the entity-folder surface; attachments has its own ticket-id
  // grouping (handled separately, not as an entity-folder).
  const entityFolderEntry: { entity: "agents" | "workflows" | "knowledge-base" | "library" } | null =
    rel === "agents"
      ? { entity: "agents" }
      : rel === "workflows"
        ? { entity: "workflows" }
        : rel === "knowledge-base"
          ? { entity: "knowledge-base" }
          : rel === "filestores/library"
            ? { entity: "library" }
            : null;
  if (entityFolderEntry) {
    try {
      const nodes = await fsList(path);
      const files: {
        name: string;
        displayName: string;
        description: string;
        path: string;
      }[] = [];
      const childPrefix = `${path}/`;
      for (const n of nodes) {
        if (n.is_dir) continue;
        // fs_list walks recursively (depth 6); keep only direct
        // children of the entity dir so nested files (e.g. anything a
        // future sync engine drops into a sub-folder) don't pollute
        // this list with descendants.
        const remainder = n.path.startsWith(childPrefix) ? n.path.slice(childPrefix.length) : "";
        if (!remainder || remainder.includes("/")) continue;
        // Skip conflict-shadow files written by the sync engine — they
        // would duplicate every entry under "<name>.server.json" /
        // "<name>.server.md" and aren't meant for direct viewing.
        if (n.name.includes(".server.")) continue;
        let displayName = n.name.replace(/\.(json|md)$/, "");
        let description = "";
        if (rel === "agents" || rel === "workflows") {
          if (n.name.endsWith(".json")) {
            try {
              const raw = await fsRead(n.path);
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                if (typeof parsed.name === "string" && parsed.name.trim()) {
                  displayName = parsed.name.trim();
                }
                if (typeof parsed.description === "string") {
                  description = parsed.description.trim();
                }
              }
            } catch {
              /* unparseable — keep filename-derived display name */
            }
          }
        } else if (rel === "knowledge-base") {
          // Pull the first heading or first non-empty line as a
          // description preview. Markdown files are the common case;
          // for non-markdown files we fall back to just the name.
          if (n.name.endsWith(".md")) {
            try {
              const raw = await fsRead(n.path);
              // Prefer an explicit `# Heading`; otherwise take the
              // first non-empty, non-frontmatter line.
              const lines = raw.split("\n");
              let inFrontmatter = false;
              for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i];
                if (i === 0 && line.trim() === "---") {
                  inFrontmatter = true;
                  continue;
                }
                if (inFrontmatter) {
                  if (line.trim() === "---") inFrontmatter = false;
                  continue;
                }
                if (!line.trim()) continue;
                const heading = line.match(/^#\s+(.+)$/);
                if (heading) {
                  description = heading[1].trim();
                  break;
                }
                description = line.trim().slice(0, 140);
                break;
              }
            } catch {
              /* unreadable — leave description empty */
            }
          }
        }
        files.push({ name: n.name, displayName, description, path: n.path });
      }
      // Stable alphabetical order by display name so the layout doesn't
      // jump around when files are renamed in place.
      files.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return { kind: "entity-folder", entity: entityFolderEntry.entity, files };
    } catch {
      return { kind: "entity-folder", entity: entityFolderEntry.entity, files: [] };
    }
  }

  // Top-level `databases/` parent folder → databases-list. Lists each
  // child collection (databases/<col>/) as a card with name, item
  // count, and a hint of whether the schema is in place. Click → the
  // per-collection viewer (datastore-table for most, conversations-
  // list for the conversations subfolder).
  //
  // Item count is derived by walking each subdir and counting `.json`
  // files that aren't `_schema.json` or conflict-shadow `*.server.json`.
  // We swallow per-collection errors so a single broken folder doesn't
  // hide the rest.
  if (rel === "databases") {
    try {
      const subdirs = await fsList(path);
      const collections: {
        name: string;
        path: string;
        itemCount: number;
        hasSchema: boolean;
      }[] = [];
      const dbChildPrefix = `${path}/`;
      for (const sd of subdirs) {
        if (!sd.is_dir) continue;
        // fs_list walks recursively, so the raw subdir list contains
        // every nested folder (e.g. each conversation thread under
        // `conversations/`). Keep only direct children of `databases/`
        // — those are the actual collections.
        const tail = sd.path.startsWith(dbChildPrefix) ? sd.path.slice(dbChildPrefix.length) : "";
        if (!tail || tail.includes("/")) continue;
        let itemCount = 0;
        let hasSchema = false;
        try {
          const inner = await fsList(sd.path);
          const innerPrefix = `${sd.path}/`;
          for (const node of inner) {
            // Same depth-1 filter as above — counting `inner`
            // recursively would over-count (every msg-*.json inside
            // every thread for `conversations`, etc.).
            const innerTail = node.path.startsWith(innerPrefix) ? node.path.slice(innerPrefix.length) : "";
            if (!innerTail || innerTail.includes("/")) continue;
            if (node.name === "_schema.json") {
              hasSchema = true;
              continue;
            }
            // Conversations is a folder-of-folders (one dir per
            // ticketId, msg-*.json files inside) so use dir count
            // there. For everything else count row files.
            if (sd.name === "conversations") {
              if (node.is_dir) itemCount += 1;
              continue;
            }
            if (node.is_dir) continue;
            if (!node.name.endsWith(".json")) continue;
            if (node.name.includes(".server.")) continue;
            itemCount += 1;
          }
        } catch {
          /* unreadable subdir — keep itemCount=0, hasSchema=false */
        }
        collections.push({ name: sd.name, path: sd.path, itemCount, hasSchema });
      }
      // Sort alphabetically so the order is deterministic — built-ins
      // (conversations / people / tickets) end up adjacent and any
      // user-created collections fall in their natural place.
      collections.sort((a, b) => a.name.localeCompare(b.name));
      return { kind: "databases-list", collections };
    } catch {
      return { kind: "databases-list", collections: [] };
    }
  }

  return { kind: "file", path };
}
