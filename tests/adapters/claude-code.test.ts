import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
const FIXTURE = path.join(FIXTURES_DIR, "basic-session.jsonl");

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  it("has id claude-code", () => {
    expect(adapter.id).toBe("claude-code");
  });

  it("discovers jsonl files under roots", () => {
    const files = adapter.discover([FIXTURES_DIR]);
    expect(files).toContain(FIXTURE);
  });

  it("does not discover non-jsonl files", () => {
    const files = adapter.discover([FIXTURES_DIR]);
    for (const f of files) {
      expect(f.endsWith(".jsonl")).toBe(true);
    }
  });

  it("derives session id from filename stem and stamps source/filePath", () => {
    const session = adapter.parse(FIXTURE);
    expect(session.id).toBe("basic-session");
    expect(session.source).toBe("claude-code");
    expect(session.filePath).toBe(FIXTURE);
  });

  it("extracts plain string user content", () => {
    const session = adapter.parse(FIXTURE);
    const msg = session.messages.find((m) => m.uuid === "u1");
    expect(msg).toBeDefined();
    expect(msg!.role).toBe("user");
    expect(msg!.text).toContain("Fix the auth bug in login.ts");
    expect(msg!.isSidechain).toBe(false);
  });

  it("extracts assistant text, thinking text, tool_use names, model and usage", () => {
    const session = adapter.parse(FIXTURE);
    const msg = session.messages.find((m) => m.uuid === "a1")!;
    expect(msg.role).toBe("assistant");
    expect(msg.text).toContain("Let me look at the login flow.");
    expect(msg.text).toContain("I should check the login handler first.");
    expect(msg.tools).toEqual(["Read"]);
    expect(msg.model).toBe("claude-sonnet-4-5");
    expect(msg.usage).toEqual({ input: 120, output: 45, cacheRead: 10, cacheWrite: 5 });
  });

  it("routes tool_result text into toolText, keeping prose text clean", () => {
    const session = adapter.parse(FIXTURE);
    const msg = session.messages.find((m) => m.uuid === "u2")!;
    expect(msg.role).toBe("user");
    expect(msg.toolText).toContain("export function login()");
    expect(msg.text).not.toContain("export function login()");
  });

  it("splits a mixed user message: typed text → text, tool_result → toolText", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-split-"));
    const filePath = path.join(tmp, "split-session.jsonl");
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-01T10:00:00.000Z",
      cwd: "/home/dev/myapp",
      isSidechain: false,
      sessionId: "split-session",
      message: {
        role: "user",
        content: [
          { type: "text", text: "here is what the test printed" },
          { type: "tool_result", content: "FAIL src/thing.test.ts giant dump of output" },
        ],
      },
    });
    fs.writeFileSync(filePath, line + "\n");

    const msg = adapter.parse(filePath).messages[0];
    expect(msg.text).toBe("here is what the test printed");
    expect(msg.toolText).toBe("FAIL src/thing.test.ts giant dump of output");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("leaves toolText empty for plain string user content and for assistant messages", () => {
    const session = adapter.parse(FIXTURE);
    const u1 = session.messages.find((m) => m.uuid === "u1")!;
    const a1 = session.messages.find((m) => m.uuid === "a1")!;
    expect(u1.toolText ?? "").toBe("");
    expect(a1.toolText ?? "").toBe("");
    // assistant prose (text + thinking) stays in text
    expect(a1.text).toContain("Let me look at the login flow.");
  });

  it("sets session title from ai-title record", () => {
    const session = adapter.parse(FIXTURE);
    expect(session.title).toBe("Fix auth bug in login flow");
  });

  it("skips system records without producing a message or erroring", () => {
    const session = adapter.parse(FIXTURE);
    const systemMsgs = session.messages.filter((m) => (m as any).type === "system");
    expect(systemMsgs.length).toBe(0);
  });

  it("skips unknown record types silently (format drift tolerance)", () => {
    expect(() => adapter.parse(FIXTURE)).not.toThrow();
    const session = adapter.parse(FIXTURE);
    // u1, a1, u2, u3, a2: 5 user/assistant records produce message rows;
    // ai-title/system/unknown/malformed never do.
    expect(session.messages.length).toBe(5);
  });

  it("counts malformed JSON lines in parseErrors without throwing", () => {
    const session = adapter.parse(FIXTURE);
    expect(session.parseErrors).toBe(1);
  });

  it("flags sidechain records and keeps them out of the default count concern", () => {
    const session = adapter.parse(FIXTURE);
    const u3 = session.messages.find((m) => m.uuid === "u3")!;
    const a2 = session.messages.find((m) => m.uuid === "a2")!;
    expect(u3.isSidechain).toBe(true);
    expect(a2.isSidechain).toBe(true);
  });

  it("derives projectDir from record cwd", () => {
    const session = adapter.parse(FIXTURE);
    expect(session.projectDir).toBe("/home/dev/myapp");
  });

  it("captures gitBranch from records", () => {
    const session = adapter.parse(FIXTURE);
    expect(session.gitBranch).toBe("main");
  });

  it("captures startedAt/endedAt from first/last message timestamps", () => {
    const session = adapter.parse(FIXTURE);
    expect(session.startedAt).toBe("2026-07-01T10:00:00.000Z");
    expect(session.endedAt).toBe("2026-07-01T10:05:05.000Z");
  });

  it("supports partial parse from a byte offset (incremental)", () => {
    const raw = fs.readFileSync(FIXTURE, "utf8");
    const lines = raw.split("\n");
    const firstLineByteLength = Buffer.byteLength(lines[0] + "\n", "utf8");

    const partial = adapter.parse(FIXTURE, firstLineByteLength);
    expect(partial.messages.find((m) => m.uuid === "u1")).toBeUndefined();
    expect(partial.messages.find((m) => m.uuid === "a1")).toBeDefined();
  });

  it("returns no messages when parsing from EOF", () => {
    const size = fs.statSync(FIXTURE).size;
    const partial = adapter.parse(FIXTURE, size);
    expect(partial.messages.length).toBe(0);
    expect(partial.parseErrors).toBe(0);
  });

  it("reports bytesConsumed equal to the full file size on a normal, fully newline-terminated parse", () => {
    const full = adapter.parse(FIXTURE);
    expect(full.bytesConsumed).toBe(fs.statSync(FIXTURE).size);
  });

  it("bytesConsumed accounts for fromByte on a partial parse", () => {
    const raw = fs.readFileSync(FIXTURE, "utf8");
    const firstLineByteLength = Buffer.byteLength(raw.split("\n")[0] + "\n", "utf8");
    const partial = adapter.parse(FIXTURE, firstLineByteLength);
    expect(partial.bytesConsumed).toBe(fs.statSync(FIXTURE).size);
  });

  it("does not consume, parse, or error on a torn trailing line with no newline yet", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-torn-"));
    const filePath = path.join(tmp, "torn-session.jsonl");
    const line1 = JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-01T10:00:00.000Z",
      cwd: "/home/dev/myapp",
      gitBranch: "main",
      isSidechain: false,
      sessionId: "torn-session",
      message: { role: "user", content: "complete line" },
    });
    const torn = '{"type":"user","uuid":"u2","message":{"role":"user","content":"mid-writ';
    fs.writeFileSync(filePath, line1 + "\n" + torn); // no trailing newline on the torn record

    const session = adapter.parse(filePath);
    expect(session.messages.length).toBe(1);
    expect(session.messages[0].uuid).toBe("u1");
    expect(session.parseErrors).toBe(0);
    expect(session.bytesConsumed).toBe(Buffer.byteLength(line1 + "\n", "utf8"));
    expect(session.bytesConsumed).toBeLessThan(fs.statSync(filePath).size);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("consumes nothing and reports no error when the entire read has no newline at all", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-torn2-"));
    const filePath = path.join(tmp, "torn2-session.jsonl");
    fs.writeFileSync(filePath, '{"type":"user","uuid":"u1","message":{"role":"user"'); // no newline anywhere

    const session = adapter.parse(filePath);
    expect(session.messages.length).toBe(0);
    expect(session.parseErrors).toBe(0);
    expect(session.bytesConsumed).toBe(0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not corrupt multi-byte UTF-8 content sitting right at a byte-offset split", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentgrep-utf8-"));
    const filePath = path.join(tmp, "utf8-session.jsonl");
    const line1 = JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-01T10:00:00.000Z",
      cwd: "/home/dev/myapp",
      gitBranch: "main",
      isSidechain: false,
      sessionId: "utf8-session",
      message: { role: "user", content: "café 日本語 🎉 done" },
    });
    const line2 = JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2026-07-01T10:00:01.000Z",
      cwd: "/home/dev/myapp",
      gitBranch: "main",
      isSidechain: false,
      sessionId: "utf8-session",
      message: { role: "user", content: "second message" },
    });
    fs.writeFileSync(filePath, line1 + "\n" + line2 + "\n");

    const full = adapter.parse(filePath);
    expect(full.messages[0].text).toBe("café 日本語 🎉 done");
    expect(full.messages[1].text).toBe("second message");
    expect(full.bytesConsumed).toBe(fs.statSync(filePath).size);

    const offsetAfterLine1 = Buffer.byteLength(line1 + "\n", "utf8");
    const partial = adapter.parse(filePath, offsetAfterLine1);
    expect(partial.messages.length).toBe(1);
    expect(partial.messages[0].text).toBe("second message");
    expect(partial.bytesConsumed).toBe(fs.statSync(filePath).size);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
