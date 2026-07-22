import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { NormalizedSession, SourceCursor } from "./types.js";
import { estimateCostUsd } from "./pricing.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, project_dir TEXT NOT NULL,
  file_path TEXT NOT NULL, title TEXT, git_branch TEXT,
  started_at TEXT, ended_at TEXT, message_count INTEGER DEFAULT 0,
  models TEXT,               -- JSON array
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
  est_cost_usd REAL DEFAULT 0, parse_errors INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0  -- 1 once source file is gone (archive mode)
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, byte_offset INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT,
  role TEXT NOT NULL, ts TEXT, text TEXT NOT NULL, tools TEXT,
  model TEXT, is_sidechain INTEGER DEFAULT 0,
  tool_text TEXT NOT NULL DEFAULT ''  -- tool_result output, ranked below prose (see bm25 weights)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, tool_text, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, tool_text) VALUES (new.id, new.text, new.tool_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, tool_text) VALUES('delete', old.id, old.text, old.tool_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, tool_text) VALUES('delete', old.id, old.text, old.tool_text);
  INSERT INTO messages_fts(rowid, text, tool_text) VALUES (new.id, new.text, new.tool_text);
END;
CREATE TABLE IF NOT EXISTS sources (
  path TEXT PRIMARY KEY, adapter_id TEXT NOT NULL,
  cursor_kind TEXT NOT NULL, cursor_value INTEGER NOT NULL
);
`;

export const CURRENT_SCHEMA_VERSION = 3;

// bm25 column weights: a match in prose (typed user text, assistant text) is
// worth 3x a match in tool output. Tool dumps stay searchable — error strings
// often exist ONLY there — they just stop outranking a human sentence.
export const PROSE_BM25_WEIGHT = 3.0;
export const TOOL_BM25_WEIGHT = 1.0;

// v2 → v3: adds the `sources` table (per-source incremental cursor for
// watermark-cursor adapters, e.g. OpenCode's shared SQLite DB — see
// getSourceCursor/upsertSourceCursor below). Purely additive: CREATE TABLE IF
// NOT EXISTS in SCHEMA_SQL already covers both fresh and existing v2 DBs, so
// there is no migrateToV3 — bumping CURRENT_SCHEMA_VERSION alone is enough for
// openDb's existing "version < CURRENT_SCHEMA_VERSION" branch to stamp it.

// v1 (0.1.0) → v2: messages gains tool_text; FTS becomes two weighted columns.
// Migrates IN PLACE from the content table — never by reparsing source files,
// because archived sessions' transcripts may already be deleted. Legacy rows
// keep their combined text in the prose column (they rank no worse than
// before); newly indexed messages get the proper split.
function migrateToV2(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN tool_text TEXT NOT NULL DEFAULT '';
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TABLE IF EXISTS messages_fts;
    `);
    db.exec(SCHEMA_SQL);
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  migrate();
}

// Resolution order: --db flag > REWOUND_DB > AGENTGREP_DB (pre-rename compat) >
// existing new-location DB > existing pre-rename DB > fresh new-location default.
// The legacy fallbacks exist because rewound shipped its first releases as
// "agentgrep"; a rename must never orphan an existing index.
export function resolveDbPath(
  cliFlag?: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  if (cliFlag) return cliFlag;
  const env = opts.env ?? process.env;
  if (env.REWOUND_DB) return env.REWOUND_DB;
  if (env.AGENTGREP_DB) return env.AGENTGREP_DB;
  const home = opts.home ?? os.homedir();
  const newPath = path.join(home, ".rewound", "rewound.db");
  if (fs.existsSync(newPath)) return newPath;
  const legacyPath = path.join(home, ".agentgrep", "agentgrep.db");
  if (fs.existsSync(legacyPath)) return legacyPath;
  return newPath;
}

export function openDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const hasMessages = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
    .get();
  const version = db.pragma("user_version", { simple: true }) as number;
  if (hasMessages && version < 2) {
    migrateToV2(db); // legacy v1 DBs never stamped user_version, so they read 0
  } else {
    db.exec(SCHEMA_SQL);
    if (version < CURRENT_SCHEMA_VERSION) db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
  return db;
}

export interface FileRecord {
  path: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
  byteOffset: number;
}

