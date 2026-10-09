import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { CursorAdapter } from "../../src/adapters/cursor.js";

// Matches the real schema, verified against a live, in-use Cursor install
// (74,691 bubbles / 851 composers) — see
// docs-internal/specs/2026-08-26-cursor-adapter-design.md and
// docs-internal/specs/2026-09-09-cursor-completeness-audit.md.
const GLOBAL_SCHEMA_SQL = `
CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);
CREATE TABLE composerHeaders (
  composerId TEXT PRIMARY KEY, workspaceId TEXT,
  createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
  recency INTEGER, checkpointAt INTEGER, value TEXT
);
`;
const WORKSPACE_SCHEMA_SQL = `CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);`;

// MAX_COMPOSERS_PER_CALL in cursor.ts — not exported, kept in sync by hand.
const MAX_COMPOSERS_PER_CALL = 50;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-cursor-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mirrors the real layout: <root>/User/globalStorage/state.vscdb, so `root`
// here is what a caller would pass as a --cursor-roots entry.
function makeGlobalDb(root: string): { dbPath: string; db: Database.Database } {
  const dir = path.join(root, "User", "globalStorage");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec(GLOBAL_SCHEMA_SQL);
  return { dbPath, db };
}

function insertComposerData(
  db: Database.Database,
  c: { composerId: string; name?: string; createdAt?: number; headers: Array<{ bubbleId: string; type: 1 | 2 }> }
): void {
  const value = JSON.stringify({
    composerId: c.composerId,
    name: c.name,
    createdAt: c.createdAt,
    fullConversationHeadersOnly: c.headers,
  });
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${c.composerId}`, value);
}

interface BubbleFixture {
  composerId: string;
  bubbleId: string;
  type: 1 | 2;
  text?: string;
  createdAt?: number;
  thinking?: { text?: string };
  serviceStatusUpdate?: { message?: string };
  errorDetails?: { message?: string; error?: string; stackTrace?: string };
  toolFormerData?: {
    name?: string;
    status?: string;
    additionalData?: { status?: string };
    rawArgs?: string;
    params?: string;
    result?: string;
  };
  codeBlocks?: Array<{ uri?: { _fsPath?: string }; content?: string }>;
}

function insertBubble(db: Database.Database, b: BubbleFixture): void {
  const value = JSON.stringify({
    type: b.type,
    text: b.text,
    createdAt: b.createdAt,
    thinking: b.thinking,
    serviceStatusUpdate: b.serviceStatusUpdate,
    errorDetails: b.errorDetails,
    toolFormerData: b.toolFormerData,
    codeBlocks: b.codeBlocks,
  });
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `bubbleId:${b.composerId}:${b.bubbleId}`,
    value
  );
}

function insertComposerHeader(
  db: Database.Database,
  h: { composerId: string; recency: number; fsPath: string; lastUpdatedAt?: number | null }
): void {
  const value = JSON.stringify({
    type: "head",
    composerId: h.composerId,
    workspaceIdentifier: { id: "ws1", uri: { fsPath: h.fsPath } },
  });
  db.prepare(
    `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value)
     VALUES (@composerId, 'ws1', @recency, @lastUpdatedAt, 0, 0, @recency, @recency, @value)`
  ).run({
    composerId: h.composerId,
    recency: h.recency,
    lastUpdatedAt: h.lastUpdatedAt === undefined ? h.recency : h.lastUpdatedAt,
    value,
  });
}

// The workspaceStorage/<hash>/ fallback path a legacy (headerless) composer
// resolves its project dir through.
function makeWorkspaceStorage(
  root: string,
  ws: { hash: string; folder: string; composerIds: string[] }
): void {
  const dir = path.join(root, "User", "workspaceStorage", ws.hash);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ folder: `file://${ws.folder}` }));
  const db = new Database(path.join(dir, "state.vscdb"));
  db.exec(WORKSPACE_SCHEMA_SQL);
  const value = JSON.stringify({ allComposers: ws.composerIds.map((composerId) => ({ composerId })) });
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", value);
  db.close();
}

