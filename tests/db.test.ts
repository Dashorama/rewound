import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  openDb,
  getFileRecord,
  upsertFileRecord,
  getSession,
  getSessionByIdOrPrefix,
  upsertSessionMessages,
  markSessionArchived,
  deleteSessionMessages,
  searchMessagesRaw,
  listProjects,
  listRecentProjects,
  getDailyMessageCounts,
  getMessagesForSession,
} from "../src/db.js";
import type { NormalizedSession } from "../src/types.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-db-")), "test.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

function makeSession(overrides: Partial<NormalizedSession> = {}): NormalizedSession {
  return {
    id: "sess-1",
    source: "claude-code",
    projectDir: "/home/dev/myapp",
    filePath: "/home/dev/.claude/projects/-home-dev-myapp/sess-1.jsonl",
    title: "Fix auth bug",
    gitBranch: "main",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:00:06.000Z",
    parseErrors: 0,
    bytesConsumed: 0,
    messages: [
      {
        uuid: "u1",
        role: "user",
        ts: "2026-07-01T10:00:00.000Z",
        text: "Fix the auth bug",
        tools: [],
        isSidechain: false,
      },
      {
        uuid: "a1",
        role: "assistant",
        ts: "2026-07-01T10:00:05.000Z",
        text: "Looking at login.ts",
        tools: ["Read"],
        model: "claude-sonnet-4-5",
        isSidechain: false,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    ...overrides,
  };
}

describe("db schema", () => {
  it("creates all tables on open (idempotent across re-open)", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["sessions", "files", "messages", "messages_fts"])
    );
    // Re-opening the same path must not throw (IF NOT EXISTS).
    const db2 = openDb(dbPath);
    db2.close();
  });

  it("runs in WAL mode", () => {
    const mode = (db.pragma("journal_mode", { simple: true }) as string).toLowerCase();
    expect(mode).toBe("wal");
  });
});

describe("upsertSessionMessages", () => {
  it("inserts a new session with rollups computed from its messages", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const row = getSession(db, "sess-1")!;
    expect(row.messageCount).toBe(2);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
    expect(row.models).toEqual(["claude-sonnet-4-5"]);
    expect(row.title).toBe("Fix auth bug");
    expect(row.estCostUsd).toBeGreaterThan(0);
  });

  it("is idempotent: replacing the same session twice does not duplicate messages", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const row = getSession(db, "sess-1")!;
    expect(row.messageCount).toBe(2);
    const count = db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
      .get("sess-1") as { c: number };
    expect(count.c).toBe(2);
  });

  it("append mode adds only new messages and accumulates rollups", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const appended = makeSession({
      messages: [
        {
          uuid: "u2",
          role: "user",
          ts: "2026-07-01T10:01:00.000Z",
          text: "Thanks, ship it",
          tools: [],
          isSidechain: false,
        },
      ],
    });
    upsertSessionMessages(db, appended, { mode: "append" });
    const row = getSession(db, "sess-1")!;
    expect(row.messageCount).toBe(3);
    const count = db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
      .get("sess-1") as { c: number };
    expect(count.c).toBe(3);
  });

  it("does not clobber an existing title with a blank one on append", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    upsertSessionMessages(db, makeSession({ title: undefined, messages: [] }), {
      mode: "append",
    });
    const row = getSession(db, "sess-1")!;
    expect(row.title).toBe("Fix auth bug");
  });
});

