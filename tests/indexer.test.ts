import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, getSession, getFileRecord } from "../src/db.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { indexAll } from "../src/indexer.js";
import type { SourceAdapter } from "../src/types.js";

let tmpDir: string;
let dbPath: string;
let db: Database.Database;
let projectDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-idx-"));
  projectDir = path.join(tmpDir, "-home-dev-myapp");
  fs.mkdirSync(projectDir, { recursive: true });
  dbPath = path.join(tmpDir, "db", "agentgrep.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSessionFile(name: string, lines: string[]): string {
  const filePath = path.join(projectDir, `${name}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

function userLine(sessionId: string, uuid: string, text: string, ts: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    cwd: "/home/dev/myapp",
    gitBranch: "main",
    isSidechain: false,
    sessionId,
    message: { role: "user", content: text },
  });
}

describe("indexer", () => {
  const adapter = new ClaudeCodeAdapter();

  it("indexes a new file end-to-end", () => {
    writeSessionFile("s1", [userLine("s1", "u1", "hello world", "2026-07-01T10:00:00.000Z")]);
    const stats = indexAll(db, adapter, [tmpDir]);
    expect(stats.filesScanned).toBe(1);
    expect(stats.filesNew).toBe(1);
    expect(stats.filesUpdated).toBe(0);
    expect(stats.messagesIndexed).toBe(1);
    const session = getSession(db, "s1")!;
    expect(session.messageCount).toBe(1);
  });

  it("does nothing on a second run with no changes (fast incremental no-op)", () => {
    writeSessionFile("s1", [userLine("s1", "u1", "hello world", "2026-07-01T10:00:00.000Z")]);
    indexAll(db, adapter, [tmpDir]);
    const stats2 = indexAll(db, adapter, [tmpDir]);
    expect(stats2.filesNew).toBe(0);
    expect(stats2.filesUpdated).toBe(0);
    expect(stats2.messagesIndexed).toBe(0);
  });

  it("appends only new messages when a file grows", () => {
    const filePath = writeSessionFile("s2", [
      userLine("s2", "u1", "first message", "2026-07-01T10:00:00.000Z"),
    ]);
    indexAll(db, adapter, [tmpDir]);
    fs.appendFileSync(filePath, userLine("s2", "u2", "second message", "2026-07-01T10:01:00.000Z") + "\n");
    const stats2 = indexAll(db, adapter, [tmpDir]);
    expect(stats2.filesUpdated).toBe(1);
    expect(stats2.filesNew).toBe(0);
    expect(stats2.messagesIndexed).toBe(1);
    const session = getSession(db, "s2")!;
    expect(session.messageCount).toBe(2);
  });

  it("reparses fully when a file shrinks (rewritten in place)", () => {
    const filePath = writeSessionFile("s3", [
      userLine("s3", "u1", "first message padding padding padding", "2026-07-01T10:00:00.000Z"),
      userLine("s3", "u2", "second message padding padding padding", "2026-07-01T10:01:00.000Z"),
    ]);
    indexAll(db, adapter, [tmpDir]);
    const beforeSize = fs.statSync(filePath).size;
    fs.writeFileSync(filePath, userLine("s3", "u1b", "rewritten", "2026-07-01T10:02:00.000Z") + "\n");
    expect(fs.statSync(filePath).size).toBeLessThan(beforeSize);

    const stats2 = indexAll(db, adapter, [tmpDir]);
    expect(stats2.filesUpdated).toBe(1);
    const session = getSession(db, "s3")!;
    expect(session.messageCount).toBe(1);
  });

  it("marks a session archived when its source file disappears, keeping data", () => {
    writeSessionFile("s4", [userLine("s4", "u1", "will be deleted", "2026-07-01T10:00:00.000Z")]);
    indexAll(db, adapter, [tmpDir]);
    fs.rmSync(path.join(projectDir, "s4.jsonl"));
    const stats2 = indexAll(db, adapter, [tmpDir]);
    expect(stats2.filesScanned).toBe(0);
    const session = getSession(db, "s4")!;
    expect(session.archived).toBe(true);
    expect(session.messageCount).toBe(1);
  });

  it("reports elapsed time and total parse errors", () => {
    writeSessionFile("s5", [userLine("s5", "u1", "hello", "2026-07-01T10:00:00.000Z"), "not json at all {"]);
    const stats = indexAll(db, adapter, [tmpDir]);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(stats.parseErrors).toBe(1);
  });

  it("handles an empty file without error", () => {
    const filePath = path.join(projectDir, "s-empty.jsonl");
    fs.writeFileSync(filePath, "");
    const stats = indexAll(db, adapter, [tmpDir]);
    expect(stats.filesNew).toBe(1);
    expect(stats.messagesIndexed).toBe(0);
    const session = getSession(db, "s-empty")!;
    expect(session.messageCount).toBe(0);
  });

  it("un-archives a session once its byte-for-byte-identical file reappears", () => {
    writeSessionFile("s7", [userLine("s7", "u1", "will come back", "2026-07-01T10:00:00.000Z")]);
    indexAll(db, adapter, [tmpDir]);
    const filePath = path.join(projectDir, "s7.jsonl");
    const contents = fs.readFileSync(filePath);
    fs.rmSync(filePath);
    indexAll(db, adapter, [tmpDir]);
    expect(getSession(db, "s7")!.archived).toBe(true);

    fs.writeFileSync(filePath, contents);
    indexAll(db, adapter, [tmpDir]);
    const session = getSession(db, "s7")!;
    expect(session.archived).toBe(false);
    expect(session.messageCount).toBe(1);
  });

  it("does not lose messages when a file grows right after parse() finishes its read (TOCTOU)", () => {
    const filePath = writeSessionFile("s6", [
      userLine("s6", "u1", "first message", "2026-07-01T10:00:00.000Z"),
    ]);

    // Simulate a concurrent writer (a live Claude Code session) appending a
    // new record immediately AFTER adapter.parse() has already done its own
    // internal read — the dangerous window, since anything the indexer learns
    // about file size only AFTER this point must not be trusted as "consumed."
    let appended = false;
    const racyAdapter: SourceAdapter = {
      id: adapter.id,
      discover: (roots) => adapter.discover(roots),
      parse: (fp, fromByte) => {
        const result = adapter.parse(fp, fromByte);
        if (fp === filePath && !appended) {
          appended = true;
          fs.appendFileSync(fp, userLine("s6", "u2", "appended after parse read", "2026-07-01T10:00:01.000Z") + "\n");
        }
        return result;
      },
    };

    indexAll(db, racyAdapter, [tmpDir]);

    // This run's parse() never saw u2 (it was appended after the read), so the
    // recorded byteOffset must NOT claim to have consumed those bytes — using
    // any stat taken after the append would over-count and silently lose u2.
    const rec = getFileRecord(db, filePath)!;
    expect(rec.byteOffset).toBeLessThan(fs.statSync(filePath).size);
    const session1 = getSession(db, "s6")!;
    expect(session1.messageCount).toBe(1);

    // A subsequent (non-racy) run must pick up u2 — no permanent loss.
    const stats2 = indexAll(db, adapter, [tmpDir]);
    expect(stats2.filesUpdated).toBe(1);
    const session2 = getSession(db, "s6")!;
    expect(session2.messageCount).toBe(2);
  });

  it("does not consume or error on a torn trailing line, and picks it up once it's completed", () => {
    const filePath = path.join(projectDir, "s8.jsonl");
    fs.writeFileSync(filePath, userLine("s8", "u1", "first", "2026-07-01T10:00:00.000Z") + "\n");

    const secondLine = userLine("s8", "u2", "second (torn on first read)", "2026-07-01T10:00:01.000Z");
    // Append the record's bytes but withhold its trailing newline, simulating
    // a write that's in progress when the indexer happens to read the file.
    fs.appendFileSync(filePath, secondLine);

    const stats1 = indexAll(db, adapter, [tmpDir]);
    expect(stats1.parseErrors).toBe(0);
    expect(getSession(db, "s8")!.messageCount).toBe(1);
    const recAfterTorn = getFileRecord(db, filePath)!;
    expect(recAfterTorn.byteOffset).toBeLessThan(fs.statSync(filePath).size);

    // The writer "finishes" the line.
    fs.appendFileSync(filePath, "\n");
    const stats2 = indexAll(db, adapter, [tmpDir]);
    expect(stats2.parseErrors).toBe(0);
    const session = getSession(db, "s8")!;
    expect(session.messageCount).toBe(2);
  });
});
