#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  resolveDbPath,
  getSessionByIdOrPrefix,
  getMessagesForSession,
  listSessions,
  getStats,
  getNewestMessageTs,
  parseJsonStringArray,
} from "./db.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { indexAll } from "./indexer.js";
import { search, collapseSnippetWhitespace, type SearchOptions } from "./search.js";
import { mergeDb, syncDir, sanitizeHostName } from "./sync.js";
import { startMcpServer } from "./mcp.js";
import { buildServer } from "./server.js";

const DEFAULT_ROOTS = [path.join(os.homedir(), ".claude", "projects")];

type Logger = (line: string) => void;
const defaultLog: Logger = (line) => console.log(line);

export function highlightSnippet(snippet: string): string {
  return snippet.replace(/\x01/g, "\x1b[1m").replace(/\x02/g, "\x1b[0m");
}

export function stripSnippetMarkers(snippet: string): string {
  return snippet.replace(/[\x01\x02]/g, "");
}

export function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(`"${value}" is not a positive integer.`);
  }
  return n;
}

export interface IndexCliOptions {
  roots?: string[];
  db?: string;
  json?: boolean;
}

export function runIndex(opts: IndexCliOptions, log: Logger = defaultLog): void {
  const db = openDb(resolveDbPath(opts.db));
  const adapter = new ClaudeCodeAdapter();
  const roots = opts.roots && opts.roots.length > 0 ? opts.roots : DEFAULT_ROOTS;
  const stats = indexAll(db, adapter, roots);
  db.close();

  if (opts.json) {
    log(JSON.stringify(stats));
    return;
  }
  log(`files scanned: ${stats.filesScanned}  new: ${stats.filesNew}  updated: ${stats.filesUpdated}`);
  log(`messages indexed: ${stats.messagesIndexed}  parse errors: ${stats.parseErrors}`);
  log(`elapsed: ${stats.elapsedMs}ms`);
}

export interface SearchCliOptions extends SearchOptions {
  db?: string;
  json?: boolean;
}

export function runSearch(query: string, opts: SearchCliOptions, log: Logger = defaultLog): void {
  const start = Date.now();
  const db = openDb(resolveDbPath(opts.db));
  const hits = search(db, query, opts);
  // A stale index misses recent work silently; on a zero-hit search, say how far
  // the index actually covers so "it's not indexed yet" is distinguishable from
  // "it doesn't exist". Text mode only — JSON output stays machine-clean.
  const newestTs = !opts.json && hits.length === 0 ? getNewestMessageTs(db) : undefined;
  db.close();
  const elapsedMs = Date.now() - start;

  if (opts.json) {
    log(
      JSON.stringify({
        hits: hits.map(({ text, ...rest }) => ({ ...rest, snippet: stripSnippetMarkers(rest.snippet) })),
        elapsedMs,
      })
    );
    return;
  }

  for (const hit of hits) {
    log(`${hit.projectDir} · ${hit.title ?? hit.sessionId} · ${hit.ts}`);
    log(highlightSnippet(collapseSnippetWhitespace(hit.snippet)));
    if (!opts.allMatches && hit.matchesInSession > 1) {
      const extra = hit.matchesInSession - 1;
      log(`  (+${extra} more ${extra === 1 ? "match" : "matches"} in this session)`);
    }
    log(`  ↳ resume: claude --resume ${hit.sessionId}`);
    log("");
  }
  if (newestTs) {
    log(`index covers through ${newestTs} — looking for something newer? run \`rewound index\` first`);
  }
  log(`(${hits.length} ${hits.length === 1 ? "hit" : "hits"} in ${elapsedMs}ms)`);
}

export interface MergeCliOptions {
  db?: string;
  json?: boolean;
}

export function runMerge(otherPath: string, opts: MergeCliOptions, log: Logger = defaultLog): void {
  const db = openDb(resolveDbPath(opts.db));
  const stats = mergeDb(db, otherPath);
  db.close();
  if (opts.json) {
    log(JSON.stringify(stats));
    return;
  }
  log(`sessions added: ${stats.sessionsAdded}  updated: ${stats.sessionsUpdated}`);
}

export interface SyncCliOptions {
  db?: string;
  json?: boolean;
  host?: string;
}

export function runSync(dir: string, opts: SyncCliOptions, log: Logger = defaultLog): void {
  const db = openDb(resolveDbPath(opts.db));
  const stats = syncDir(db, dir, opts.host);
  db.close();
  if (opts.json) {
    log(JSON.stringify(stats));
    return;
  }
  const host = sanitizeHostName(opts.host ?? os.hostname());
  log(`exported snapshot: ${host}.rewound.db`);
  log(
    `snapshots merged: ${stats.snapshotsMerged}  sessions added: ${stats.sessionsAdded}  updated: ${stats.sessionsUpdated}`
  );
}

export interface SessionsCliOptions {
  project?: string;
  limit?: number;
  db?: string;
  json?: boolean;
}

export function runSessions(opts: SessionsCliOptions, log: Logger = defaultLog): void {
  const db = openDb(resolveDbPath(opts.db));
  const rows = listSessions(db, { project: opts.project, limit: opts.limit });
  db.close();

  if (opts.json) {
    log(JSON.stringify(rows));
    return;
  }
  for (const r of rows) {
    log(
      `${r.startedAt ?? "?"}  ${r.projectDir}  ${r.title ?? r.id}  msgs=${r.messageCount}  estApiCost=$${r.estCostUsd.toFixed(4)}`
    );
  }
}

export interface ShowCliOptions {
  db?: string;
  json?: boolean;
}

