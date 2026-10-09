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
import { CodexAdapter } from "./adapters/codex.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { indexAll, indexAllWatermark } from "./indexer.js";
import { search, collapseSnippetWhitespace, resumeCommand, type SearchOptions } from "./search.js";
import { mergeDb, syncDir, sanitizeHostName } from "./sync.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  buildAutoLine,
  upsertAutoLines,
  removeAutoLines,
  listAutoLines,
  readCrontab,
  writeCrontab,
} from "./auto.js";
import { startMcpServer } from "./mcp.js";
import { analyzeCursorDrift, formatDriftReport } from "./doctor.js";
import { buildServer } from "./server.js";
import { pidFilePath, writeServeRecord, removeServeRecord, stopServer } from "./pidfile.js";

const DEFAULT_ROOTS = [path.join(os.homedir(), ".claude", "projects")];
const DEFAULT_CODEX_ROOTS = [path.join(os.homedir(), ".codex", "sessions")];
const DEFAULT_OPENCODE_ROOTS = [path.join(os.homedir(), ".local", "share", "opencode")];
// macOS path verified against a real install; Linux/Windows per Cursor's
// documented Electron userData convention, not yet verified against a real
// install on those platforms.
const DEFAULT_CURSOR_ROOTS = [
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Cursor", "User")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Cursor", "User")
      : path.join(os.homedir(), ".config", "Cursor", "User"),
];

export function getVersion(): string {
  // ../package.json resolves correctly from both src/ (tests via tsx) and dist/.
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
}

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
  codexRoots?: string[];
  opencodeRoots?: string[];
  cursorRoots?: string[];
  db?: string;
  json?: boolean;
}