describe("CursorAdapter.discover", () => {
  it("finds state.vscdb under <root>/User/globalStorage", () => {
    const { dbPath } = makeGlobalDb(tmpDir);
    expect(new CursorAdapter().discover([tmpDir])).toEqual([dbPath]);
  });

  it("finds state.vscdb when root is already the User dir (<root>/globalStorage)", () => {
    const dir = path.join(tmpDir, "globalStorage");
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "state.vscdb");
    new Database(dbPath).exec(GLOBAL_SCHEMA_SQL);
    expect(new CursorAdapter().discover([tmpDir])).toEqual([dbPath]);
  });

  it("does not throw and returns [] for a root with no Cursor data", () => {
    expect(new CursorAdapter().discover([path.join(tmpDir, "nope")])).toEqual([]);
  });
});

describe("CursorAdapter.parseSince — project-dir resolution", () => {
  it("resolves via composerHeaders (fast path, cwd-sourced)", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", name: "fix bug", createdAt: 1000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 1, text: "fix the login bug", createdAt: 1000 });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/home/dev/app" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "c1", source: "cursor", projectDir: "/home/dev/app", projectDirSource: "cwd", title: "fix bug" });
  });

  it("falls back to workspaceStorage/workspace.json for a composer with no header row", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "legacy1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "legacy1", bubbleId: "b1", type: 1, text: "hello", createdAt: 1000 });
    db.close();
    makeWorkspaceStorage(tmpDir, { hash: "hash1", folder: "/home/dev/legacy-app", composerIds: ["legacy1"] });

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ projectDir: "/home/dev/legacy-app", projectDirSource: "fallback" });
  });

  it("skips a composer whose project dir resolves via neither path, rather than guessing", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "orphan1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "orphan1", bubbleId: "b1", type: 1, text: "hello", createdAt: 1000 });
    db.close();
    // No composerHeaders row and no workspaceStorage at all.

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions).toEqual([]);
  });
});