export function runShow(idOrPrefix: string, opts: ShowCliOptions, log: Logger = defaultLog): void {
  const db = openDb(resolveDbPath(opts.db));
  const session = getSessionByIdOrPrefix(db, idOrPrefix);
  if (!session) {
    db.close();
    log(`no session found matching "${idOrPrefix}"`);
    return;
  }
  const messages = getMessagesForSession(db, session.id);
  db.close();

  if (opts.json) {
    log(
      JSON.stringify({
        session,
        messages: messages.map((m) => ({
          uuid: m.uuid,
          role: m.role,
          ts: m.ts,
          text: m.text,
          tools: parseJsonStringArray(m.tools),
          model: m.model ?? undefined,
          isSidechain: Boolean(m.is_sidechain),
        })),
      })
    );
    return;
  }

  log(`# ${session.title ?? session.id}  (${session.projectDir}, ${session.gitBranch ?? "?"})`);
  for (const m of messages) {
    const tools = parseJsonStringArray(m.tools);
    const toolSummary = tools.map((t) => `[tool: ${t}]`).join(" ");
    const sidechain = m.is_sidechain ? " (sidechain)" : "";
    log(`[${m.ts}] ${m.role}${sidechain}: ${m.text}${toolSummary ? " " + toolSummary : ""}`);
  }
}

export interface StatsCliOptions {
  db?: string;
  json?: boolean;
}

export function runStats(opts: StatsCliOptions, log: Logger = defaultLog): void {
  const db = openDb(resolveDbPath(opts.db));
  const stats = getStats(db);
  db.close();

  if (opts.json) {
    log(JSON.stringify(stats));
    return;
  }
  // "est. API cost" not "cost": figures are token usage at API list prices — a heavy
  // subscription user's total can read like absurd spend without that framing.
  log(`sessions: ${stats.totalSessions}  messages: ${stats.totalMessages}  est. API cost: $${stats.totalCostUsd.toFixed(2)}`);
  for (const p of stats.byProject) {
    log(`  ${p.projectDir}: sessions=${p.sessions} messages=${p.messages} estApiCost=$${p.estCostUsd.toFixed(4)}`);
  }
}

export interface McpCliOptions {
  db?: string;
}

export async function runMcp(opts: McpCliOptions): Promise<void> {
  const db = openDb(resolveDbPath(opts.db));
  await startMcpServer(db);
}

export interface ServeCliOptions {
  port?: number;
  host?: string;
  db?: string;
}

// Exported for tests: a bad --port parse (NaN/negative/non-integer) must fall back
// to the default instead of crashing fastify's listen().
export function resolveServePort(port: number | undefined): number {
  return port !== undefined && Number.isInteger(port) && port >= 0 ? port : 4321;
}

export async function runServe(opts: ServeCliOptions, log: Logger = defaultLog) {
  const db = openDb(resolveDbPath(opts.db));
  const app = buildServer({ db });
  app.addHook("onClose", async () => {
    db.close();
  });

  const port = resolveServePort(opts.port);
  const host = opts.host ?? "127.0.0.1";
  const address = await app.listen({ port, host });

  log(`rewound serve listening on ${address}`);
  if (host === "0.0.0.0") {
    log("bound to 0.0.0.0 (Tailscale/phone mode) — reachable from other devices on your network");
  }
  return app;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("rewound").description("Grep for everything your AI coding agents ever did.");

  program
    .command("index")
    .option("--roots <dirs...>", "root directories to scan")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((opts) => runIndex(opts));

  program
    .command("search <query>")
    .option("--project <substr>", "filter by project directory substring")
    .option("--since <iso-or-relative>", "ISO timestamp or relative like 7d / 24h")
    .option("--role <role>", "filter by role: user or assistant")
    .option("--sidechains", "include sidechain (subagent) messages")
    .option("--all-matches", "show every matching message, not one best hit per session")
    .option("--limit <n>", "max results", parsePositiveInt)
    .option("--raw", "treat query as raw FTS5 match syntax")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((query, opts) => runSearch(query, opts));

  program
    .command("sessions")
    .option("--project <substr>", "filter by project directory substring")
    .option("--limit <n>", "max results", parsePositiveInt)
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((opts) => runSessions(opts));

  program
    .command("show <session-id-or-prefix>")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((idOrPrefix, opts) => runShow(idOrPrefix, opts));

  program
    .command("merge <db-file>")
    .description("merge another rewound database into this one (union; richer session copy wins)")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((file, opts) => runMerge(file, opts));

  program
    .command("sync <dir>")
    .description("multi-machine continuity: exchange snapshots via any folder you already sync")
    .option("--host <name>", "snapshot name for this machine (default: hostname)")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((dir, opts) => runSync(dir, opts));

  program
    .command("stats")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((opts) => runStats(opts));

  program
    .command("mcp")
    .description("start an MCP stdio server exposing search_history, get_session_summary, get_session_excerpt")
    .option("--db <path>", "database path")
    .action((opts) => runMcp(opts));

  program
    .command("serve")
    .description("start the local web UI (search, session detail, timeline, stats)")
    .option("--port <n>", "port to listen on", (v) => parseInt(v, 10), 4321)
    .option("--host <host>", "host to bind (use 0.0.0.0 for Tailscale/phone access)", "127.0.0.1")
    .option("--db <path>", "database path")
    .action(async (opts) => {
      await runServe(opts);
    });

  return program;
}

// npm always installs `bin` entries as symlinks, so argv[1] is the symlink path while
// import.meta.url resolves through it to the real file — must compare real paths.
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return fs.realpathSync(argv1) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  buildProgram().parseAsync(process.argv);
}
