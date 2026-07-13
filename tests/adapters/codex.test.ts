import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../../src/adapters/codex.js";

function writeRollout(dir: string, name: string, lines: unknown[]): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const UUID = "0198c0ee-aaaa-bbbb-cccc-1234567890ab";

function sampleLines(): unknown[] {
  return [
    { timestamp: "2026-06-01T10:00:00.000Z", type: "session_meta", payload: { id: UUID, cwd: "/home/dev/api-server", originator: "codex_cli_rs", cli_version: "0.5.0", git: { branch: "fix/timeouts" } } },
    { timestamp: "2026-06-01T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.2-codex" } },
    { timestamp: "2026-06-01T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "the gateway keeps timing out on long uploads" }] } },
    { timestamp: "2026-06-01T10:00:10.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Looking at proxy read timeout settings first." }] } },
    { timestamp: "2026-06-01T10:00:12.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":[\"grep\",\"timeout\",\"nginx.conf\"]}" } },
    { timestamp: "2026-06-01T10:00:13.000Z", type: "response_item", payload: { type: "function_call_output", output: "proxy_read_timeout 60s;\nclient_max_body_size 10m;" } },
    { timestamp: "2026-06-01T10:00:20.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The proxy read timeout is 60s while uploads take longer — raising it and the body size limit." }] } },
    { timestamp: "2026-06-01T10:00:21.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000 } } } },
    { timestamp: "2026-06-01T10:00:22.000Z", type: "compacted", payload: { message: "history compacted" } },
  ];
}

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  function parseSample() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-codex-"));
    const p = writeRollout(tmp, `2026/06/01/rollout-2026-06-01T10-00-00-${UUID}.jsonl`, sampleLines());
    const session = adapter.parse(p);
    return { tmp, p, session };
  }

  it("discovers only rollout-*.jsonl files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-codex-disc-"));
    writeRollout(tmp, `2026/06/01/rollout-2026-06-01T10-00-00-${UUID}.jsonl`, sampleLines());
    writeRollout(tmp, "2026/06/01/not-a-rollout.jsonl", [{}]);
    const found = adapter.discover([tmp]);
    expect(found.length).toBe(1);
    expect(found[0]).toMatch(/rollout-.*\.jsonl$/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("derives the session id from the rollout filename uuid (stable across incremental chunks)", () => {
    const { tmp, session } = parseSample();
    expect(session.id).toBe(UUID);
    expect(session.source).toBe("codex");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("takes projectDir and branch from session_meta (cwd-derived)", () => {
    const { tmp, session } = parseSample();
    expect(session.projectDir).toBe("/home/dev/api-server");
    expect(session.projectDirSource).toBe("cwd");
    expect(session.gitBranch).toBe("fix/timeouts");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("maps user/assistant messages, reasoning as prose, tool calls and outputs", () => {
    const { tmp, session } = parseSample();
    const texts = session.messages.map((m) => ({ role: m.role, text: m.text, toolText: m.toolText, tools: m.tools }));
    expect(texts.some((m) => m.role === "user" && m.text.includes("gateway keeps timing out"))).toBe(true);
    expect(texts.some((m) => m.role === "assistant" && m.text.includes("proxy read timeout settings"))).toBe(true); // reasoning
    expect(texts.some((m) => m.role === "assistant" && (m.tools ?? []).includes("shell"))).toBe(true);
    expect(texts.some((m) => m.role === "user" && (m.toolText ?? "").includes("proxy_read_timeout 60s"))).toBe(true);
    const answer = session.messages.find((m) => m.text.includes("raising it and the body size limit"))!;
    expect(answer.model).toBe("gpt-5.2-codex");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("skips compacted/event_msg noise without parse errors and supports byte-offset resume", () => {
    const { tmp, p, session } = parseSample();
    expect(session.parseErrors).toBe(0);
    expect(session.bytesConsumed).toBe(fs.statSync(p).size);

    const partial = adapter.parse(p, session.bytesConsumed);
    expect(partial.messages.length).toBe(0);
    expect(partial.parseErrors).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("never consumes a torn trailing line", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-codex-torn-"));
    const p = writeRollout(tmp, `rollout-2026-06-01T10-00-00-${UUID}.jsonl`, sampleLines());
    fs.appendFileSync(p, '{"timestamp":"2026-06-01T10:01:00.000Z","type":"response_item","payload":{"type":"mess');
    const session = adapter.parse(p);
    expect(session.parseErrors).toBe(0);
    expect(session.bytesConsumed).toBeLessThan(fs.statSync(p).size);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