export function getFileRecord(db: Database.Database, filePath: string): FileRecord | undefined {
  const row = db
    .prepare("SELECT path, session_id, size, mtime_ms, byte_offset FROM files WHERE path = ?")
    .get(filePath) as
    | { path: string; session_id: string; size: number; mtime_ms: number; byte_offset: number }
    | undefined;
  if (!row) return undefined;
  return {
    path: row.path,
    sessionId: row.session_id,
    size: row.size,
    mtimeMs: row.mtime_ms,
    byteOffset: row.byte_offset,
  };
}

export function upsertFileRecord(db: Database.Database, rec: FileRecord): void {
  db.prepare(
    `INSERT INTO files (path, session_id, size, mtime_ms, byte_offset)
     VALUES (@path, @sessionId, @size, @mtimeMs, @byteOffset)
     ON CONFLICT(path) DO UPDATE SET
       session_id = excluded.session_id,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       byte_offset = excluded.byte_offset`
  ).run(rec);
}

// Per-source cursor for watermark-cursor adapters (see WatermarkSourceAdapter
// in types.ts) — analogous to the files table above, but keyed by source path
// alone since one source holds many sessions, not one session per path.
export function getSourceCursor(db: Database.Database, sourcePath: string): SourceCursor | undefined {
  const row = db.prepare("SELECT cursor_kind, cursor_value FROM sources WHERE path = ?").get(sourcePath) as
    | { cursor_kind: string; cursor_value: number }
    | undefined;
  if (!row) return undefined;
  return { kind: row.cursor_kind as SourceCursor["kind"], value: row.cursor_value };
}

export function upsertSourceCursor(
  db: Database.Database,
  sourcePath: string,
  adapterId: string,
  cursor: SourceCursor
): void {
  db.prepare(
    `INSERT INTO sources (path, adapter_id, cursor_kind, cursor_value)
     VALUES (@path, @adapterId, @kind, @value)
     ON CONFLICT(path) DO UPDATE SET
       adapter_id = excluded.adapter_id,
       cursor_kind = excluded.cursor_kind,
       cursor_value = excluded.cursor_value`
  ).run({ path: sourcePath, adapterId, kind: cursor.kind, value: cursor.value });
}

export function listTrackedFiles(db: Database.Database): Array<{ path: string; sessionId: string }> {
  const rows = db.prepare("SELECT path, session_id as sessionId FROM files").all() as Array<{
    path: string;
    sessionId: string;
  }>;
  return rows;
}

export interface SessionRow {
  id: string;
  source: string;
  projectDir: string;
  filePath: string;
  title?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  messageCount: number;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
  parseErrors: number;
  archived: boolean;
}

function rowToSession(row: any): SessionRow {
  return {
    id: row.id,
    source: row.source,
    projectDir: row.project_dir,
    filePath: row.file_path,
    title: row.title ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    messageCount: row.message_count,
    models: parseJsonStringArray(row.models),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    estCostUsd: row.est_cost_usd,
    parseErrors: row.parse_errors,
    archived: Boolean(row.archived),
  };
}

export function getSession(db: Database.Database, id: string): SessionRow | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  return row ? rowToSession(row) : undefined;
}

export function getSessionByIdOrPrefix(db: Database.Database, idOrPrefix: string): SessionRow | undefined {
  const exact = getSession(db, idOrPrefix);
  if (exact) return exact;
  const row = db.prepare("SELECT * FROM sessions WHERE id LIKE ? ORDER BY id LIMIT 1").get(`${idOrPrefix}%`);
  return row ? rowToSession(row) : undefined;
}

export function markSessionArchived(db: Database.Database, id: string): void {
  db.prepare("UPDATE sessions SET archived = 1 WHERE id = ?").run(id);
}

export function deleteSessionMessages(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
}

export interface UpsertOptions {
  mode: "replace" | "append" | "upsert";
}

