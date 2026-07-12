import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, upsertSessionMessages } from "../src/db.js";
import { createMcpServer } from "../src/mcp.js";
import type { NormalizedSession } from "../src/types.js";

let dbPath: string;
let db: Database.Database;
let client: Client;
let closeAll: () => Promise<void>;

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join("\n");
}

async function connectClient(database: Database.Database): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(database);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test-client", version: "0.1.0" });
  await Promise.all([c.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client: c,
    close: async () => {
      await c.close();
      await server.close();
    },
  };
}

beforeEach(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-mcp-")), "test.db");
  db = openDb(dbPath);

  const sessionA: NormalizedSession = {
    id: "sess-a",
    source: "claude-code",
    projectDir: "/home/dev/myapp",
    filePath: "/x/sess-a.jsonl",
    title: "Fix fts5 trigger bug",
    gitBranch: "main",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    parseErrors: 0,
    messages: [
      {
        uuid: "u1",
        role: "user",
        ts: "2026-07-01T10:00:00.000Z",
        text: "please fix the fts5 trigger bug in login",
        tools: [],
        isSidechain: false,
      },
      {
        uuid: "a1",
        role: "assistant",
        ts: "2026-07-01T10:00:05.000Z",
        text: "found and fixed the fts5 trigger bug by rewriting the AFTER UPDATE trigger",
        tools: ["Bash", "Edit"],
        model: "claude-sonnet-4-5",
        isSidechain: false,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
      {
        uuid: "u2",
        role: "user",
        ts: "2026-07-01T10:01:00.000Z",
        text: "thanks, can you also add a test for it",
        tools: [],
        isSidechain: false,
      },
      {
        uuid: "a2",
        role: "assistant",
        ts: "2026-07-01T10:01:05.000Z",
        text: "added a regression test for the fts5 trigger fix",
        tools: ["Write"],
        model: "claude-sonnet-4-5",
        isSidechain: false,
        usage: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0 },
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
    messages: [
      {
        uuid: "ub1",
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

  const connected = await connectClient(db);
  client = connected.client;
  closeAll = connected.close;
});

afterEach(async () => {
  await closeAll();
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe("createMcpServer tool listing", () => {
  it("exposes search_history, get_session_summary, get_session_excerpt", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_session_excerpt", "get_session_summary", "search_history"]);
  });
});

describe("search_history", () => {
  it("returns matching excerpts with session id, title, and date", async () => {
    const result = await client.callTool({
      name: "search_history",
      arguments: { query: "fts5 trigger" },
    });
    const out = text(result);
    expect(out).toContain("sess-a");
    expect(out).toContain("Fix fts5 trigger bug");
    expect(out).toContain("fts5 trigger");
    expect(out).not.toContain("sess-b");
  });

  it("includes a hint to use get_session_excerpt for more context", async () => {
    const result = await client.callTool({ name: "search_history", arguments: { query: "fts5" } });
    expect(text(result)).toMatch(/get_session_excerpt/);
  });

  it("emits each hit's match_uuid so the get_session_excerpt drill-down it advertises is actually callable", async () => {
    const result = await client.callTool({
      name: "search_history",
      arguments: { query: "fts5 trigger" },
    });
    const out = text(result);
    // The hint says get_session_excerpt(session_id, match_uuid) — without the uuid in the
    // payload an agent can only fetch the start of the session, not context around the hit.
    expect(out).toMatch(/match_uuid: (u1|a1)/);
  });

  it("respects the project filter", async () => {
    const result = await client.callTool({
      name: "search_history",
      arguments: { query: "topic", project: "other-project" },
    });
    const out = text(result);
    expect(out).toContain("sess-b");
    expect(out).not.toContain("sess-a");
  });

  it("defaults to a small limit and honors an explicit limit", async () => {
    const result = await client.callTool({
      name: "search_history",
      arguments: { query: "fts5", limit: 1 },
    });
    const out = text(result);
    const hitCount = (out.match(/session: sess-a/g) ?? []).length;
    expect(hitCount).toBe(1);
  });

  it("returns a friendly message when nothing matches", async () => {
    const result = await client.callTool({
      name: "search_history",
      arguments: { query: "zzz_no_such_term" },
    });
    expect(text(result)).toMatch(/no match/i);
  });

  it("hints to run `agentgrep index` when the database is empty (fresh-install UX)", async () => {
    const emptyDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-mcp-empty-")), "empty.db");
    const emptyDb = openDb(emptyDbPath);
    const connected = await connectClient(emptyDb);
    try {
      const result = await connected.client.callTool({
        name: "search_history",
        arguments: { query: "anything" },
      });
      expect(text(result)).toMatch(/agentgrep index/);
    } finally {
      await connected.close();
      emptyDb.close();
      fs.rmSync(path.dirname(emptyDbPath), { recursive: true, force: true });
    }
  });

  it("does not hint about indexing when the database has data but the query misses", async () => {
    const result = await client.callTool({
      name: "search_history",
      arguments: { query: "zzz_no_such_term" },
    });
    expect(text(result)).not.toMatch(/agentgrep index/);
  });

  it("never throws on query syntax characters like : and \"", async () => {
    await expect(
      client.callTool({ name: "search_history", arguments: { query: 'weird:"query' } })
    ).resolves.toBeDefined();
  });

  it("truncates each excerpt to at most 700 characters", async () => {
    const longText = "x".repeat(5000);
    const longSession: NormalizedSession = {
      id: "sess-long",
      source: "claude-code",
      projectDir: "/home/dev/myapp",
      filePath: "/x/sess-long.jsonl",
      title: "Long session",
      startedAt: "2026-07-02T00:00:00.000Z",
      endedAt: "2026-07-02T00:01:00.000Z",
      parseErrors: 0,
      messages: [
        {
          uuid: "ul1",
          role: "user",
          ts: "2026-07-02T00:00:00.000Z",
          text: `needle ${longText}`,
          tools: [],
          isSidechain: false,
        },
      ],
    };
    upsertSessionMessages(db, longSession, { mode: "replace" });

    const result = await client.callTool({ name: "search_history", arguments: { query: "needle" } });
    const out = text(result);
    const excerptLine = out.split("\n").find((l) => l.includes("needle"))!;
    expect(excerptLine.length).toBeLessThanOrEqual(701);
  });

  it("centers the excerpt on the match instead of truncating from the start of the message", async () => {
    const padding = "filler ".repeat(200); // >700 chars before the match
    const lateMatchSession: NormalizedSession = {
      id: "sess-late-match",
      source: "claude-code",
      projectDir: "/home/dev/myapp",
      filePath: "/x/sess-late-match.jsonl",
      title: "Late match session",
      startedAt: "2026-07-02T00:00:00.000Z",
      endedAt: "2026-07-02T00:01:00.000Z",
      parseErrors: 0,
      messages: [
        {
          uuid: "lm1",
          role: "user",
          ts: "2026-07-02T00:00:00.000Z",
          text: `${padding} zzzqneedlezzzq more trailing text`,
          tools: [],
          isSidechain: false,
        },
      ],
    };
    upsertSessionMessages(db, lateMatchSession, { mode: "replace" });

    const result = await client.callTool({ name: "search_history", arguments: { query: "zzzqneedlezzzq" } });
    const out = text(result);
    expect(out).toContain("zzzqneedlezzzq");
  });

  it("caps the total response near the ~8KB budget when many hits are requested", async () => {
    const bigText = "word ".repeat(200);
    for (let i = 0; i < 20; i++) {
      const s: NormalizedSession = {
        id: `sess-bulk-${i}`,
        source: "claude-code",
        projectDir: "/home/dev/myapp",
        filePath: `/x/sess-bulk-${i}.jsonl`,
        title: `Bulk ${i}`,
        startedAt: "2026-07-03T00:00:00.000Z",
        endedAt: "2026-07-03T00:01:00.000Z",
        parseErrors: 0,
        messages: [
          {
            uuid: `bulk-${i}`,
            role: "user",
            ts: "2026-07-03T00:00:00.000Z",
            text: `bulkneedle ${bigText}`,
            tools: [],
            isSidechain: false,
          },
        ],
      };
      upsertSessionMessages(db, s, { mode: "replace" });
    }

    const result = await client.callTool({
      name: "search_history",
      arguments: { query: "bulkneedle", limit: 20 },
    });
    const out = text(result);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(9000);
  });
});

describe("get_session_summary", () => {
  it("returns title, project, dates, message count, tools, models, first/last text", async () => {
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { session_id: "sess-a" },
    });
    const out = text(result);
    expect(out).toContain("Fix fts5 trigger bug");
    expect(out).toContain("/home/dev/myapp");
    expect(out).toContain("2026-07-01T10:00:00.000Z");
    expect(out).toContain("4");
    expect(out).toContain("Bash");
    expect(out).toContain("Edit");
    expect(out).toContain("Write");
    expect(out).toContain("claude-sonnet-4-5");
    expect(out).toContain("please fix the fts5 trigger bug in login");
    expect(out).toContain("added a regression test for the fts5 trigger fix");
  });

  it("resolves by session id prefix", async () => {
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { session_id: "sess-a" },
    });
    expect(text(result)).toContain("Fix fts5 trigger bug");
  });

  it("reports an error result for an unknown session id", async () => {
    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { session_id: "no-such-session" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toMatch(/no session found/i);
  });

  it("truncates first/last text to at most 500 characters", async () => {
    const longText = "y".repeat(5000);
    const longSession: NormalizedSession = {
      id: "sess-summary-long",
      source: "claude-code",
      projectDir: "/home/dev/myapp",
      filePath: "/x/sess-summary-long.jsonl",
      title: "Long summary session",
      startedAt: "2026-07-02T00:00:00.000Z",
      endedAt: "2026-07-02T00:01:00.000Z",
      parseErrors: 0,
      messages: [
        { uuid: "ls1", role: "user", ts: "2026-07-02T00:00:00.000Z", text: longText, tools: [], isSidechain: false },
        {
          uuid: "ls2",
          role: "assistant",
          ts: "2026-07-02T00:00:01.000Z",
          text: longText,
          tools: [],
          isSidechain: false,
        },
      ],
    };
    upsertSessionMessages(db, longSession, { mode: "replace" });

    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { session_id: "sess-summary-long" },
    });
    const out = text(result);
    for (const line of out.split("\n")) {
      // 500-char truncation cap + label prefix ("first user prompt: " etc.) + ellipsis
      expect(line.length).toBeLessThanOrEqual(540);
    }
  });
});

