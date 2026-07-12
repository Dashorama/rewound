import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDb, upsertSessionMessages } from "../src/db.js";
import { buildServer } from "../src/server.js";
import type { NormalizedSession } from "../src/types.js";

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rewound-server-")), "test.db");
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
    messages: [
      {
        uuid: "u1",
        role: "user",
        ts: "2026-07-01T10:00:00.000Z",
        text: "please fix the auth bug, <script>alert(1)</script> is not the bug",
        tools: [],
        isSidechain: false,
      },
      {
        uuid: "a1",
        role: "assistant",
        ts: "2026-07-01T10:00:05.000Z",
        text: "found and fixed the auth bug",
        tools: ["Read", "Edit"],
        model: "claude-sonnet-4-5",
        isSidechain: false,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };

  const sessionB: NormalizedSession = {
    id: "sess-b",
    source: "claude-code",
    projectDir: "/home/dev/rewound",
    filePath: "/x/sess-b.jsonl",
    title: "Unrelated work",
    gitBranch: "main",
    startedAt: "2026-06-30T09:00:00.000Z",
    endedAt: "2026-06-30T09:05:00.000Z",
    parseErrors: 0,
    messages: [
      {
        uuid: "u2",
        role: "user",
        ts: "2026-06-30T09:00:00.000Z",
        text: "totally different topic",
        tools: [],
        isSidechain: false,
      },
    ],
  };

  const sessionLongId: NormalizedSession = {
    id: "session-longid-12345",
    source: "claude-code",
    projectDir: "/home/dev/myapp",
    filePath: "/x/session-longid.jsonl",
    title: "Long id session",
    gitBranch: "main",
    startedAt: "2026-07-02T09:00:00.000Z",
    endedAt: "2026-07-02T09:05:00.000Z",
    parseErrors: 0,
    messages: [
      { uuid: "u3", role: "user", ts: "2026-07-02T09:00:00.000Z", text: "hi", tools: [], isSidechain: false },
    ],
  };

  const sessionPaginated: NormalizedSession = {
    id: "sess-paginated",
    source: "claude-code",
    projectDir: "/home/dev/myapp",
    filePath: "/x/sess-paginated.jsonl",
    title: "Paginated session",
    gitBranch: "main",
    startedAt: "2026-07-03T09:00:00.000Z",
    endedAt: "2026-07-03T09:05:00.000Z",
    parseErrors: 0,
    messages: Array.from({ length: 5 }, (_, i) => ({
      uuid: `p${i + 1}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      ts: `2026-07-03T09:0${i}:00.000Z`,
      text: `message-${i + 1}`,
      tools: [],
      isSidechain: false,
    })),
  };

  upsertSessionMessages(db, sessionA, { mode: "replace" });
  upsertSessionMessages(db, sessionB, { mode: "replace" });
  upsertSessionMessages(db, sessionLongId, { mode: "replace" });
  upsertSessionMessages(db, sessionPaginated, { mode: "replace" });

  app = buildServer({ db, sessionPageSize: 2 });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe("GET /", () => {
  it("returns 200 with the hero search prompt when there is no query", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/search (your|everything).*agent/i);
  });

  it("returns matching results for a query", async () => {
    const res = await app.inject({ method: "GET", url: "/?q=auth+bug" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Fix auth bug");
    expect(res.body).toContain("/home/dev/myapp");
  });

  it("highlights the matched term in the snippet with a real <mark> tag", async () => {
    const res = await app.inject({ method: "GET", url: "/?q=auth" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<mark>auth<\/mark>/i);
  });

  it("escapes injected HTML in indexed message text (XSS safety)", async () => {
    const res = await app.inject({ method: "GET", url: "/?q=bug" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>alert(1)</script>");
  });

  it("filters by project", async () => {
    const res = await app.inject({ method: "GET", url: "/?q=topic&project=rewound" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Unrelated work");
    expect(res.body).not.toContain("Fix auth bug");
  });

  it("does not crash when a query param is repeated (fastify parses it as an array)", async () => {
    const res = await app.inject({ method: "GET", url: "/?q=bug&q=auth" });
    expect(res.statusCode).toBe(200);
  });

  it("renders a styled HTML 404 page instead of raw JSON for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain('class="error-page"');
    expect(res.body).toMatch(/<div class="error-code">404<\/div>/);
  });

  it("renders a styled HTML 500 page (escaped message) when a handler throws", async () => {
    const boom = buildServer({ db });
    boom.get("/boom", async () => {
      throw new Error("kaboom <script>alert(1)</script>");
    });
    try {
      const res = await boom.inject({ method: "GET", url: "/boom" });
      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain("kaboom");
      expect(res.body).not.toContain("<script>alert(1)</script>");
      expect(res.body).toContain('class="error-page"');
      expect(res.body).toMatch(/<div class="error-code">500<\/div>/);
    } finally {
      await boom.close();
    }
  });
});

describe("GET /session/:id", () => {
  it("returns 200 with the readable transcript for a known session", async () => {
    const res = await app.inject({ method: "GET", url: "/session/sess-a" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Fix auth bug");
    expect(res.body).toContain("claude --resume sess-a");
  });

  it("collapses the tool-call message behind a details element", async () => {
    const res = await app.inject({ method: "GET", url: "/session/sess-a" });
    expect(res.body).toContain("<details");
    expect(res.body).toContain("Read");
  });

  it("resolves a genuine truncated session id prefix", async () => {
    const res = await app.inject({ method: "GET", url: "/session/session-longid" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Long id session");
  });

  it("returns 404 for an unknown session id", async () => {
    const res = await app.inject({ method: "GET", url: "/session/no-such-session" });
    expect(res.statusCode).toBe(404);
  });

  it("escapes a malicious session id echoed into the 404 message (XSS safety)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/session/" + encodeURIComponent("<script>alert(1)</script>"),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("<script>alert(1)</script>");
  });

  it("defaults to the most recent page of a long transcript", async () => {
    const res = await app.inject({ method: "GET", url: "/session/sess-paginated" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("message-5");
    expect(res.body).not.toContain("message-1");
    expect(res.body).toMatch(/page 3 of 3/i);
  });

  it("serves an earlier page via ?page=", async () => {
    const res = await app.inject({ method: "GET", url: "/session/sess-paginated?page=1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("message-1");
    expect(res.body).toContain("message-2");
    expect(res.body).not.toContain("message-5");
  });

  it("does not crash on a duplicated page query param", async () => {
    const res = await app.inject({ method: "GET", url: "/session/sess-paginated?page=1&page=2" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /timeline", () => {
  it("lists projects when none is selected", async () => {
    const res = await app.inject({ method: "GET", url: "/timeline" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/home/dev/myapp");
    expect(res.body).toContain("/home/dev/rewound");
  });

  it("caps the project list so an unbounded corpus can't blow up page weight", async () => {
    const app2 = buildServer({ db, timelineProjectLimit: 1 });
    try {
      const res = await app2.inject({ method: "GET", url: "/timeline" });
      expect(res.statusCode).toBe(200);
      const linkCount = (res.body.match(/href="\/timeline\?project=/g) ?? []).length;
      expect(linkCount).toBe(1);
    } finally {
      await app2.close();
    }
  });

  it("shows sessions for the selected project, grouped by day", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/timeline?project=${encodeURIComponent("/home/dev/myapp")}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Fix auth bug");
    expect(res.body).toContain("2026-07-01");
  });
});

describe("GET /stats", () => {
  it("returns 200 with totals and a by-project table", async () => {
    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/home/dev/myapp");
    expect(res.body).toContain("/home/dev/rewound");
    expect(res.body).toMatch(/<svg/);
  });
});
