#!/usr/bin/env node
// kb-search.mjs — search the local knowledge base for articles relevant
// to a query. Stable interface for the triage agent: takes a query
// string, returns the top matches as JSON.
//
// V1 (this file) — word-overlap scoring on filename + body. Good
// enough for ~tens of articles.
// V2 — swap the implementation for BM25 / TF-IDF lexical scoring.
// V3 — when cloud is connected, the skill body uses MCP
//     `knowledge-base_ask` instead. Output shape stays the same, so
//     the agent's logic doesn't change.
//
// Usage:
//   node .claude/scripts/kb-search.mjs "vpn password reset"
//
// Output (single JSON line on stdout):
//   { "matches": [{ "path": "knowledge-base/foo.md", "score": 0.74,
//                   "snippet": "first ~200 chars of the article" }, …] }
//
// Exit codes:
//   0 — success (matches array may be empty)
//   1 — usage error or unrecoverable failure
//
// cwd: the OpenIT project root (`~/OpenIT/<slug>/`).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const KB_DIR = "knowledge-base";
const TOP_N = 5;
const SNIPPET_LEN = 200;
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "then", "else", "of", "to", "in", "on",
  "at", "for", "with", "by", "from", "as", "it", "its", "this", "that",
  "these", "those", "i", "you", "he", "she", "we", "they", "what",
  "when", "where", "who", "why", "how", "do", "does", "did", "have",
  "has", "had", "can", "could", "should", "would", "will", "shall",
  "may", "might", "not", "no", "yes", "my", "your", "our", "their",
]);

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/// Tokenize a string into lowercase words, drop stopwords + tiny tokens.
/// Used for both query and document scoring so they're symmetrical.
function tokenize(s) {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/// Word-overlap score: fraction of distinct query tokens that appear
/// anywhere in the doc. Range 0..1. Filename matches double-count (a
/// hit in `how-to-reset-vpn.md` is more meaningful than in body
/// noise). Cheap, no IDF — fine for V1.
function score(queryTokens, filename, body) {
  if (queryTokens.length === 0) return 0;
  const docText = (filename + " " + filename + " " + body).toLowerCase();
  let hits = 0;
  for (const tok of queryTokens) {
    if (docText.includes(tok)) hits += 1;
  }
  return hits / queryTokens.length;
}

function snippet(body) {
  const stripped = body
    .replace(/^---[\s\S]*?---\n?/, "") // drop frontmatter
    .replace(/[#*_`]/g, "")             // drop markdown noise
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, SNIPPET_LEN);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(
      'Usage: node .claude/scripts/kb-search.mjs "<query>"\n',
    );
    process.exit(args.length === 0 ? 1 : 0);
  }
  const query = args.join(" ");
  const queryTokens = Array.from(new Set(tokenize(query)));

  let entries;
  try {
    entries = await readdir(KB_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") {
      // No KB dir yet — empty result, exit 0 so the caller branches
      // cleanly to "escalate".
      emit({ matches: [] });
      return;
    }
    fail(`could not read ${KB_DIR}: ${e.message}`);
  }

  const candidates = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.(md|markdown|txt)$/i.test(ent.name)) continue;
    const fullPath = path.join(KB_DIR, ent.name);
    let body;
    try {
      body = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const s = score(queryTokens, ent.name, body);
    if (s > 0) {
      candidates.push({ path: fullPath, score: s, snippet: snippet(body) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  emit({ matches: candidates.slice(0, TOP_N) });
}

main().catch((e) => fail(e.stack ?? String(e)));
