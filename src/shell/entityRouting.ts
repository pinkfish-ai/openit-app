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
            const attachments = Array.isArray((parsed as { attachments?: unknown }).attachments)
              ? ((parsed as { attachments?: unknown[] }).attachments ?? []).filter(
                  (v): v is string => typeof v === "string",
                )
              : undefined;
            turns.push({
              id: typeof parsed.id === "string" ? parsed.id : node.name,
              ticketId: typeof parsed.ticketId === "string" ? parsed.ticketId : ticketId,
              role: typeof parsed.role === "string" ? parsed.role : "asker",
              sender: typeof parsed.sender === "string" ? parsed.sender : "",
              timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
              body: typeof parsed.body === "string" ? parsed.body : "",
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
  // 2026-04-27 splits:
  //   filestores/   → `library/` (entity-folder surface)
  //                  + `attachments/` (separate ticket-grouped view)
  //   knowledge-bases/ → `default/` (built-in) + any `<custom>/`
  //                     (user-created); both render via entity-folder
  //                     with entity:"knowledge-base" + an explicit
  //                     path so the title bar / re-resolver know
  //                     which collection.
  //   reports/      → on-demand generated markdown reports;
  //                  newest sorts to top by filename.
  const kbCollectionMatch = rel.match(/^knowledge-bases\/([^/]+)$/);
  const entityFolderEntry: {
    entity: "agents" | "workflows" | "knowledge-base" | "library" | "reports";
  } | null =
    rel === "agents"
      ? { entity: "agents" }
      : rel === "workflows"
        ? { entity: "workflows" }
        : kbCollectionMatch
          ? { entity: "knowledge-base" }
          : rel === "filestores/library"
            ? { entity: "library" }
            : rel === "reports"
              ? { entity: "reports" }
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
        } else if (entityFolderEntry.entity === "knowledge-base" || entityFolderEntry.entity === "reports") {
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
      // jump around when files are renamed in place. Reports are the
      // exception — filenames carry a leading `YYYY-MM-DD-HHmm`
      // timestamp, so reverse-alphabetical on `name` puts the newest
      // run on top, which is what the admin wants when scanning
      // recent helpdesk activity.
      if (entityFolderEntry.entity === "reports") {
        files.sort((a, b) => b.name.localeCompare(a.name));
      } else {
        files.sort((a, b) => a.displayName.localeCompare(b.displayName));
      }
      return {
        kind: "entity-folder",
        entity: entityFolderEntry.entity,
        path: rel,
        files,
      };
    } catch {
      return {
        kind: "entity-folder",
        entity: entityFolderEntry.entity,
        path: rel,
        files: [],
      };
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

  // `filestores/` parent → at-a-glance overview of every filestore
  // collection in the project. `attachments` and `library` ship as
  // built-ins with hand-crafted descriptions; any user-created folder
  // under `filestores/` (e.g. an admin who runs `mkdir
  // filestores/contracts`) is surfaced too with a generic blurb.
  // Built-ins always render even when their dirs don't exist yet —
  // the bootstrap creates them on next launch.
  if (rel === "filestores") {
    type Card = {
      name: string;
      path: string;
      itemCount: number;
      itemNoun: string;
      description: string;
      isBuiltin: boolean;
    };
    const builtinDescriptions: Record<string, { description: string; itemNoun: string }> = {
      attachments: {
        description:
          "Per-ticket files uploaded from the chat intake or attached to admin replies. One subfolder per ticketId — files surface inline in the conversation thread.",
        itemNoun: "ticket",
      },
      library: {
        description:
          "Curated reference docs admins keep handy — runbooks, scripts, recurring PDFs. Drag files in to add. Cloud-synced when connected.",
        itemNoun: "file",
      },
    };

    // Pre-seed both built-ins so the cards render even before the
    // dirs are created on disk (fresh project, or pre-bootstrap
    // state).
    const cardsByName = new Map<string, Card>();
    for (const [name, meta] of Object.entries(builtinDescriptions)) {
      cardsByName.set(name, {
        name,
        path: `${path}/${name}`,
        itemCount: 0,
        itemNoun: meta.itemNoun,
        description: meta.description,
        isBuiltin: true,
      });
    }

    // Walk the filestores dir and override / extend with what's
    // actually on disk.
    try {
      const subdirs = await fsList(path);
      const childPrefix = `${path}/`;
      for (const sd of subdirs) {
        if (!sd.is_dir) continue;
        const tail = sd.path.startsWith(childPrefix) ? sd.path.slice(childPrefix.length) : "";
        if (!tail || tail.includes("/")) continue;
        const collName = sd.name;
        const isAttachments = collName === "attachments";
        const builtin = builtinDescriptions[collName];
        // Count semantics differ: attachments is folder-of-folders
        // (one subfolder per ticket), everything else counts direct
        // files (skipping conflict shadows).
        let itemCount = 0;
        try {
          const inner = await fsList(sd.path);
          const innerPrefix = `${sd.path}/`;
          for (const n of inner) {
            const innerTail = n.path.startsWith(innerPrefix) ? n.path.slice(innerPrefix.length) : "";
            if (!innerTail || innerTail.includes("/")) continue;
            if (isAttachments) {
              if (n.is_dir) itemCount += 1;
            } else {
              if (n.is_dir) continue;
              if (n.name.includes(".server.")) continue;
              itemCount += 1;
            }
          }
        } catch {
          /* unreadable subdir — leave count at 0 */
        }
        cardsByName.set(collName, {
          name: collName,
          path: sd.path,
          itemCount,
          itemNoun: builtin?.itemNoun ?? "file",
          description:
            builtin?.description ??
            "User-created filestore. Files here cloud-sync as their own collection when you connect to Pinkfish.",
          isBuiltin: !!builtin,
        });
      }
    } catch {
      /* filestores/ doesn't exist yet — built-ins still render */
    }

    // Built-ins first (alphabetical), user-created next (alphabetical).
    const cards = Array.from(cardsByName.values()).sort((a, b) => {
      if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { kind: "filestores-list", collections: cards };
  }

  // `knowledge-bases/` parent → at-a-glance overview of every KB
  // collection. `default` ships built-in (cloud-sync target in V1);
  // any user-created folder under `knowledge-bases/` is surfaced
  // alongside it with a generic blurb.
  if (rel === "knowledge-bases") {
    type Card = {
      name: string;
      path: string;
      itemCount: number;
      description: string;
      isBuiltin: boolean;
    };
    const builtinDescriptions: Record<string, string> = {
      default:
        "Articles Claude reads when answering tickets and that the admin captures during /answer-ticket. Cloud-synced when connected.",
    };
    const cardsByName = new Map<string, Card>();
    cardsByName.set("default", {
      name: "default",
      path: `${path}/default`,
      itemCount: 0,
      description: builtinDescriptions.default,
      isBuiltin: true,
    });
    try {
      const subdirs = await fsList(path);
      const childPrefix = `${path}/`;
      for (const sd of subdirs) {
        if (!sd.is_dir) continue;
        const tail = sd.path.startsWith(childPrefix) ? sd.path.slice(childPrefix.length) : "";
        if (!tail || tail.includes("/")) continue;
        let itemCount = 0;
        try {
          const inner = await fsList(sd.path);
          const innerPrefix = `${sd.path}/`;
          for (const n of inner) {
            if (n.is_dir) continue;
            const innerTail = n.path.startsWith(innerPrefix) ? n.path.slice(innerPrefix.length) : "";
            if (!innerTail || innerTail.includes("/")) continue;
            if (n.name.includes(".server.")) continue;
            if (!/\.(md|markdown|txt)$/i.test(n.name)) continue;
            itemCount += 1;
          }
        } catch {
          /* unreadable subdir — leave count at 0 */
        }
        const builtin = builtinDescriptions[sd.name];
        cardsByName.set(sd.name, {
          name: sd.name,
          path: sd.path,
          itemCount,
          description:
            builtin ?? "User-created knowledge base. Each KB syncs as its own cloud collection when you connect.",
          isBuiltin: !!builtin,
        });
      }
    } catch {
      /* knowledge-bases/ doesn't exist yet — built-in still renders */
    }
    const cards = Array.from(cardsByName.values()).sort((a, b) => {
      if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { kind: "knowledge-bases-list", collections: cards };
  }

  // `filestores/attachments/` → list of per-ticket subfolders with
  // file counts, prefixed by an explanatory header (rendered in the
  // viewer). Each ticket subfolder click jumps to the conversation
  // thread — that's where attachments belong contextually, not in a
  // standalone list.
  if (rel === "filestores/attachments") {
    try {
      const subdirs = await fsList(path);
      const tickets: { ticketId: string; path: string; fileCount: number }[] = [];
      const childPrefix = `${path}/`;
      for (const sd of subdirs) {
        if (!sd.is_dir) continue;
        const tail = sd.path.startsWith(childPrefix) ? sd.path.slice(childPrefix.length) : "";
        if (!tail || tail.includes("/")) continue;
        let fileCount = 0;
        try {
          const inner = await fsList(sd.path);
          const innerPrefix = `${sd.path}/`;
          for (const f of inner) {
            if (f.is_dir) continue;
            const innerTail = f.path.startsWith(innerPrefix) ? f.path.slice(innerPrefix.length) : "";
            if (!innerTail || innerTail.includes("/")) continue;
            fileCount += 1;
          }
        } catch {
          /* unreadable subdir — leave count at 0 */
        }
        tickets.push({ ticketId: sd.name, path: sd.path, fileCount });
      }
      // Newest-first using the ticketId's leading ISO timestamp.
      tickets.sort((a, b) => b.ticketId.localeCompare(a.ticketId));
      return { kind: "attachments-folder", tickets };
    } catch {
      return { kind: "attachments-folder", tickets: [] };
    }
  }

  return { kind: "file", path };
}