describe("get_session_excerpt", () => {
  it("returns the matched message plus surrounding context", async () => {
    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-a", match_uuid: "a1", context: 1 },
    });
    const out = text(result);
    expect(out).toContain("please fix the fts5 trigger bug in login");
    expect(out).toContain("found and fixed the fts5 trigger bug");
    expect(out).toContain("thanks, can you also add a test for it");
    expect(out).not.toContain("added a regression test");
  });

  it("defaults context to 3 messages on each side", async () => {
    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-a", match_uuid: "a1" },
    });
    const out = text(result);
    expect(out).toContain("please fix the fts5 trigger bug in login");
    expect(out).toContain("added a regression test for the fts5 trigger fix");
  });

  it("returns a leading window of the session when match_uuid is omitted", async () => {
    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-a", context: 1 },
    });
    const out = text(result);
    expect(out).toContain("please fix the fts5 trigger bug in login");
  });

  it("shows tool calls in the excerpt", async () => {
    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-a", match_uuid: "a1", context: 0 },
    });
    expect(text(result)).toContain("Bash");
  });

  it("reports an error result for an unknown session id", async () => {
    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "no-such-session" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("reports an error result for an unknown match_uuid", async () => {
    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-a", match_uuid: "no-such-uuid" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toMatch(/no message/i);
  });

  it("tolerates a corrupted tools column instead of throwing (excerpt and summary)", async () => {
    db.prepare("UPDATE messages SET tools = 'not-json{' WHERE uuid = 'a1'").run();

    const excerpt = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-a", match_uuid: "a1", context: 0 },
    });
    expect((excerpt as { isError?: boolean }).isError).toBeFalsy();
    expect(text(excerpt)).toContain("found and fixed the fts5 trigger bug");

    const summary = await client.callTool({
      name: "get_session_summary",
      arguments: { session_id: "sess-a" },
    });
    expect((summary as { isError?: boolean }).isError).toBeFalsy();
    // a2's tools ("Write") still parse; only the corrupted row degrades to []
    expect(text(summary)).toContain("Write");
  });

  it("stays under the ~8KB budget and still returns the match when the matched message alone is huge", async () => {
    const hugeText = "z".repeat(60_000);
    const bigSession: NormalizedSession = {
      id: "sess-huge",
      source: "claude-code",
      projectDir: "/home/dev/myapp",
      filePath: "/x/sess-huge.jsonl",
      title: "Huge message session",
      startedAt: "2026-07-04T00:00:00.000Z",
      endedAt: "2026-07-04T00:01:00.000Z",
      parseErrors: 0,
      messages: [
        { uuid: "h1", role: "user", ts: "2026-07-04T00:00:00.000Z", text: hugeText, tools: [], isSidechain: false },
      ],
    };
    upsertSessionMessages(db, bigSession, { mode: "replace" });

    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-huge", match_uuid: "h1", context: 0 },
    });
    const out = text(result);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(9000);
  });

  it("still includes the matched message (truncated) when it is huge and has small context neighbors", async () => {
    const hugeText = "w".repeat(60_000);
    const bigSession: NormalizedSession = {
      id: "sess-huge-ctx",
      source: "claude-code",
      projectDir: "/home/dev/myapp",
      filePath: "/x/sess-huge-ctx.jsonl",
      title: "Huge message with context",
      startedAt: "2026-07-05T00:00:00.000Z",
      endedAt: "2026-07-05T00:01:00.000Z",
      parseErrors: 0,
      messages: [
        {
          uuid: "before",
          role: "user",
          ts: "2026-07-05T00:00:00.000Z",
          text: "small context before the big one",
          tools: [],
          isSidechain: false,
        },
        {
          uuid: "hc1",
          role: "assistant",
          ts: "2026-07-05T00:00:01.000Z",
          text: `HUGE_MARKER ${hugeText}`,
          tools: [],
          isSidechain: false,
        },
        {
          uuid: "after",
          role: "user",
          ts: "2026-07-05T00:00:02.000Z",
          text: "small context after the big one",
          tools: [],
          isSidechain: false,
        },
      ],
    };
    upsertSessionMessages(db, bigSession, { mode: "replace" });

    const result = await client.callTool({
      name: "get_session_excerpt",
      arguments: { session_id: "sess-huge-ctx", match_uuid: "hc1" },
    });
    const out = text(result);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(9000);
    expect(out).toContain("HUGE_MARKER");
  });
});