export function runIndex(opts: IndexCliOptions, log: Logger = defaultLog): void {
  const db = openDb(resolveDbPath(opts.db));
  const claudeRoots = opts.roots && opts.roots.length > 0 ? opts.roots : DEFAULT_ROOTS;
  const codexRoots = opts.codexRoots && opts.codexRoots.length > 0 ? opts.codexRoots : DEFAULT_CODEX_ROOTS;
  const opencodeRoots =
    opts.opencodeRoots && opts.opencodeRoots.length > 0 ? opts.opencodeRoots : DEFAULT_OPENCODE_ROOTS;
  const cursorRoots = opts.cursorRoots && opts.cursorRoots.length > 0 ? opts.cursorRoots : DEFAULT_CURSOR_ROOTS;
  const a = indexAll(db, new ClaudeCodeAdapter(), claudeRoots);
  const b = indexAll(db, new CodexAdapter(), codexRoots);
  const c = indexAllWatermark(db, new OpenCodeAdapter(), opencodeRoots);
  const d = indexAllWatermark(db, new CursorAdapter(), cursorRoots);
  db.close();
  const stats = {
    filesScanned: a.filesScanned + b.filesScanned + c.filesScanned + d.filesScanned,
    filesNew: a.filesNew + b.filesNew + c.filesNew + d.filesNew,
    filesUpdated: a.filesUpdated + b.filesUpdated + c.filesUpdated + d.filesUpdated,
    messagesIndexed: a.messagesIndexed + b.messagesIndexed + c.messagesIndexed + d.messagesIndexed,
    parseErrors: a.parseErrors + b.parseErrors + c.parseErrors + d.parseErrors,
    skippedFiles: [...a.skippedFiles, ...b.skippedFiles, ...c.skippedFiles, ...d.skippedFiles],
    elapsedMs: a.elapsedMs + b.elapsedMs + c.elapsedMs + d.elapsedMs,
  };

  if (opts.json) {
    log(JSON.stringify(stats));
    return;
  }
  log(`files scanned: ${stats.filesScanned}  new: ${stats.filesNew}  updated: ${stats.filesUpdated}`);
  log(`messages indexed: ${stats.messagesIndexed}  parse errors: ${stats.parseErrors}`);
  log(`elapsed: ${stats.elapsedMs}ms`);
  // A skipped file contributed nothing this run (#2) — name it, loudly, so a
  // pathological transcript reads as "this file was skipped", never as
  // "indexing is broken".
  for (const skipped of stats.skippedFiles) log(`skipped (will retry next run): ${skipped}`);
  if (stats.filesScanned === 0) {
    log("");
    log("no transcript files found. roots scanned:");
    for (const r of claudeRoots) log(`  ${r}  (Claude Code)`);
    for (const r of codexRoots) log(`  ${r}  (Codex CLI)`);
    for (const r of opencodeRoots) log(`  ${r}  (OpenCode)`);
    for (const r of cursorRoots) log(`  ${r}  (Cursor)`);
    log("transcripts elsewhere? point rewound at them with --roots / --codex-roots / --opencode-roots / --cursor-roots");
  }
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
    log(`  ↳ resume: ${resumeCommand(hit.source, hit.sessionId, hit.projectDir)}`);
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

export function runSync(dir: string | undefined, opts: SyncCliOptions, log: Logger = defaultLog): void {
  const dbPath = resolveDbPath(opts.db);
  const cfg = loadConfig(dbPath);
  const target = dir ?? cfg.syncDir;
  if (!target) {
    log("no sync folder configured yet — run `rewound sync <dir>` once with any folder");
    log("your machines already share (Drive, Dropbox, Syncthing, a git repo...); after");
    log("that, bare `rewound sync` reuses it everywhere, including cron.");
    return;
  }
  if (dir && path.resolve(dir) !== cfg.syncDir) {
    saveConfig(dbPath, { ...cfg, syncDir: path.resolve(dir) });
  }
  const db = openDb(dbPath);
  const stats = syncDir(db, path.resolve(target), opts.host);
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

export interface AutoCliOptions {
  install?: boolean;
  remove?: boolean;
  schedule?: string;
  db?: string;
}

export function runAuto(opts: AutoCliOptions, log: Logger = defaultLog): void {
  const haveSyncDir = Boolean(loadConfig(resolveDbPath(opts.db)).syncDir);
  const line = buildAutoLine(opts.schedule ?? "@hourly", haveSyncDir);
  const current = readCrontab();

  if (current === undefined) {
    log("crontab isn't available on this system — schedule this yourself:");
    log(`  ${line}`);
    return;
  }

  if (opts.install) {
    if (!writeCrontab(upsertAutoLines(current, line))) {
      log("failed to write crontab — add manually:");
      log(`  ${line}`);
      return;
    }
    log(`installed: ${line}`);
    if (!haveSyncDir) {
      log("(index only — run `rewound sync <dir>` once, then `rewound auto --install` again to add syncing)");
    }
    return;
  }

  if (opts.remove) {
    writeCrontab(removeAutoLines(current));
    log("removed rewound's cron entry");
    return;
  }

  const managed = listAutoLines(current);
  if (managed.length === 0) {
    log("not scheduled — run `rewound auto --install` to keep the index fresh automatically");
  } else {
    for (const l of managed) log(l);
  }
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
    const heading = r.title ?? r.agentDescription ?? r.id;
    const subagentTag = r.parentSessionId ? `  [subagent${r.agentType ? `:${r.agentType}` : ""} of ${r.parentSessionId}]` : "";
    log(
      `${r.startedAt ?? "?"}  ${r.projectDir}  ${heading}${subagentTag}  msgs=${r.messageCount}  estApiCost=$${r.estCostUsd.toFixed(4)}`
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
          toolText: m.tool_text || undefined,
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
    // Genuinely contentless turn (e.g. an extended-thinking block with no
    // plaintext returned) — kept in storage (its usage feeds the session's
    // cost estimate), just skipped here for readability. --json still
    // returns every row untouched.
    if (!m.text.trim() && tools.length === 0 && !m.tool_text) continue;
    const toolSummary = tools.map((t) => `[tool: ${t}]`).join(" ");
    const sidechain = m.is_sidechain ? " (sidechain)" : "";
    log(`[${m.ts}] ${m.role}${sidechain}: ${m.text}${toolSummary ? " " + toolSummary : ""}`);
    if (m.tool_text) {
      for (const line of m.tool_text.split("\n")) log(`    ${line}`);
    }
  }
}

export interface DoctorCliOptions {
  cursorRoots?: string[];
  json?: boolean;
  minTextLength?: number;
}

// Schema-drift check. Every content gap found in the Cursor adapter so far
// (codeBlocks, thinking, serviceStatusUpdate, errorDetails, tool-call
// status, pre-_v inline conversations) was found by hand-auditing the raw
// store — nothing would have flagged them, and sessions just quietly got
// thinner. This reports fields the adapter doesn't read that carry real
// text, judged by content rather than a name list, so it keeps working as
// Cursor adds fields we've never heard of.
export function runDoctor(opts: DoctorCliOptions, log: Logger = defaultLog): void {
  const cursorRoots = opts.cursorRoots && opts.cursorRoots.length > 0 ? opts.cursorRoots : DEFAULT_CURSOR_ROOTS;
  const dbPaths = new CursorAdapter().discover(cursorRoots);

  if (dbPaths.length === 0) {
    if (opts.json) {
      log(JSON.stringify({ reports: [] }));
      return;
    }
    log("no Cursor data found. roots scanned:");
    for (const r of cursorRoots) log(`  ${r}`);
    log("point rewound at it with --cursor-roots");
    return;
  }

  const reports = dbPaths.map((p) => analyzeCursorDrift(p, { minTextLength: opts.minTextLength }));

  if (opts.json) {
    log(JSON.stringify({ reports }));
    return;
  }
  for (const report of reports) {
    for (const line of formatDriftReport(report)) log(line);
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
  const dbPath = resolveDbPath(opts.db);
  const db = openDb(dbPath);
  const app = buildServer({ db });
  const pidFile = pidFilePath(dbPath);
  app.addHook("onClose", async () => {
    removeServeRecord(pidFile);
    db.close();
  });

  const port = resolveServePort(opts.port);
  const host = opts.host ?? "127.0.0.1";
  const address = await app.listen({ port, host });

  // Recorded only once listening succeeded, so a failed bind never leaves a
  // record that `rewound stop` would report as a running server.
  writeServeRecord(pidFile, {
    pid: process.pid,
    port: app.addresses()[0]?.port ?? port,
    host,
    startedAt: new Date().toISOString(),
  });

  log(`rewound serve listening on ${address}`);
  if (host === "0.0.0.0") {
    log("bound to 0.0.0.0 (Tailscale/phone mode) — reachable from other devices on your network");
  }
  return app;
}

export interface StopCliOptions {
  db?: string;
  json?: boolean;
}

export async function runStop(opts: StopCliOptions, log: Logger = defaultLog): Promise<number> {
  const dbPath = resolveDbPath(opts.db);
  const result = await stopServer(pidFilePath(dbPath));

  if (opts.json) {
    log(JSON.stringify(result, null, 2));
  } else if (result.status === "stopped") {
    const how = result.forced ? " (forced with SIGKILL)" : "";
    log(`stopped rewound serve on ${result.host}:${result.port} (pid ${result.pid})${how}`);
  } else if (result.status === "stale") {
    log(`no rewound serve running (cleaned up a stale record for pid ${result.pid})`);
  } else if (result.status === "not-running") {
    log("no rewound serve running");
    // A server started before this release, or against a different --db, has no
    // record here — point at the manual escape hatch rather than lying about it.
    log("if one is still up, find it with: lsof -ti tcp:4321 | xargs kill");
  } else {
    log(`could not stop pid ${result.pid}: ${result.reason}`);
  }

  return result.status === "failed" ? 1 : 0;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("rewound")
    .description("Grep for everything your AI coding agents ever did.")
    .version(getVersion());

  program
    .command("index")
    .description("scan agent transcripts (Claude Code + Codex CLI + OpenCode + Cursor) into the local search index")
    .option("--roots <dirs...>", "Claude Code root directories to scan")
    .option("--codex-roots <dirs...>", "Codex CLI session roots (default: ~/.codex/sessions)")
    .option("--opencode-roots <dirs...>", "OpenCode session DB roots (default: ~/.local/share/opencode)")
    .option("--cursor-roots <dirs...>", "Cursor \"User\" data roots (default: platform Cursor app-support dir)")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((opts) => runIndex(opts));

  program
    .command("search <query>")
    .description("full-text search across every indexed session")
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
    .description("list indexed sessions, newest first")
    .option("--project <substr>", "filter by project directory substring")
    .option("--limit <n>", "max results", parsePositiveInt)
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((opts) => runSessions(opts));

  program
    .command("show <session-id-or-prefix>")
    .description("print a full session transcript")
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
    .command("sync [dir]")
    .description(
      "multi-machine continuity: exchange snapshots via any folder you already sync (dir is remembered after first use)"
    )
    .option("--host <name>", "snapshot name for this machine (default: hostname)")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((dir, opts) => runSync(dir, opts));

  program
    .command("auto")
    .description("keep the index (and sync, if configured) fresh automatically via cron")
    .option("--install", "install the cron entry")
    .option("--remove", "remove the cron entry")
    .option("--schedule <cron>", "cron schedule expression", "@hourly")
    .option("--db <path>", "database path")
    .action((opts) => runAuto(opts));

  program
    .command("stats")
    .description("per-project session/message counts with estimated API-equivalent cost")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action((opts) => runStats(opts));

  program
    .command("doctor")
    .description("check source transcripts for content fields this version doesn't index yet (schema drift)")
    .option("--cursor-roots <dirs...>", "Cursor \"User\" data roots (default: platform Cursor app-support dir)")
    .option("--min-text-length <n>", "how long a string must be to count as text", parsePositiveInt)
    .option("--json", "output JSON")
    .action((opts) => runDoctor(opts));

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
      const app = await runServe(opts);
      // Ctrl-C / `rewound stop` must run fastify's onClose so the pid record is
      // removed; without this the process dies with a stale serve.pid behind it.
      let closing = false;
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          if (closing) return;
          closing = true;
          void app.close().then(() => process.exit(0));
        });
      }
    });

  program
    .command("stop")
    .description("stop the local web UI server started by `rewound serve`")
    .option("--db <path>", "database path")
    .option("--json", "output JSON")
    .action(async (opts) => {
      process.exitCode = await runStop(opts);
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