describe("CursorAdapter.parseSince — message content extraction", () => {
  it("maps user/assistant bubbles into one NormalizedSession in conversation order", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, {
      composerId: "c1",
      name: "fix bug",
      createdAt: 1000,
      headers: [
        { bubbleId: "b1", type: 1 },
        { bubbleId: "b2", type: 2 },
      ],
    });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 1, text: "fix the login bug", createdAt: 1000 });
    insertBubble(db, { composerId: "c1", bubbleId: "b2", type: 2, text: "looking at login.ts", createdAt: 2000 });
    insertComposerHeader(db, { composerId: "c1", recency: 2000, fsPath: "/home/dev/app" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages).toHaveLength(2);
    expect(sessions[0].messages[0]).toMatchObject({ uuid: "b1", role: "user", text: "fix the login bug" });
    expect(sessions[0].messages[1]).toMatchObject({ uuid: "b2", role: "assistant", text: "looking at login.ts" });
  });

  it("captures a tool call's name and folds rawArgs/params/result into toolText", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      toolFormerData: {
        name: "run_terminal_cmd",
        rawArgs: JSON.stringify({ command: "ls -la" }),
        result: JSON.stringify({ output: "total 12\ndrwxr-xr-x  file.ts" }),
      },
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.tools).toEqual(["run_terminal_cmd"]);
    expect(msg.toolText).toContain("ls -la");
    expect(msg.toolText).toContain("total 12");
  });

  it("reads params for edit_file_v2, the one tool with no rawArgs at all", () => {
    // Confirmed against real data: edit_file_v2's diff (streamingContent)
    // lives ONLY in params — rawArgs is absent, unlike every other edit tool.
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      toolFormerData: {
        name: "edit_file_v2",
        params: JSON.stringify({ relativeWorkspacePath: "a.ts", streamingContent: "@@\n-old\n+new" }),
        result: JSON.stringify({ beforeContentId: "composer.content.abc123", afterContentId: "composer.content.def456" }),
      },
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.toolText).toContain("@@\n-old\n+new");
    // The content-hash refs carry no text of their own — must not appear as noise.
    expect(msg.toolText).not.toContain("composer.content.");
  });

  it("captures thinking text and a service-status note, both folded into toolText (low-weight, not prose)", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, {
      composerId: "c1",
      createdAt: 1000,
      headers: [
        { bubbleId: "b1", type: 2 },
        { bubbleId: "b2", type: 2 },
      ],
    });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 2, createdAt: 1000, thinking: { text: "planning the fix" } });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b2",
      type: 2,
      createdAt: 2000,
      serviceStatusUpdate: { message: "Switched to Composer 2 after reaching API limit." },
    });
    insertComposerHeader(db, { composerId: "c1", recency: 2000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages[0].text).toBe("");
    expect(sessions[0].messages[0].toolText).toBe("planning the fix");
    expect(sessions[0].messages[1].toolText).toBe("Switched to Composer 2 after reaching API limit.");
  });

  it("captures codeBlocks content, prefixed with its file path", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      codeBlocks: [{ uri: { _fsPath: "/home/dev/app/index.tsx" }, content: "import { registerRootComponent } from 'expo'" }],
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/home/dev/app" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.toolText).toContain("/home/dev/app/index.tsx");
    expect(msg.toolText).toContain("import { registerRootComponent } from 'expo'");
  });

  it("recovers a bubble that would otherwise be skipped entirely when codeBlocks is its only content", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      // no text, no toolFormerData, no thinking — codeBlocks alone.
      codeBlocks: [{ uri: { _fsPath: "/tmp/a.ts" }, content: "const x = 1;" }],
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages).toHaveLength(1);
    expect(sessions[0].messages[0].toolText).toContain("const x = 1;");
  });

  it("records a failed tool call's status, which is otherwise nowhere in the record", () => {
    // 887 named tool calls failed on the reference install and currently read
    // as indistinguishable from successful ones. additionalData.status wins
    // over the top-level one: "completed" there means the request finished,
    // not that the tool succeeded.
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      toolFormerData: { name: "grep", status: "completed", additionalData: { status: "error" }, rawArgs: JSON.stringify({ pattern: "foo" }) },
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.tools).toEqual(["grep"]);
    expect(msg.toolText).toContain("tool call status: error");
  });

  it("does not annotate a status for an ordinary successful tool call", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      toolFormerData: { name: "grep", status: "completed", additionalData: { status: "success" }, rawArgs: JSON.stringify({ pattern: "foo" }) },
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages[0].toolText).not.toContain("tool call status");
  });

  it("recovers a tool call that failed before its name was ever recorded", () => {
    // 1,308 of these on the reference install: no name, no args, no result —
    // status is literally all that survives, so without it the bubble looks
    // empty and gets skipped entirely.
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      toolFormerData: { additionalData: { status: "error" } },
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages).toHaveLength(1);
    expect(sessions[0].messages[0].tools).toEqual([]); // no real name to report
    expect(sessions[0].messages[0].toolText).toContain("tool call status: error");
  });

  it("captures errorDetails message and detail text, but not the internal stack trace", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, {
      composerId: "c1",
      bubbleId: "b1",
      type: 2,
      createdAt: 1000,
      errorDetails: {
        message: "Error [unavailable]",
        error: JSON.stringify({
          error: "ERROR_OPENAI",
          details: { title: "Unable to reach the model provider", detail: "This might be temporary." },
        }),
        stackTrace: "ConnectError: [unavailable] Error\n    at nTa.$endAiConnectTransportReportError (vscode-file://...)",
      },
    });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.toolText).toContain("Error [unavailable]");
    expect(msg.toolText).toContain("Unable to reach the model provider");
    // Cursor's own internal JS stack is noise, never indexed.
    expect(msg.toolText).not.toContain("vscode-file://");
  });

  it("skips a bubble with nothing in text/tools/toolText (not an error, expected)", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, {
      composerId: "c1",
      createdAt: 1000,
      headers: [
        { bubbleId: "empty", type: 2 },
        { bubbleId: "real", type: 2 },
      ],
    });
    insertBubble(db, { composerId: "c1", bubbleId: "empty", type: 2, createdAt: 1000 });
    insertBubble(db, { composerId: "c1", bubbleId: "real", type: 2, text: "here's the fix", createdAt: 2000 });
    insertComposerHeader(db, { composerId: "c1", recency: 2000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages.map((m) => m.uuid)).toEqual(["real"]);
    expect(sessions[0].parseErrors).toBe(0); // expected, not malformed data
  });

  it("skips a whitespace-only bubble the same as a truly empty one", () => {
    // Confirmed real: Cursor logs bare "\n\n\n" formatting-gap turns between
    // streamed tool calls — not malformed, just nothing worth showing.
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 2 }] });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 2, text: "\n\n\n", createdAt: 1000 });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages).toEqual([]);
  });

  it("falls back to the composer's own createdAt when a bubble has none", () => {
    // Confirmed real: ~32% of bubbles have no createdAt of their own.
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 5000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 1, text: "hi" }); // no createdAt
    insertComposerHeader(db, { composerId: "c1", recency: 5000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages[0].ts).toBe(new Date(5000).toISOString());
  });

  it("counts a parse error for malformed bubble JSON without throwing, and keeps other messages", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, {
      composerId: "c1",
      createdAt: 1000,
      headers: [
        { bubbleId: "bad", type: 1 },
        { bubbleId: "good", type: 1 },
      ],
    });
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("bubbleId:c1:bad", "not valid json {");
    insertBubble(db, { composerId: "c1", bubbleId: "good", type: 1, text: "hello", createdAt: 2000 });
    insertComposerHeader(db, { composerId: "c1", recency: 2000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages.map((m) => m.uuid)).toEqual(["good"]);
    expect(sessions[0].parseErrors).toBe(1);
  });
});