describe("file tracking", () => {
  it("returns undefined for an unknown file", () => {
    expect(getFileRecord(db, "/no/such/file.jsonl")).toBeUndefined();
  });

  it("round-trips a file record", () => {
    upsertFileRecord(db, {
      path: "/x/y.jsonl",
      sessionId: "sess-1",
      size: 1234,
      mtimeMs: 999,
      byteOffset: 1234,
    });
    const rec = getFileRecord(db, "/x/y.jsonl")!;
    expect(rec).toEqual({
      path: "/x/y.jsonl",
      sessionId: "sess-1",
      size: 1234,
      mtimeMs: 999,
      byteOffset: 1234,
    });
  });

  it("upserting the same path updates rather than duplicates", () => {
    upsertFileRecord(db, { path: "/x/y.jsonl", sessionId: "sess-1", size: 10, mtimeMs: 1, byteOffset: 10 });
    upsertFileRecord(db, { path: "/x/y.jsonl", sessionId: "sess-1", size: 20, mtimeMs: 2, byteOffset: 20 });
    const rec = getFileRecord(db, "/x/y.jsonl")!;
    expect(rec.size).toBe(20);
    const count = db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("getMessagesForSession", () => {
  it("returns all messages in chronological order by default", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const rows = getMessagesForSession(db, "sess-1");
    expect(rows.map((r) => r.uuid)).toEqual(["u1", "a1"]);
  });

  it("supports limit/offset for paginating a large transcript", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const firstPage = getMessagesForSession(db, "sess-1", { limit: 1, offset: 0 });
    const secondPage = getMessagesForSession(db, "sess-1", { limit: 1, offset: 1 });
    expect(firstPage.map((r) => r.uuid)).toEqual(["u1"]);
    expect(secondPage.map((r) => r.uuid)).toEqual(["a1"]);
  });
});

describe("getSessionByIdOrPrefix", () => {
  it("resolves a genuine truncated id prefix (not the full id) to the matching session", () => {
    upsertSessionMessages(db, makeSession({ id: "abc123-full-session-id" }), { mode: "replace" });
    const row = getSessionByIdOrPrefix(db, "abc123");
    expect(row).toBeDefined();
    expect(row!.id).toBe("abc123-full-session-id");
  });
});

describe("archive mode", () => {
  it("marks a session archived while keeping its data", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    markSessionArchived(db, "sess-1");
    const row = getSession(db, "sess-1")!;
    expect(row.archived).toBe(true);
    expect(row.messageCount).toBe(2);
  });
});

describe("deleteSessionMessages", () => {
  it("removes all message rows for a session (for shrink/reparse)", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    deleteSessionMessages(db, "sess-1");
    const count = db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
      .get("sess-1") as { c: number };
    expect(count.c).toBe(0);
  });

  it("also removes the messages from the FTS index", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    deleteSessionMessages(db, "sess-1");
    const hits = searchMessagesRaw(db, '"login"', {});
    expect(hits.length).toBe(0);
  });
});

describe("listProjects", () => {
  it("returns distinct project directories sorted alphabetically", () => {
    upsertSessionMessages(db, makeSession({ id: "sess-1", projectDir: "/home/dev/myapp" }), {
      mode: "replace",
    });
    upsertSessionMessages(db, makeSession({ id: "sess-2", projectDir: "/home/dev/agentgrep" }), {
      mode: "replace",
    });
    upsertSessionMessages(db, makeSession({ id: "sess-3", projectDir: "/home/dev/myapp" }), {
      mode: "replace",
    });
    expect(listProjects(db)).toEqual(["/home/dev/agentgrep", "/home/dev/myapp"]);
  });

  it("returns an empty array when there are no sessions", () => {
    expect(listProjects(db)).toEqual([]);
  });
});

describe("listRecentProjects", () => {
  it("orders projects by most recent session activity, capped at the given limit", () => {
    upsertSessionMessages(
      db,
      makeSession({ id: "sess-old", projectDir: "/home/dev/old-project", startedAt: "2020-01-01T00:00:00.000Z" }),
      { mode: "replace" }
    );
    upsertSessionMessages(
      db,
      makeSession({ id: "sess-mid", projectDir: "/home/dev/mid-project", startedAt: "2025-01-01T00:00:00.000Z" }),
      { mode: "replace" }
    );
    upsertSessionMessages(
      db,
      makeSession({ id: "sess-new", projectDir: "/home/dev/new-project", startedAt: "2026-01-01T00:00:00.000Z" }),
      { mode: "replace" }
    );

    expect(listRecentProjects(db, 2)).toEqual(["/home/dev/new-project", "/home/dev/mid-project"]);
  });
});

describe("getDailyMessageCounts", () => {
  it("groups message counts by day, filtered by since", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const counts = getDailyMessageCounts(db, "2026-01-01T00:00:00.000Z");
    expect(counts).toEqual([{ date: "2026-07-01", count: 2 }]);
  });

  it("excludes days before the since cutoff", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const counts = getDailyMessageCounts(db, "2026-08-01T00:00:00.000Z");
    expect(counts).toEqual([]);
  });
});

describe("FTS sync via triggers", () => {
  it("finds inserted message text via the fts index", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    const hits = searchMessagesRaw(db, '"login"', {});
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe("sess-1");
  });

  it("stops finding text after the underlying message is deleted", () => {
    upsertSessionMessages(db, makeSession(), { mode: "replace" });
    db.prepare("DELETE FROM messages WHERE uuid = 'a1'").run();
    const hits = searchMessagesRaw(db, '"login"', {});
    expect(hits.length).toBe(0);
  });
});

// The exact schema agentgrep v0.1.0 shipped — used to fabricate legacy DBs
// so the v1→v2 migration path is exercised against the real thing.
const V1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, project_dir TEXT NOT NULL,
  file_path TEXT NOT NULL, title TEXT, git_branch TEXT,
  started_at TEXT, ended_at TEXT, message_count INTEGER DEFAULT 0,
  models TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
  est_cost_usd REAL DEFAULT 0, parse_errors INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, byte_offset INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT,
  role TEXT NOT NULL, ts TEXT, text TEXT NOT NULL, tools TEXT,
  model TEXT, is_sidechain INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

