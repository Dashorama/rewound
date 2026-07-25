import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeCompleteLines } from "../../src/adapters/jsonl.js";

// #2: V8 caps a single string at ~512 MB, so decoding the whole consumed
// region in one toString() aborts the entire index run on transcripts that
// grew past it. The fix decodes in newline-aligned chunks; these tests drive
// the chunked path with a tiny chunkBytes so CI never touches a 512 MB file.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-jsonl-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string | Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("consumeCompleteLines chunked decode", () => {
  it("tiny chunk size yields identical lines and bytesConsumed as one-shot decode", () => {
    const lines = [
      JSON.stringify({ type: "user", text: "héllo wörld" }),
      JSON.stringify({ type: "assistant", text: "emoji 🌍😀 and more" }),
      JSON.stringify({ type: "user", text: "plain ascii line" }),
      JSON.stringify({ type: "assistant", text: "日本語のテキスト" }),
    ];
    const p = writeFile("multi.jsonl", lines.join("\n") + "\n");

    const whole = consumeCompleteLines(p, 0);
    const chunked = consumeCompleteLines(p, 0, 10); // far smaller than any line

    expect(chunked.lines).toEqual(lines);
    expect(chunked.bytesConsumed).toBe(whole.bytesConsumed);
    expect(whole.lines).toEqual(lines);
  });

  it("a single line longer than the chunk is extended, never torn", () => {
    const long = JSON.stringify({ type: "user", text: "x".repeat(500) });
    const short = JSON.stringify({ type: "user", text: "after" });
    const p = writeFile("longline.jsonl", `${long}\n${short}\n`);

    const { lines } = consumeCompleteLines(p, 0, 16);
    expect(lines).toEqual([long, short]);
  });

  it("multi-byte character straddling a chunk boundary is not split", () => {
    // 4-byte emoji positioned so byte offset chunkBytes lands inside it.
    const line = "aaaa😀bbbb";
    const p = writeFile("emoji.jsonl", line + "\n");
    // chunk boundary at byte 6 → inside the emoji's 4-byte sequence (bytes 4-7)
    const { lines } = consumeCompleteLines(p, 0, 6);
    expect(lines).toEqual([line]);
  });

  it("torn trailing line is left unconsumed under chunked decode", () => {
    const complete = JSON.stringify({ type: "user", text: "done" });
    const torn = '{"type":"user","text":"not yet flu';
    const p = writeFile("torn.jsonl", `${complete}\n${torn}`);

    const { lines, bytesConsumed } = consumeCompleteLines(p, 0, 8);
    expect(lines).toEqual([complete]);
    expect(bytesConsumed).toBe(Buffer.byteLength(complete) + 1);
  });

  it("respects fromByte with chunked decode", () => {
    const a = JSON.stringify({ n: 1 });
    const b = JSON.stringify({ n: 2 });
    const p = writeFile("resume.jsonl", `${a}\n${b}\n`);
    const from = Buffer.byteLength(a) + 1;

    const { lines, bytesConsumed } = consumeCompleteLines(p, from, 4);
    expect(lines).toEqual([b]);
    expect(bytesConsumed).toBe(from + Buffer.byteLength(b) + 1);
  });

  it("blank lines are dropped (callers skip them anyway)", () => {
    const a = JSON.stringify({ n: 1 });
    const b = JSON.stringify({ n: 2 });
    const p = writeFile("blanks.jsonl", `${a}\n\n\n${b}\n`);

    const whole = consumeCompleteLines(p, 0);
    const chunked = consumeCompleteLines(p, 0, 5);
    expect(whole.lines).toEqual([a, b]);
    expect(chunked.lines).toEqual([a, b]);
    expect(chunked.bytesConsumed).toBe(whole.bytesConsumed);
  });

  it("empty region (no newline at all) consumes nothing", () => {
    const p = writeFile("nonewline.jsonl", '{"torn":true');
    const { lines, bytesConsumed } = consumeCompleteLines(p, 0, 4);
    expect(lines).toEqual([]);
    expect(bytesConsumed).toBe(0);
  });
});
