import type Database from "better-sqlite3";
import { searchMessagesRaw, type RawSearchOptions } from "./db.js";

export interface SearchOptions {
  project?: string;
  since?: string; // ISO timestamp, or relative shorthand like "7d" / "24h"
  role?: "user" | "assistant";
  sidechains?: boolean;
  allMatches?: boolean; // default groups to one best hit per session
  limit?: number;
  offset?: number;
  raw?: boolean;
}

export interface SearchHit {
  sessionId: string;
  uuid: string;
  role: string;
  ts: string;
  projectDir: string;
  title?: string;
  snippet: string;
  text: string;
  model?: string;
  isSidechain: boolean;
  estCostUsd: number;
  matchesInSession: number;
  source: string;
}

// Every source harness has its own resume incantation; hits know their source.
export function resumeCommand(source: string | undefined, sessionId: string): string {
  if (source === "codex") return `codex resume ${sessionId}`;
  if (source === "opencode") return `opencode --session ${sessionId}`;
  return `claude --resume ${sessionId}`;
}

// Snippets lifted from code/tool dumps carry embedded newlines, tabs and
// indentation that wreck scannability in a result list. Collapse for display
// only — stored text and raw snippet data are untouched.
export function collapseSnippetWhitespace(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

const RELATIVE_SINCE_RE = /^(\d+)([hd])$/;

export function resolveSince(since: string | undefined, now: Date = new Date()): string | undefined {
  if (!since) return undefined;
  const m = RELATIVE_SINCE_RE.exec(since);
  if (!m) return since; // assume already an ISO timestamp
  const amount = Number(m[1]);
  const unitMs = m[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - amount * unitMs).toISOString();
}

// FTS5 treats bare user input as query syntax (":", "-", etc. are operators).
// Quote each term so search input can never throw a MATCH syntax error;
// --raw opts out for users who want real FTS5 query syntax.
export function buildMatchExpression(query: string, raw: boolean): string {
  const trimmed = query.trim();
  if (raw) return trimmed;
  const terms = trimmed.split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function search(db: Database.Database, query: string, opts: SearchOptions): SearchHit[] {
  const matchExpr = buildMatchExpression(query, Boolean(opts.raw));
  const rawOpts: RawSearchOptions = {
    project: opts.project,
    since: resolveSince(opts.since),
    role: opts.role,
    sidechains: opts.sidechains,
    allMatches: opts.allMatches,
    limit: opts.limit,
    offset: opts.offset,
  };

  let rows;
  try {
    rows = searchMessagesRaw(db, matchExpr, rawOpts);
  } catch {
    // Malformed FTS5 syntax (only reachable via --raw): fail soft with no hits.
    return [];
  }

  return rows.map((r) => ({
    sessionId: r.sessionId,
    uuid: r.uuid,
    role: r.role,
    ts: r.ts,
    projectDir: r.projectDir,
    title: r.title,
    snippet: r.snippet,
    text: r.text,
    model: r.model,
    isSidechain: r.isSidechain,
    estCostUsd: r.estCostUsd,
    matchesInSession: r.matchesInSession,
    source: r.source,
  }));
}
