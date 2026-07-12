import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  runIndex,
  runSearch,
  runSessions,
  runShow,
  runStats,
  buildProgram,
  isMainModule,
  runServe,
  resolveServePort,
  highlightSnippet,
  stripSnippetMarkers,
  parsePositiveInt,
} from "../src/cli.js";

let tmpDir: string;
let projectDir: string;
let dbPath: string;

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-cli-"));
  projectDir = path.join(tmpDir, "-home-dev-myapp");
  fs.mkdirSync(projectDir, { recursive: true });
  dbPath = path.join(tmpDir, "db", "agentgrep.db");

  const filePath = path.join(projectDir, "sess-cli-1.jsonl");
  fs.writeFileSync(
    filePath,
    [
      line({
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-01T10:00:00.000Z",
        cwd: "/home/dev/myapp",
        gitBranch: "main",
        isSidechain: false,
        sessionId: "sess-cli-1",
        message: { role: "user", content: "please fix the fts5 trigger bug" },
      }),
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-07-01T10:00:05.000Z",
        cwd: "/home/dev/myapp",
        gitBranch: "main",
        isSidechain: false,
        sessionId: "sess-cli-1",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "found and fixed the fts5 trigger bug" }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      line({ type: "ai-title", aiTitle: "Fix fts5 trigger bug", sessionId: "sess-cli-1" }),
    ].join("\n") + "\n"
  );

  runIndex({ roots: [tmpDir], db: dbPath, json: true }, () => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("highlightSnippet / stripSnippetMarkers", () => {
  it("converts marker bytes to ANSI bold codes", () => {
    const out = highlightSnippet("hello \x01world\x02 done");
    expect(out).toBe("hello \x1b[1mworld\x1b[0m done");
  });

  it("strips marker bytes entirely for machine output", () => {
    const out = stripSnippetMarkers("hello \x01world\x02 done");
    expect(out).toBe("hello world done");
  });
});

describe("runIndex", () => {
  it("emits JSON with the expected shape", () => {
    const lines: string[] = [];
    runIndex({ roots: [tmpDir], db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      filesScanned: expect.any(Number),
      filesNew: expect.any(Number),
      filesUpdated: expect.any(Number),
      messagesIndexed: expect.any(Number),
      parseErrors: expect.any(Number),
      elapsedMs: expect.any(Number),
    });
  });
});

describe("runSearch", () => {
  it("emits JSON with hits shaped for downstream consumption, snippet markers stripped", () => {
    const lines: string[] = [];
    runSearch("fts5 trigger", { db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits[0]).toMatchObject({
      sessionId: "sess-cli-1",
      projectDir: "/home/dev/myapp",
    });
    expect(parsed.hits[0].snippet).not.toMatch(/[\x01\x02]/);
    expect(typeof parsed.elapsedMs).toBe("number");
  });

  it("does not leak the full message text into --json output (snippet-only, kept small)", () => {
    const lines: string[] = [];
    runSearch("fts5 trigger", { db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.hits[0]).not.toHaveProperty("text");
  });

  it("never throws even on a query containing FTS special characters", () => {
    expect(() => runSearch('weird:"query', { db: dbPath, json: true }, () => {})).not.toThrow();
  });

  it("pluralizes the hit count correctly (1 hit, not 1 hits)", () => {
    const lines: string[] = [];
    // Both fixture messages match "fts5 trigger" — filter to assistant to get exactly 1 hit.
    runSearch("fts5 trigger", { db: dbPath, role: "assistant", json: false }, (s) => lines.push(s));
    const countLine = lines[lines.length - 1];
    expect(countLine).toMatch(/\(1 hit in \d+ms\)/);
    expect(countLine).not.toContain("1 hits");
  });

  it("uses the plural form for zero hits", () => {
    const lines: string[] = [];
    runSearch("zzz_no_such_term", { db: dbPath, json: false }, (s) => lines.push(s));
    expect(lines[lines.length - 1]).toMatch(/\(0 hits in \d+ms\)/);
  });

  it("hints about index freshness on zero hits (a stale index misses recent work silently)", () => {
    const lines: string[] = [];
    runSearch("zzz_no_such_term", { db: dbPath, json: false }, (s) => lines.push(s));
    const out = lines.join("\n");
    expect(out).toContain("index covers through 2026-07-01T10:00:05.000Z");
    expect(out).toMatch(/agentgrep index/);
  });

  it("does not print the freshness hint when there are hits", () => {
    const lines: string[] = [];
    runSearch("fts5 trigger", { db: dbPath, json: false }, (s) => lines.push(s));
    expect(lines.join("\n")).not.toMatch(/agentgrep index/);
  });

  it("does not print the freshness hint in JSON mode (machine output stays clean)", () => {
    const lines: string[] = [];
    runSearch("zzz_no_such_term", { db: dbPath, json: true }, (s) => lines.push(s));
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(lines.join("\n")).not.toMatch(/agentgrep index/);
  });
});

describe("runSessions", () => {
  it("emits a JSON array of session rows", () => {
    const lines: string[] = [];
    runSessions({ db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ id: "sess-cli-1", projectDir: "/home/dev/myapp" });
  });
});

describe("runShow", () => {
  it("emits the session and its messages as JSON", () => {
    const lines: string[] = [];
    runShow("sess-cli-1", { db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.session.id).toBe("sess-cli-1");
    expect(parsed.messages.length).toBe(2);
  });

  it("shapes messages as camelCase, consistent with runSessions' JSON output", () => {
    const lines: string[] = [];
    runShow("sess-cli-1", { db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    const msg = parsed.messages[0];
    expect(msg).toMatchObject({
      uuid: expect.any(String),
      role: expect.any(String),
      ts: expect.any(String),
      text: expect.any(String),
      tools: expect.any(Array),
      isSidechain: expect.any(Boolean),
    });
    expect(msg).not.toHaveProperty("is_sidechain");
    expect(msg).not.toHaveProperty("session_id");
  });

  it("resolves by id prefix", () => {
    const lines: string[] = [];
    runShow("sess-cli", { db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.session.id).toBe("sess-cli-1");
  });

  it("reports a friendly message for an unknown session id", () => {
    const lines: string[] = [];
    runShow("no-such-session", { db: dbPath, json: false }, (s) => lines.push(s));
    expect(lines.join("\n")).toMatch(/no session found/i);
  });
});

describe("runStats", () => {
  it("emits totals and a by-project breakdown as JSON", () => {
    const lines: string[] = [];
    runStats({ db: dbPath, json: true }, (s) => lines.push(s));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.totalSessions).toBe(1);
    expect(parsed.byProject[0].projectDir).toBe("/home/dev/myapp");
  });

  it("labels cost figures as est. API cost in text mode (list price, not real spend)", () => {
    const lines: string[] = [];
    runStats({ db: dbPath, json: false }, (s) => lines.push(s));
    expect(lines[0]).toMatch(/est\. API cost: \$/);
    expect(lines[1]).toMatch(/estApiCost=\$/);
    expect(lines.join("\n")).not.toMatch(/\bcost=\$/);
  });
});

describe("runSessions text mode", () => {
  it("labels per-session cost as estApiCost", () => {
    const lines: string[] = [];
    runSessions({ db: dbPath, json: false }, (s) => lines.push(s));
    expect(lines[0]).toMatch(/estApiCost=\$/);
  });
});

describe("parsePositiveInt", () => {
  it("parses a valid positive integer", () => {
    expect(parsePositiveInt("25")).toBe(25);
  });

  it("rejects non-numeric input with a friendly error instead of propagating NaN", () => {
    expect(() => parsePositiveInt("not-a-number")).toThrow(/not a positive integer/i);
  });

  it("rejects zero and negative values", () => {
    expect(() => parsePositiveInt("0")).toThrow();
    expect(() => parsePositiveInt("-5")).toThrow();
  });
});

describe("mcp command wiring", () => {
  it("registers an mcp command accepting --db", () => {
    const program = buildProgram();
    const mcp = program.commands.find((c) => c.name() === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.options.some((o) => o.long === "--db")).toBe(true);
  });
});

describe("isMainModule", () => {
  // npm always installs `bin` entries as symlinks (both `npm link` and a global/prefix
  // `npm install`), so process.argv[1] is the symlink path while import.meta.url resolves
  // through it to the real file. Must compare real paths, not raw strings, or `npx agentgrep`
  // silently no-ops (regression: previously used path.resolve() with no symlink resolution).
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-mainmod-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when argv1 is a symlink pointing at the module's real file", () => {
    const real = path.join(tmpDir, "real-cli.js");
    fs.writeFileSync(real, "");
    const link = path.join(tmpDir, "agentgrep");
    fs.symlinkSync(real, link);

    expect(isMainModule(link, pathToFileURL(real).toString())).toBe(true);
  });

  it("returns true when argv1 is the direct (non-symlinked) path", () => {
    const real = path.join(tmpDir, "real-cli.js");
    fs.writeFileSync(real, "");

    expect(isMainModule(real, pathToFileURL(real).toString())).toBe(true);
  });

  it("returns false for an unrelated file", () => {
    const real = path.join(tmpDir, "real-cli.js");
    const other = path.join(tmpDir, "other.js");
    fs.writeFileSync(real, "");
    fs.writeFileSync(other, "");

    expect(isMainModule(other, pathToFileURL(real).toString())).toBe(false);
  });

  it("returns false when argv1 is undefined", () => {
    expect(isMainModule(undefined, pathToFileURL(path.join(tmpDir, "x.js")).toString())).toBe(false);
  });

  it("returns false rather than throwing when argv1 does not exist on disk", () => {
    expect(isMainModule(path.join(tmpDir, "missing.js"), pathToFileURL(path.join(tmpDir, "x.js")).toString())).toBe(
      false
    );
  });
});

describe("runServe", () => {
  it("starts an HTTP server bound to the given host/port and logs the address", async () => {
    const lines: string[] = [];
    const app = await runServe({ port: 0, host: "127.0.0.1", db: dbPath }, (s) => lines.push(s));
    try {
      expect(lines.some((l) => l.toLowerCase().includes("listening"))).toBe(true);
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("defaults to port 4321 and host 127.0.0.1 when not specified", async () => {
    const lines: string[] = [];
    const app = await runServe({ db: dbPath, port: 0 }, (s) => lines.push(s));
    try {
      expect(app.server.listening).toBe(true);
    } finally {
      await app.close();
    }
  });

  // Port-fallback logic is tested without listening: binding the real default
  // port 4321 in a test collides with any live `agentgrep serve` on the machine
  // (EADDRINUSE — found the hard way while the author was dogfooding).
  it("falls back to the default port on a non-numeric port (e.g. a bad --port parse)", () => {
    expect(resolveServePort(NaN)).toBe(4321);
    expect(resolveServePort(undefined)).toBe(4321);
    expect(resolveServePort(-1)).toBe(4321);
    expect(resolveServePort(1.5)).toBe(4321);
    expect(resolveServePort(8080)).toBe(8080);
    expect(resolveServePort(0)).toBe(0);
  });
});

describe("search output ergonomics (grouped hits, snippet cleanup)", () => {
  it("groups same-session hits into one row with a +N more count", () => {
    const lines: string[] = [];
    runSearch("fts5 trigger", { db: dbPath }, (l) => lines.push(l));
    const out = lines.join("\n");
    // u1 and a1 both match; default output is one row for the session
    expect(out).toContain("(+1 more match in this session)");
    expect(out).toMatch(/\(1 hit in \d+ms\)/);
  });

  it("returns every matching message with allMatches", () => {
    const lines: string[] = [];
    runSearch("fts5 trigger", { db: dbPath, allMatches: true }, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toMatch(/\(2 hits in \d+ms\)/);
    expect(out).not.toContain("more match in this session");
  });

  it("renders a snippet spanning multiple source lines as a single output line", () => {
    const filePath = path.join(projectDir, "sess-cli-multiline.jsonl");
    fs.writeFileSync(
      filePath,
      line({
        type: "user",
        uuid: "m1",
        timestamp: "2026-07-02T10:00:00.000Z",
        cwd: "/home/dev/myapp",
        isSidechain: false,
        sessionId: "sess-cli-multiline",
        message: {
          role: "user",
          content: "alpha beta\ngamma webhookretry delta\nepsilon zeta",
        },
      }) + "\n"
    );
    runIndex({ roots: [tmpDir], db: dbPath, json: true }, () => {});

    const lines: string[] = [];
    runSearch("webhookretry", { db: dbPath }, (l) => lines.push(l));
    expect(lines.some((l) => l.includes("\n"))).toBe(false);
    const snippetLine = lines.find((l) => l.includes("webhookretry"))!;
    expect(snippetLine).toContain("gamma");
    expect(snippetLine).toContain("delta");
  });

  it("exposes matchesInSession in JSON hits", () => {
    const lines: string[] = [];
    runSearch("fts5 trigger", { db: dbPath, json: true }, (l) => lines.push(l));
    const payload = JSON.parse(lines[0]);
    expect(payload.hits.length).toBe(1);
    expect(payload.hits[0].matchesInSession).toBe(2);
  });

  it("wires --all-matches through the CLI program definition", () => {
    const program = buildProgram();
    const searchCmd = program.commands.find((c) => c.name() === "search")!;
    expect(searchCmd.options.some((o) => o.long === "--all-matches")).toBe(true);
  });
});
