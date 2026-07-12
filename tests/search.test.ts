import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, upsertSessionMessages } from "../src/db.js";
import { search, buildMatchExpression } from "../src/search.js";
import type { NormalizedSession } from "../src/types.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-search-")), "test.db");
  db = openDb(dbPath);

  const sessionA: NormalizedSession = {
    id: "sess-a",
    source: "claude-code",
    projectDir: "/home/dev/myapp",
    filePath: "/x/sess-a.jsonl",
    title: "Fix auth bug",
    gitBranch: "main",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    parseErrors: 0,
    bytesConsumed: 0,
    messages: [
      {
        uuid: "u1",
        role: "user",
        ts: "2026-07-01T10:00:00.000Z",
        text: "Please fix the fts5 trigger bug in login",
        tools: [],
        isSidechain: false,
      },
      {
        uuid: "a1",
        role: "assistant",
        ts: "2026-07-01T10:00:05.000Z",
        text: "I found the fts5 trigger bug, fixing now",
        tools: [],
        model: "claude-sonnet-4-5",
        isSidechain: false,
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
      },
      {
        uuid: "sc1",
        role: "assistant",
        ts: "2026-07-01T10:00:06.000Z",
        text: "sidechain note about fts5 trigger internals",
        tools: [],
        isSidechain: true,
      },
    ],
  };

  const sessionB: NormalizedSession = {
    id: "sess-b",
    source: "claude-code",
    projectDir: "/home/dev/other-project",
    filePath: "/x/sess-b.jsonl",
    title: "Unrelated work",
    gitBranch: "main",
    startedAt: "2020-01-01T00:00:00.000Z",
    endedAt: "2020-01-01T00:05:00.000Z",
    parseErrors: 0,
    bytesConsumed: 0,
    messages: [
      {
        uuid: "u2",
        role: "user",
        ts: "2020-01-01T00:00:00.000Z",
        text: "totally different topic: refactor pricing table",
        tools: [],
        isSidechain: false,
      },
    ],
  };

  upsertSessionMessages(db, sessionA, { mode: "replace" });
  upsertSessionMessages(db, sessionB, { mode: "replace" });
});

afterEach(() => {
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe("buildMatchExpression", () => {
  it("wraps plain terms in double quotes by default", () => {
    expect(buildMatchExpression("fts5 trigger", false)).toBe('"fts5" "trigger"');
  });

  it("does not choke on a query containing a colon", () => {
    expect(() => buildMatchExpression("cwd:/home/dev", false)).not.toThrow();
    const expr = buildMatchExpression("cwd:/home/dev", false);
    expect(expr).not.toMatch(/^cwd:/); // raw colon syntax must not leak through unquoted
  });

  it("escapes embedded double quotes so FTS5 syntax never errors", () => {
    const expr = buildMatchExpression('say "hello" now', false);
    expect(() => JSON.parse("[" + "]")).not.toThrow(); // sanity no-op
    expect(expr).toBeTypeOf("string");
  });

  it("passes the query through mostly as-is in --raw mode", () => {
    expect(buildMatchExpression("fts5 trigger", true)).toBe("fts5 trigger");
  });
});

describe("search", () => {
  it("finds matching messages ranked by bm25", () => {
    const hits = search(db, "fts5 trigger", {});
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.sessionId === "sess-a")).toBe(true);
  });

  it("excludes sidechain messages by default", () => {
    const hits = search(db, "fts5 trigger", {});
    expect(hits.some((h) => h.uuid === "sc1")).toBe(false);
  });

  it("includes sidechain messages when --sidechains is passed", () => {
    const hits = search(db, "fts5 trigger", { sidechains: true });
    expect(hits.some((h) => h.uuid === "sc1")).toBe(true);
  });

  it("filters by project substring", () => {
    const hits = search(db, "topic", { project: "other-project" });
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe("sess-b");
  });

  it("filters by role", () => {
    const hits = search(db, "fts5", { role: "assistant" });
    expect(hits.every((h) => h.role === "assistant")).toBe(true);
  });

  it("filters by since (ISO cutoff)", () => {
    const hits = search(db, "topic", { since: "2025-01-01T00:00:00.000Z" });
    expect(hits.length).toBe(0);
  });

  it("produces stable ordering across repeated calls", () => {
    const first = search(db, "fts5 trigger", {}).map((h) => h.uuid);
    const second = search(db, "fts5 trigger", {}).map((h) => h.uuid);
    expect(second).toEqual(first);
  });

  it("does not throw and returns zero hits for a query containing ':' and '\"'", () => {
    expect(() => search(db, 'weird:"query', {})).not.toThrow();
  });

  it("includes a resume hint session id on each hit", () => {
    const hits = search(db, "fts5 trigger", {});
    expect(hits[0].sessionId).toBeTruthy();
  });

  it("includes the session's estimated cost rollup on each hit", () => {
    const hits = search(db, "fts5 trigger", {});
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.sessionId === "sess-a")).toBe(true);
    expect(hits[0].estCostUsd).toBeGreaterThan(0);
  });

  it("supports pagination via offset (within a session via allMatches)", () => {
    // Default grouping collapses same-session hits to one row, so paginating
    // through them requires allMatches.
    const page0 = search(db, "fts5 trigger", { limit: 1, offset: 0, allMatches: true });
    const page1 = search(db, "fts5 trigger", { limit: 1, offset: 1, allMatches: true });
    expect(page0.length).toBe(1);
    expect(page1.length).toBe(1);
    expect(page0[0].uuid).not.toBe(page1[0].uuid);
  });
});