describe("schema v2 migration (v1 → v2, in place, no reparse)", () => {
  it("migrates a legacy v1 db: tool_text column added, data intact, searchable, version stamped", () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-v1-"));
    const legacyPath = path.join(legacyDir, "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(V1_SCHEMA_SQL);
    // An archived session whose source file no longer exists — the case the
    // migration must never lose.
    legacy
      .prepare(
        `INSERT INTO sessions (id, source, project_dir, file_path, message_count, archived)
         VALUES ('old-sess', 'claude-code', '/home/dev/gone', '/gone/old-sess.jsonl', 1, 1)`
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO messages (session_id, uuid, role, ts, text, tools, is_sidechain)
         VALUES ('old-sess', 'u1', 'user', '2026-01-01T00:00:00.000Z', 'the ancient login fix', '[]', 0)`
      )
      .run();
    legacy.close();

    const migrated = openDb(legacyPath);
    const version = migrated.pragma("user_version", { simple: true });
    expect(version).toBe(2);
    const cols = migrated.prepare("PRAGMA table_info(messages)").all().map((c: any) => c.name);
    expect(cols).toContain("tool_text");

    const hits = searchMessagesRaw(migrated, '"login"', {});
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe("old-sess");
    expect(hits[0].text).toBe("the ancient login fix");
    migrated.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  it("stamps fresh databases with the current schema version", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });
});

describe("weighted prose/tool ranking", () => {
  it("ranks a prose mention above a tool-output mention of the same term", () => {
    upsertSessionMessages(
      db,
      makeSession({
        id: "sess-tool",
        messages: [
          {
            uuid: "t1",
            role: "user",
            ts: "2026-07-01T10:00:00.000Z",
            text: "",
            toolText:
              "docker ps output line one\ndocker inspect dump line two\ndocker compose logs line three",
            tools: [],
            isSidechain: false,
          },
        ],
      }),
      { mode: "replace" }
    );
    upsertSessionMessages(
      db,
      makeSession({
        id: "sess-prose",
        messages: [
          {
            uuid: "p1",
            role: "user",
            ts: "2026-07-01T11:00:00.000Z",
            text: "the docker daemon socket was the actual problem",
            tools: [],
            isSidechain: false,
          },
        ],
      }),
      { mode: "replace" }
    );

    const hits = searchMessagesRaw(db, '"docker"', {});
    expect(hits.length).toBe(2);
    expect(hits[0].uuid).toBe("p1");
  });

  it("still finds terms that only exist in tool output (recall preserved)", () => {
    upsertSessionMessages(
      db,
      makeSession({
        id: "sess-err",
        messages: [
          {
            uuid: "e1",
            role: "user",
            ts: "2026-07-01T10:00:00.000Z",
            text: "the server crashed again",
            toolText: "Error: listen EADDRINUSE: address already in use :::4321",
            tools: [],
            isSidechain: false,
          },
        ],
      }),
      { mode: "replace" }
    );
    const hits = searchMessagesRaw(db, '"EADDRINUSE"', {});
    expect(hits.length).toBe(1);
    expect(hits[0].uuid).toBe("e1");
  });
});

describe("session-grouped search results", () => {
  function threeAndOne() {
    upsertSessionMessages(
      db,
      makeSession({
        id: "sess-many",
        messages: ["m1", "m2", "m3"].map((uuid, i) => ({
          uuid,
          role: "user" as const,
          ts: `2026-07-01T10:0${i}:00.000Z`,
          text: `attempt ${i}: the flaky webhook retry logic`,
          tools: [],
          isSidechain: false,
        })),
      }),
      { mode: "replace" }
    );
    upsertSessionMessages(
      db,
      makeSession({
        id: "sess-one",
        messages: [
          {
            uuid: "s1",
            role: "user",
            ts: "2026-07-01T12:00:00.000Z",
            text: "unrelated webhook question",
            tools: [],
            isSidechain: false,
          },
        ],
      }),
      { mode: "replace" }
    );
  }

  it("returns one row per session by default, carrying matchesInSession", () => {
    threeAndOne();
    const hits = searchMessagesRaw(db, '"webhook"', {});
    expect(hits.length).toBe(2);
    const many = hits.find((h) => h.sessionId === "sess-many")!;
    const one = hits.find((h) => h.sessionId === "sess-one")!;
    expect(many.matchesInSession).toBe(3);
    expect(one.matchesInSession).toBe(1);
  });

  it("returns every matching message with allMatches, still counting per session", () => {
    threeAndOne();
    const hits = searchMessagesRaw(db, '"webhook"', { allMatches: true });
    expect(hits.length).toBe(4);
    expect(hits.filter((h) => h.sessionId === "sess-many").every((h) => h.matchesInSession === 3)).toBe(true);
  });
});
