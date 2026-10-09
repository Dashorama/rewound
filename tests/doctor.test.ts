import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { analyzeCursorDrift, formatDriftReport } from "../src/doctor.js";

const GLOBAL_SCHEMA_SQL = `
CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);
CREATE TABLE composerHeaders (
  composerId TEXT PRIMARY KEY, workspaceId TEXT,
  createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
  recency INTEGER, checkpointAt INTEGER, value TEXT
);
`;

// Long enough to clear the default minTextLength (40) — the detector's whole
// heuristic is "long strings are content, short ones are labels/ids".
const PROSE = "The user asked for a summary of the failing build and its cause.";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-doctor-"));
  dbPath = path.join(tmpDir, "state.vscdb");
  new Database(dbPath).exec(GLOBAL_SCHEMA_SQL);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Writes a bubble with arbitrary fields, including ones no adapter knows. */
function putBubble(fields: Record<string, unknown>, id = "b1", composerId = "c1"): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `bubbleId:${composerId}:${id}`,
    JSON.stringify({ type: 2, ...fields })
  );
  db.close();
}

function fieldsFound(report: ReturnType<typeof analyzeCursorDrift>): string[] {
  return report.findings.map((f) => f.field);
}

describe("analyzeCursorDrift", () => {
  it("reports an unrecognised field that carries real text", () => {
    putBubble({ text: "hello", someBrandNewCursorField: PROSE });
    const report = analyzeCursorDrift(dbPath);
    expect(fieldsFound(report)).toEqual(["someBrandNewCursorField"]);
    expect(report.findings[0].sampleText).toContain("summary of the failing build");
    expect(report.findings[0].sampleKey).toBe("bubbleId:c1:b1");
    expect(report.scannedBubbles).toBe(1);
  });

  it("says nothing when every field is one the adapter reads", () => {
    putBubble({
      text: PROSE,
      thinking: { text: PROSE },
      codeBlocks: [{ content: PROSE }],
      toolFormerData: { name: "grep", rawArgs: PROSE },
      errorDetails: { message: PROSE },
    });
    const report = analyzeCursorDrift(dbPath);
    expect(report.findings).toEqual([]);
    expect(formatDriftReport(report).join("\n")).toContain("coverage looks complete");
  });

  it("says nothing for fields deliberately ignored, even when they hold long text", () => {
    // richText is a Lexical mirror of `text`; the rest are ids/counters.
    putBubble({ text: "hi", richText: PROSE, requestId: PROSE, capabilityStatuses: { x: [PROSE] } });
    expect(analyzeCursorDrift(dbPath).findings).toEqual([]);
  });

  it("ignores short values — labels and enum strings are not content", () => {
    putBubble({ text: "hi", someNewFlagField: "error" });
    expect(analyzeCursorDrift(dbPath).findings).toEqual([]);
  });

  it("ignores long but opaque values (hashes, uuids, base64 blobs)", () => {
    putBubble({
      text: "hi",
      someHashField: "a".repeat(64),
      someUuidField: "e9986d36-cfea-4687-8609-d77dd15a6ae5-e9986d36-cfea",
      someBlobField: "QUJDREVG".repeat(20),
    });
    expect(analyzeCursorDrift(dbPath).findings).toEqual([]);
  });

  it("finds text nested inside objects and arrays, not just at the top level", () => {
    putBubble({ text: "hi", newNestedField: { items: [{ deep: { note: PROSE } }] } });
    expect(fieldsFound(analyzeCursorDrift(dbPath))).toEqual(["newNestedField"]);
  });

  it("flags when the unknown field is the bubble's ONLY content (a message we drop entirely)", () => {
    putBubble({ mysteryContent: PROSE }); // no text/tools/thinking at all
    const [finding] = analyzeCursorDrift(dbPath).findings;
    expect(finding.field).toBe("mysteryContent");
    expect(finding.inOtherwiseEmptyBubbles).toBe(1);
    expect(formatDriftReport(analyzeCursorDrift(dbPath)).join("\n")).toContain("we index NOTHING for");
  });

  it("does not count a bubble as content-less when the adapter does extract something", () => {
    putBubble({ text: "a real reply", mysteryContent: PROSE });
    expect(analyzeCursorDrift(dbPath).findings[0].inOtherwiseEmptyBubbles).toBe(0);
  });

  it("ranks findings by how many bubbles carry text, and counts both totals", () => {
    putBubble({ rareField: PROSE }, "b1");
    putBubble({ commonField: PROSE }, "b2");
    putBubble({ commonField: PROSE }, "b3");
    putBubble({ commonField: "short" }, "b4"); // non-empty, but not text
    const report = analyzeCursorDrift(dbPath);
    expect(fieldsFound(report)).toEqual(["commonField", "rareField"]);
    expect(report.findings[0]).toMatchObject({ bubblesWithText: 2, bubblesNonEmpty: 3 });
  });

  it("survives a bubble row that is literally null (found in the real store)", () => {
    const db = new Database(dbPath);
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("bubbleId:c1:null1", "null");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("bubbleId:c1:bad1", "not json {");
    db.close();
    putBubble({ newField: PROSE }, "b1");

    const report = analyzeCursorDrift(dbPath);
    expect(fieldsFound(report)).toEqual(["newField"]);
    expect(report.scannedBubbles).toBe(1); // the null and malformed rows aren't counted
  });

  it("skips rows that aren't user/assistant bubbles", () => {
    putBubble({ type: 99, newField: PROSE } as Record<string, unknown>);
    expect(analyzeCursorDrift(dbPath).findings).toEqual([]);
  });

  it("honours minTextLength so the threshold can be tuned", () => {
    putBubble({ text: "hi", shortishField: "just eleven" });
    expect(analyzeCursorDrift(dbPath).findings).toEqual([]);
    expect(fieldsFound(analyzeCursorDrift(dbPath, { minTextLength: 5 }))).toEqual(["shortishField"]);
  });
});