export function upsertSessionMessages(
  db: Database.Database,
  session: NormalizedSession,
  opts: UpsertOptions
): void {
  const tx = db.transaction(() => {
    if (opts.mode === "replace") {
      deleteSessionMessages(db, session.id);
    } else if (opts.mode === "upsert") {
      // Watermark-cursor sources re-emit a message when it changes in place
      // (e.g. a new part streamed in), not only when a new one is created.
      // Delete any prior row for the same uuid first so the FTS triggers see
      // a delete+reinsert rather than a second row for the same message.
      const deleteByUuid = db.prepare("DELETE FROM messages WHERE session_id = ? AND uuid = ?");
      for (const m of session.messages) deleteByUuid.run(session.id, m.uuid);
    }

    const insertMessage = db.prepare(
      `INSERT INTO messages (session_id, uuid, role, ts, text, tools, model, is_sidechain, tool_text)
       VALUES (@sessionId, @uuid, @role, @ts, @text, @tools, @model, @isSidechain, @toolText)`
    );
    for (const m of session.messages) {
      insertMessage.run({
        sessionId: session.id,
        uuid: m.uuid,
        role: m.role,
        ts: m.ts,
        text: m.text,
        toolText: m.toolText ?? "",
        tools: JSON.stringify(m.tools ?? []),
        model: m.model ?? null,
        isSidechain: m.isSidechain ? 1 : 0,
      });
    }

    const existing = opts.mode === "replace" ? undefined : getSession(db, session.id);

    // A fallback-derived projectDir (naive dash→slash dir-name decode) must never
    // clobber a stored value: incremental append chunks with no cwd-bearing lines
    // (e.g. session-end meta records) would otherwise permanently mangle hyphenated
    // project names ("/home/dev/my-app" → "/home/dev/my/app"). cwd-derived always wins.
    const projectDir =
      session.projectDirSource === "cwd" ? session.projectDir : existing?.projectDir ?? session.projectDir;

    let costDelta = 0;
    for (const m of session.messages) {
      if (m.usage) costDelta += estimateCostUsd(m.model, m.usage);
    }

    const usageSums = session.messages.reduce(
      (acc, m) => {
        if (m.usage) {
          acc.input += m.usage.input;
          acc.output += m.usage.output;
          acc.cacheRead += m.usage.cacheRead;
          acc.cacheWrite += m.usage.cacheWrite;
        }
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    );
    if (session.usageDelta) {
      usageSums.input += session.usageDelta.input;
      usageSums.output += session.usageDelta.output;
      usageSums.cacheRead += session.usageDelta.cacheRead;
      usageSums.cacheWrite += session.usageDelta.cacheWrite;
    }

    // usageSums/costDelta stay additive even in upsert mode: watermark-cursor
    // adapters (OpenCode) don't map per-message usage in v1, so this is always
    // a zero delta for them. A future watermark adapter that DOES map usage
    // would need the same ground-truth treatment as messageCount/models below —
    // but usage isn't persisted per-message row, so there's nothing to recompute
    // from; flagging here rather than solving for a case that doesn't exist yet.
    const inputTokens = (existing?.inputTokens ?? 0) + usageSums.input;
    const outputTokens = (existing?.outputTokens ?? 0) + usageSums.output;
    const cacheReadTokens = (existing?.cacheReadTokens ?? 0) + usageSums.cacheRead;
    const cacheWriteTokens = (existing?.cacheWriteTokens ?? 0) + usageSums.cacheWrite;
    const estCostUsd = (existing?.estCostUsd ?? 0) + costDelta;
    const parseErrors = (existing?.parseErrors ?? 0) + session.parseErrors;

    const title = session.title ?? existing?.title;
    const gitBranch = session.gitBranch ?? existing?.gitBranch;

    // A message can REPLACE an already-indexed one under "upsert" (same uuid,
    // revised content) rather than only ever being net-new, so message_count/
    // models/started_at/ended_at are recomputed from the messages table itself
    // (ground truth, post delete+reinsert) instead of adding this batch's size
    // on top of the stored aggregate — the append-mode delta math below would
    // silently double-count a replaced message.
    let messageCount: number;
    let models: Set<string>;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    if (opts.mode === "upsert") {
      const agg = db
        .prepare("SELECT COUNT(*) as cnt, MIN(ts) as minTs, MAX(ts) as maxTs FROM messages WHERE session_id = ?")
        .get(session.id) as { cnt: number; minTs: string | null; maxTs: string | null };
      messageCount = agg.cnt;
      startedAt = agg.minTs ?? undefined;
      endedAt = agg.maxTs ?? undefined;
      const modelRows = db
        .prepare("SELECT DISTINCT model FROM messages WHERE session_id = ? AND model IS NOT NULL")
        .all(session.id) as Array<{ model: string }>;
      models = new Set(modelRows.map((r) => r.model));
    } else {
      messageCount = (existing?.messageCount ?? 0) + session.messages.length;
      models = new Set(existing?.models ?? []);
      for (const m of session.messages) if (m.model) models.add(m.model);
      startedAt =
        existing?.startedAt && session.startedAt
          ? existing.startedAt < session.startedAt
            ? existing.startedAt
            : session.startedAt
          : session.startedAt ?? existing?.startedAt;
      endedAt =
        existing?.endedAt && session.endedAt
          ? existing.endedAt > session.endedAt
            ? existing.endedAt
            : session.endedAt
          : session.endedAt ?? existing?.endedAt;
    }

    db.prepare(
      `INSERT INTO sessions (
         id, source, project_dir, file_path, title, git_branch, started_at, ended_at,
         message_count, models, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, est_cost_usd, parse_errors, archived
       ) VALUES (
         @id, @source, @projectDir, @filePath, @title, @gitBranch, @startedAt, @endedAt,
         @messageCount, @models, @inputTokens, @outputTokens, @cacheReadTokens,
         @cacheWriteTokens, @estCostUsd, @parseErrors, 0
       )
       ON CONFLICT(id) DO UPDATE SET
         project_dir = excluded.project_dir,
         file_path = excluded.file_path,
         title = excluded.title,
         git_branch = excluded.git_branch,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         message_count = excluded.message_count,
         models = excluded.models,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         est_cost_usd = excluded.est_cost_usd,
         parse_errors = excluded.parse_errors,
         archived = 0`
    ).run({
      id: session.id,
      source: session.source,
      projectDir,
      filePath: session.filePath,
      title: title ?? null,
      gitBranch: gitBranch ?? null,
      startedAt: startedAt ?? null,
      endedAt: endedAt ?? null,
      messageCount,
      models: JSON.stringify(Array.from(models)),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estCostUsd,
      parseErrors,
    });
  });

  tx();
}

export interface RawSearchOptions {
  project?: string;
  since?: string; // ISO cutoff
  role?: "user" | "assistant";
  sidechains?: boolean;
  allMatches?: boolean; // false (default): one best hit per session; true: every matching message
  limit?: number;
  offset?: number;
}

export interface RawSearchHit {
  sessionId: string;
  uuid: string;
  role: string;
  ts: string;
  text: string;
  snippet: string;
  model?: string;
  isSidechain: boolean;
  projectDir: string;
  title?: string;
  estCostUsd: number;
  matchesInSession: number;
  source: string;
}

export function searchMessagesRaw(
  db: Database.Database,
  matchExpr: string,
  opts: RawSearchOptions
): RawSearchHit[] {
  const clauses: string[] = ["messages_fts MATCH @matchExpr"];
  const params: Record<string, unknown> = {
    matchExpr,
    limit: opts.limit ?? 25,
    offset: opts.offset ?? 0,
  };

  if (opts.project) {
    clauses.push("s.project_dir LIKE @project");
    params.project = `%${opts.project}%`;
  }
  if (opts.since) {
    clauses.push("m.ts >= @since");
    params.since = opts.since;
  }
  if (opts.role) {
    clauses.push("m.role = @role");
    params.role = opts.role;
  }
  if (!opts.sidechains) {
    clauses.push("m.is_sidechain = 0");
  }

  // The 3rd/4th snippet() args below are literal \x01/\x02 bytes (invisible
  // here), not empty strings — sentinels consumed by cli.ts's highlightSnippet
  // and web/html.ts's highlightSnippetHtml to mark match boundaries.
  // Default result shape is one row per session (its best-ranked hit) so the
  // top of the list spans distinct moments instead of one chatty session;
  // allMatches disassembles back to per-message rows. Both carry the session's
  // total match count. snippet column -1 = auto-pick the best-matching column.
  const sql = `
    SELECT * FROM (
      SELECT hits.*,
             row_number() OVER (PARTITION BY sessionId ORDER BY rank) AS rn,
             count(*)     OVER (PARTITION BY sessionId) AS matchesInSession
      FROM (
        SELECT m.session_id as sessionId, m.uuid as uuid, m.role as role, m.ts as ts,
               m.text as text, m.model as model, m.is_sidechain as isSidechain,
               s.project_dir as projectDir, s.title as title, s.est_cost_usd as estCostUsd, s.source as source,
               snippet(messages_fts, -1, '', '', '...', 12) as snippet,
               bm25(messages_fts, ${PROSE_BM25_WEIGHT}, ${TOOL_BM25_WEIGHT}) as rank
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE ${clauses.join(" AND ")}
      ) AS hits
    )
    ${opts.allMatches ? "" : "WHERE rn = 1"}
    ORDER BY rank
    LIMIT @limit OFFSET @offset
  `;

  const rows = db.prepare(sql).all(params) as any[];
  return rows.map((r) => ({
    sessionId: r.sessionId,
    uuid: r.uuid,
    role: r.role,
    ts: r.ts,
    text: r.text,
    snippet: r.snippet,
    model: r.model ?? undefined,
    isSidechain: Boolean(r.isSidechain),
    projectDir: r.projectDir,
    title: r.title ?? undefined,
    estCostUsd: r.estCostUsd,
    matchesInSession: r.matchesInSession,
    source: r.source,
  }));
}

export interface ListSessionsOptions {
  project?: string;
  limit?: number;
}

export function listSessions(db: Database.Database, opts: ListSessionsOptions = {}): SessionRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 50 };
  if (opts.project) {
    clauses.push("project_dir LIKE @project");
    params.project = `%${opts.project}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT @limit`)
    .all(params);
  return rows.map(rowToSession);
}