describe("CursorAdapter.parseSince — legacy pre-_v composers (inline `conversation`)", () => {
  // 147 composers / 2,840 messages on the reference install store the whole
  // conversation inline instead of using fullConversationHeadersOnly, and
  // 2,818 of those bubbles have NO bubbleId: KV row — the inline object is
  // the only copy. Without reading it the entire conversation indexes empty.
  function insertLegacyComposer(
    db: Database.Database,
    c: { composerId: string; createdAt?: number; conversation: Array<Record<string, unknown>> }
  ): void {
    const value = JSON.stringify({
      composerId: c.composerId,
      createdAt: c.createdAt,
      conversation: c.conversation, // note: no fullConversationHeadersOnly at all
    });
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${c.composerId}`, value);
  }

  it("reads bubbles inline from `conversation` when there is no KV row for them", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertLegacyComposer(db, {
      composerId: "old1",
      createdAt: 1000,
      conversation: [
        { bubbleId: "b1", type: 1, text: "Can we make this effect better?" },
        { bubbleId: "b2", type: 2, text: "Here's an enhanced version:" },
      ],
    });
    insertComposerHeader(db, { composerId: "old1", recency: 1000, fsPath: "/home/dev/3dworld" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messages.map((m) => m.uuid)).toEqual(["b1", "b2"]);
    expect(sessions[0].messages[0].text).toBe("Can we make this effect better?");
    expect(sessions[0].messages[1].role).toBe("assistant");
  });

  it("applies the same extraction rules to inline bubbles (codeBlocks, tool status)", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertLegacyComposer(db, {
      composerId: "old1",
      createdAt: 1000,
      conversation: [
        { bubbleId: "b1", type: 2, codeBlocks: [{ uri: { _fsPath: "/tmp/a.js" }, content: "const x = 1;" }] },
        { bubbleId: "b2", type: 2, toolFormerData: { name: "grep", additionalData: { status: "error" } } },
      ],
    });
    insertComposerHeader(db, { composerId: "old1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    const [cb, tool] = sessions[0].messages;
    expect(cb.toolText).toContain("const x = 1;");
    expect(tool.tools).toEqual(["grep"]);
    expect(tool.toolText).toContain("tool call status: error");
  });

  it("prefers the KV row over the inline copy when both exist", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertLegacyComposer(db, {
      composerId: "old1",
      createdAt: 1000,
      conversation: [{ bubbleId: "b1", type: 2, text: "stale inline copy" }],
    });
    insertBubble(db, { composerId: "old1", bubbleId: "b1", type: 2, text: "fresher KV copy", createdAt: 1000 });
    insertComposerHeader(db, { composerId: "old1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages[0].text).toBe("fresher KV copy");
  });

  it("ignores `conversation` when a modern header list is present (no double-indexing)", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    // A composer carrying BOTH shapes must not yield the same message twice.
    const value = JSON.stringify({
      composerId: "c1",
      createdAt: 1000,
      fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }],
      conversation: [{ bubbleId: "b1", type: 1, text: "inline copy" }],
    });
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("composerData:c1", value);
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 1, text: "kv copy", createdAt: 1000 });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions[0].messages).toHaveLength(1);
    expect(sessions[0].messages[0].text).toBe("kv copy");
  });
});

describe("CursorAdapter.parseSince — watermark on recency, not lastUpdatedAt", () => {
  it("still indexes a composer whose lastUpdatedAt is NULL (recency is never NULL)", () => {
    // The actual bug found and fixed: ~19% of composerHeaders rows on the
    // reference install have NULL lastUpdatedAt, which a naive
    // `WHERE lastUpdatedAt >= ?` scan silently drops forever.
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 1, text: "hi", createdAt: 1000 });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp", lastUpdatedAt: null });
    db.close();

    const { sessions } = new CursorAdapter().parseSince(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("c1");
  });
});

describe("CursorAdapter.parseSince — batching a large backfill", () => {
  it("caps a single call to MAX_COMPOSERS_PER_CALL headered composers, continuing on the next call", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    const total = MAX_COMPOSERS_PER_CALL + 5;
    for (let i = 0; i < total; i++) {
      const id = `c${i}`;
      insertComposerData(db, { composerId: id, createdAt: i, headers: [{ bubbleId: "b1", type: 1 }] });
      insertBubble(db, { composerId: id, bubbleId: "b1", type: 1, text: `message ${i}`, createdAt: i });
      insertComposerHeader(db, { composerId: id, recency: i, fsPath: "/tmp" });
    }
    db.close();

    const adapter = new CursorAdapter();
    const first = adapter.parseSince(dbPath);
    expect(first.sessions).toHaveLength(MAX_COMPOSERS_PER_CALL);

    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toHaveLength(5);

    const allIds = new Set([...first.sessions, ...second.sessions].map((s) => s.id));
    expect(allIds.size).toBe(total); // no duplicates, nothing missing
  });

  it("does not drop a composer tied at the exact recency boundary a batch cut off mid-tie", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    // MAX_COMPOSERS_PER_CALL - 1 composers at distinct earlier recencies,
    // then TWO composers sharing the exact recency value that lands right on
    // the batch boundary.
    for (let i = 0; i < MAX_COMPOSERS_PER_CALL - 1; i++) {
      const id = `c${i}`;
      insertComposerData(db, { composerId: id, createdAt: i, headers: [{ bubbleId: "b1", type: 1 }] });
      insertBubble(db, { composerId: id, bubbleId: "b1", type: 1, text: "x", createdAt: i });
      insertComposerHeader(db, { composerId: id, recency: i, fsPath: "/tmp" });
    }
    for (const id of ["tieA", "tieB"]) {
      insertComposerData(db, { composerId: id, createdAt: 9999, headers: [{ bubbleId: "b1", type: 1 }] });
      insertBubble(db, { composerId: id, bubbleId: "b1", type: 1, text: "tied", createdAt: 9999 });
      insertComposerHeader(db, { composerId: id, recency: 9999, fsPath: "/tmp" });
    }
    db.close();

    const adapter = new CursorAdapter();
    const first = adapter.parseSince(dbPath);
    const second = adapter.parseSince(dbPath, first.cursor);
    const allIds = new Set([...first.sessions, ...second.sessions].map((s) => s.id));
    expect(allIds.has("tieA")).toBe(true);
    expect(allIds.has("tieB")).toBe(true);
  });
});

describe("CursorAdapter.parseSince — incremental resume", () => {
  it("returns nothing when nothing changed since the cursor", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 1, text: "hi", createdAt: 1000 });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });
    db.close();

    const adapter = new CursorAdapter();
    const first = adapter.parseSince(dbPath);
    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toEqual([]);
  });

  it("picks up a composer whose recency advances after the first pass", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "c1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "c1", bubbleId: "b1", type: 1, text: "hi", createdAt: 1000 });
    insertComposerHeader(db, { composerId: "c1", recency: 1000, fsPath: "/tmp" });

    const adapter = new CursorAdapter();
    const first = adapter.parseSince(dbPath);
    expect(first.sessions).toHaveLength(1);

    insertBubble(db, { composerId: "c1", bubbleId: "b2", type: 2, text: "reply", createdAt: 2000 });
    // Real Cursor rewrites composerData's fullConversationHeadersOnly to
    // include the new bubble whenever one streams in — mirror that.
    db.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = 'composerData:c1'").run(
      JSON.stringify({
        composerId: "c1",
        createdAt: 1000,
        fullConversationHeadersOnly: [
          { bubbleId: "b1", type: 1 },
          { bubbleId: "b2", type: 2 },
        ],
      })
    );
    db.prepare("UPDATE composerHeaders SET recency = 2000, lastUpdatedAt = 2000 WHERE composerId = 'c1'").run();
    db.close();

    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].messages.map((m) => m.uuid)).toEqual(["b1", "b2"]);
  });

  it("treats a legacy (headerless) composer as static once indexed — a new one still gets picked up", () => {
    const { dbPath, db } = makeGlobalDb(tmpDir);
    insertComposerData(db, { composerId: "legacy1", createdAt: 1000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db, { composerId: "legacy1", bubbleId: "b1", type: 1, text: "hi", createdAt: 1000 });
    db.close();
    makeWorkspaceStorage(tmpDir, { hash: "hash1", folder: "/tmp", composerIds: ["legacy1"] });

    const adapter = new CursorAdapter();
    const first = adapter.parseSince(dbPath);
    expect(first.sessions.map((s) => s.id)).toEqual(["legacy1"]);

    // A second legacy composer appears later — must still be picked up even
    // though legacy1 (already seen) is correctly never re-touched.
    const db2 = new Database(dbPath);
    insertComposerData(db2, { composerId: "legacy2", createdAt: 2000, headers: [{ bubbleId: "b1", type: 1 }] });
    insertBubble(db2, { composerId: "legacy2", bubbleId: "b1", type: 1, text: "second", createdAt: 2000 });
    db2.close();
    fs.rmSync(path.join(tmpDir, "User", "workspaceStorage", "hash1"), { recursive: true, force: true });
    makeWorkspaceStorage(tmpDir, { hash: "hash1", folder: "/tmp", composerIds: ["legacy1", "legacy2"] });

    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions.map((s) => s.id)).toEqual(["legacy2"]);
  });
});
