import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, getSession, getSourceCursor, getMessagesForSession } from "../src/db.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { indexAllWatermark } from "../src/indexer.js";

const SCHEMA_SQL = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
  slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
  version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_archived INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
`;

let tmpDir: string;
let dbPath: string;
let sourceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-idx-wm-"));
  dbPath = path.join(tmpDir, "db", "rewound.db");
  sourceDir = path.join(tmpDir, "opencode-home");
  fs.mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSourceDb(dir: string, name = "opencode.db"): { dbPath: string; db: Database.Database } {
  const p = path.join(dir, name);
  const db = new Database(p);
  db.exec(SCHEMA_SQL);
  return { dbPath: p, db };
}

function insertSession(db: Database.Database, s: { id: string; directory: string; timeCreated: number; timeUpdated: number }): void {
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (@id, 'proj1', @id, @directory, 'untitled', '0.1.0', @timeCreated, @timeUpdated)`
  ).run(s);
}

function insertMessage(
  db: Database.Database,
  m: { id: string; sessionId: string; role: "user" | "assistant"; timeCreated: number; timeUpdated: number }
): void {
  const data = { role: m.role, time: { created: m.timeCreated }, ...(m.role === "assistant" ? { modelID: "m1" } : {}) };
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(m.id, m.sessionId, m.timeCreated, m.timeUpdated, JSON.stringify(data));
}

function insertTextPart(
  db: Database.Database,
  p: { id: string; messageId: string; sessionId: string; text: string; timeCreated: number; timeUpdated: number }
): void {
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(p.id, p.messageId, p.sessionId, p.timeCreated, p.timeUpdated, JSON.stringify({ type: "text", text: p.text }));
}

describe("indexAllWatermark", () => {
  const adapter = new OpenCodeAdapter();

  it("indexes a new source end-to-end", () => {
    const { db: src } = makeSourceDb(sourceDir);
    insertSession(src, { id: "ses1", directory: "/home/dev/app", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(src, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertTextPart(src, { id: "p1", messageId: "msg1", sessionId: "ses1", text: "hello", timeCreated: 1000, timeUpdated: 1000 });
    src.close();

    const db = openDb(dbPath);
    const stats = indexAllWatermark(db, adapter, [sourceDir]);
    expect(stats.filesScanned).toBe(1);
    expect(stats.filesNew).toBe(1);
    expect(stats.messagesIndexed).toBe(1);
    const session = getSession(db, "ses1")!;
    expect(session.messageCount).toBe(1);
    expect(session.source).toBe("opencode");
    db.close();
  });

  it("does nothing on a second run with no changes (no-op incremental)", () => {
    const { dbPath: srcPath, db: src } = makeSourceDb(sourceDir);
    insertSession(src, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(src, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertTextPart(src, { id: "p1", messageId: "msg1", sessionId: "ses1", text: "hello", timeCreated: 1000, timeUpdated: 1000 });
    src.close();

    const db = openDb(dbPath);
    indexAllWatermark(db, adapter, [sourceDir]);
    const stats2 = indexAllWatermark(db, adapter, [sourceDir]);
    expect(stats2.filesNew).toBe(0);
    expect(stats2.filesUpdated).toBe(0);
    expect(stats2.messagesIndexed).toBe(0);
    expect(getSourceCursor(db, srcPath)).toEqual({ kind: "watermark", value: 1000 });
    db.close();
  });

  it("re-indexing an updated message upserts in place — no duplicate rows (explicit no-duplicate test)", () => {
    const { db: src } = makeSourceDb(sourceDir);
    insertSession(src, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(src, { id: "msg1", sessionId: "ses1", role: "assistant", timeCreated: 1000, timeUpdated: 1000 });
    insertTextPart(src, { id: "p1", messageId: "msg1", sessionId: "ses1", text: "draft", timeCreated: 1000, timeUpdated: 1000 });

    const db = openDb(dbPath);
    indexAllWatermark(db, adapter, [sourceDir]);
    expect(getSession(db, "ses1")!.messageCount).toBe(1);

    // A part streams into the SAME message (OpenCode updates rows in place —
    // it never appends a brand new message row for this).
    insertTextPart(src, { id: "p2", messageId: "msg1", sessionId: "ses1", text: "final", timeCreated: 2000, timeUpdated: 2000 });
    src.prepare("UPDATE message SET time_updated = 2000 WHERE id = 'msg1'").run();
    src.close();

    const stats2 = indexAllWatermark(db, adapter, [sourceDir]);
    expect(stats2.messagesIndexed).toBe(1);

    const rows = getMessagesForSession(db, "ses1");
    expect(rows).toHaveLength(1); // not 2 — same uuid, upserted not duplicated
    expect(rows[0].text).toBe("draft\n\nfinal");
    expect(getSession(db, "ses1")!.messageCount).toBe(1);
    db.close();
  });

  it("adds a genuinely new message from a later run alongside the earlier one", () => {
    const { db: src } = makeSourceDb(sourceDir);
    insertSession(src, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(src, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertTextPart(src, { id: "p1", messageId: "msg1", sessionId: "ses1", text: "hi", timeCreated: 1000, timeUpdated: 1000 });

    const db = openDb(dbPath);
    indexAllWatermark(db, adapter, [sourceDir]);

    insertMessage(src, { id: "msg2", sessionId: "ses1", role: "assistant", timeCreated: 2000, timeUpdated: 2000 });
    insertTextPart(src, { id: "p2", messageId: "msg2", sessionId: "ses1", text: "hello back", timeCreated: 2000, timeUpdated: 2000 });
    src.close();

    const stats2 = indexAllWatermark(db, adapter, [sourceDir]);
    expect(stats2.messagesIndexed).toBe(1);
    expect(getSession(db, "ses1")!.messageCount).toBe(2);
    db.close();
  });

  it("tracks multiple sources independently", () => {
    const aDir = path.join(sourceDir, "a");
    fs.mkdirSync(aDir, { recursive: true });
    const { db: srcA } = makeSourceDb(aDir, "opencode.db");
    insertSession(srcA, { id: "ses-a", directory: "/tmp/a", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(srcA, { id: "msg-a", sessionId: "ses-a", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertTextPart(srcA, { id: "pa", messageId: "msg-a", sessionId: "ses-a", text: "a", timeCreated: 1000, timeUpdated: 1000 });
    srcA.close();

    const bDir = path.join(sourceDir, "b");
    fs.mkdirSync(bDir, { recursive: true });
    const { db: srcB } = makeSourceDb(bDir, "opencode.db");
    insertSession(srcB, { id: "ses-b", directory: "/tmp/b", timeCreated: 5000, timeUpdated: 5000 });
    insertMessage(srcB, { id: "msg-b", sessionId: "ses-b", role: "user", timeCreated: 5000, timeUpdated: 5000 });
    insertTextPart(srcB, { id: "pb", messageId: "msg-b", sessionId: "ses-b", text: "b", timeCreated: 5000, timeUpdated: 5000 });
    srcB.close();

    const db = openDb(dbPath);
    const stats = indexAllWatermark(db, adapter, [sourceDir]);
    expect(stats.filesScanned).toBe(2);
    expect(stats.filesNew).toBe(2);
    expect(getSession(db, "ses-a")).toBeDefined();
    expect(getSession(db, "ses-b")).toBeDefined();
    db.close();
  });
});