// The messages.tools and sessions.models columns are written by us as JSON arrays, but
// treat them as untrusted on read: a corrupted row (partial write, manual edit, future
// schema drift) should degrade to an empty list instead of throwing mid-render in the
// CLI/MCP/web surfaces.
export function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function hasAnyMessages(db: Database.Database): boolean {
  const row = db.prepare("SELECT EXISTS(SELECT 1 FROM messages) AS present").get() as { present: number };
  return Boolean(row.present);
}

export interface GetMessagesOptions {
  limit?: number;
  offset?: number;
}

export function getMessagesForSession(
  db: Database.Database,
  sessionId: string,
  opts: GetMessagesOptions = {}
) {
  // SQLite treats a negative LIMIT as "no limit" — lets the default (no opts)
  // case share one prepared statement with the paginated case.
  const limit = opts.limit ?? -1;
  const offset = opts.offset ?? 0;

  return db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC, id ASC LIMIT ? OFFSET ?")
    .all(sessionId, limit, offset) as Array<{
    id: number;
    session_id: string;
    uuid: string;
    role: string;
    ts: string;
    text: string;
    tools: string;
    model: string | null;
    is_sidechain: number;
  }>;
}

export function listProjects(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT DISTINCT project_dir as projectDir FROM sessions ORDER BY project_dir ASC")
    .all() as Array<{ projectDir: string }>;
  return rows.map((r) => r.projectDir);
}

export function listRecentProjects(db: Database.Database, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT project_dir as projectDir
       FROM sessions
       GROUP BY project_dir
       ORDER BY MAX(started_at) DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ projectDir: string }>;
  return rows.map((r) => r.projectDir);
}

export interface DailyMessageCount {
  date: string; // YYYY-MM-DD
  count: number;
}

export function getDailyMessageCounts(db: Database.Database, sinceIso: string): DailyMessageCount[] {
  const rows = db
    .prepare(
      `SELECT substr(ts, 1, 10) as date, COUNT(*) as count
       FROM messages
       WHERE ts >= ?
       GROUP BY date
       ORDER BY date ASC`
    )
    .all(sinceIso) as DailyMessageCount[];
  return rows;
}

export interface StatsRow {
  projectDir: string;
  sessions: number;
  messages: number;
  estCostUsd: number;
}

// Timestamp of the newest indexed message — i.e. how far the index "covers".
// Used to hint at staleness: a search can only miss recent work silently, so
// zero-hit UX should say what the index has actually seen.
export function getNewestMessageTs(db: Database.Database): string | undefined {
  const row = db.prepare(`SELECT MAX(ts) as maxTs FROM messages`).get() as { maxTs: string | null };
  return row?.maxTs ?? undefined;
}

export function getStats(db: Database.Database, topN = 15): {
  totalSessions: number;
  totalMessages: number;
  totalCostUsd: number;
  byProject: StatsRow[];
} {
  const totals = db
    .prepare(
      "SELECT COUNT(*) as sessions, COALESCE(SUM(message_count),0) as messages, COALESCE(SUM(est_cost_usd),0) as cost FROM sessions"
    )
    .get() as { sessions: number; messages: number; cost: number };

  const byProject = db
    .prepare(
      `SELECT project_dir as projectDir, COUNT(*) as sessions,
              COALESCE(SUM(message_count),0) as messages,
              COALESCE(SUM(est_cost_usd),0) as estCostUsd
       FROM sessions
       GROUP BY project_dir
       ORDER BY estCostUsd DESC
       LIMIT ?`
    )
    .all(topN) as StatsRow[];

  return {
    totalSessions: totals.sessions,
    totalMessages: totals.messages,
    totalCostUsd: totals.cost,
    byProject,
  };
}
