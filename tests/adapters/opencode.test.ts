import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";

// Matches the real drizzle schema, verified against a live opencode.db
// (37 sessions / 1723 messages / 6641 parts) — see
// docs-internal/specs/2026-07-21-opencode-adapter-design.md.
const SCHEMA_SQL = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
  slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
  version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_archived INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-opencode-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(dir: string, name = "opencode.db"): { dbPath: string; db: Database.Database } {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  return { dbPath, db };
}

function insertSession(
  db: Database.Database,
  s: { id: string; directory: string; title?: string; parentId?: string | null; timeCreated: number; timeUpdated: number }
): void {
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
     VALUES (@id, 'proj1', @parentId, @id, @directory, @title, '0.1.0', @timeCreated, @timeUpdated)`
  ).run({
    id: s.id,
    parentId: s.parentId ?? null,
    directory: s.directory,
    title: s.title ?? "untitled",
    timeCreated: s.timeCreated,
    timeUpdated: s.timeUpdated,
  });
}

function insertMessage(
  db: Database.Database,
  m: { id: string; sessionId: string; role: "user" | "assistant"; modelID?: string; timeCreated: number; timeUpdated: number }
): void {
  const data: Record<string, unknown> = { role: m.role, time: { created: m.timeCreated } };
  if (m.role === "assistant") data.modelID = m.modelID ?? "big-pickle";
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`
  ).run(m.id, m.sessionId, m.timeCreated, m.timeUpdated, JSON.stringify(data));
}

function insertPart(
  db: Database.Database,
  p: {
    id: string;
    messageId: string;
    sessionId: string;
    type: string;
    text?: string;
    tool?: string;
    output?: string;
    error?: string;
    timeCreated: number;
    timeUpdated: number;
  }
): void {
  let data: Record<string, unknown>;
  if (p.type === "text") data = { type: "text", text: p.text };
  else if (p.type === "tool")
    data = {
      type: "tool",
      tool: p.tool,
      state: p.error ? { status: "error", error: p.error } : { status: "completed", output: p.output },
    };
  else if (p.type === "reasoning") data = { type: "reasoning", text: p.text };
  else data = { type: p.type };
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(p.id, p.messageId, p.sessionId, p.timeCreated, p.timeUpdated, JSON.stringify(data));
}

describe("OpenCodeAdapter.discover", () => {
  it("finds an opencode.db nested under a root directory", () => {
    const nested = path.join(tmpDir, "share", "opencode");
    fs.mkdirSync(nested, { recursive: true });
    const { dbPath } = makeDb(nested);
    expect(new OpenCodeAdapter().discover([tmpDir])).toEqual([dbPath]);
  });

  it("accepts a root that is the db file itself", () => {
    const { dbPath } = makeDb(tmpDir);
    expect(new OpenCodeAdapter().discover([dbPath])).toEqual([dbPath]);
  });

  it("ignores unrelated files and directories", () => {
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "hi");
    fs.mkdirSync(path.join(tmpDir, "empty-dir"));
    expect(new OpenCodeAdapter().discover([tmpDir])).toEqual([]);
  });

  it("does not throw on a root that doesn't exist", () => {
    expect(new OpenCodeAdapter().discover([path.join(tmpDir, "nope")])).toEqual([]);
  });

  it("bounds recursion depth so a pathologically deep tree cannot hang discovery (F7)", () => {
    let dir = tmpDir;
    for (let i = 0; i < 20; i++) dir = path.join(dir, `level${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.db"), "");
    expect(new OpenCodeAdapter().discover([tmpDir])).toEqual([]);
  });
});

describe("OpenCodeAdapter.parseSince — full scan", () => {
  it("maps a user+assistant exchange into one NormalizedSession", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/home/dev/app", title: "fix bug", timeCreated: 1000, timeUpdated: 2000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "prt1", messageId: "msg1", sessionId: "ses1", type: "text", text: "fix the login bug", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg2", sessionId: "ses1", role: "assistant", modelID: "big-pickle", timeCreated: 1500, timeUpdated: 2000 });
    insertPart(db, { id: "prt2", messageId: "msg2", sessionId: "ses1", type: "text", text: "looking at login.ts", timeCreated: 1500, timeUpdated: 1500 });
    db.close();

    const { sessions, cursor } = new OpenCodeAdapter().parseSince(dbPath);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe("ses1");
    expect(s.source).toBe("opencode");
    expect(s.projectDir).toBe("/home/dev/app");
    expect(s.title).toBe("fix bug");
    expect(s.filePath).toBe(dbPath);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ uuid: "msg1", role: "user", text: "fix the login bug", model: undefined });
    expect(s.messages[1]).toMatchObject({ uuid: "msg2", role: "assistant", text: "looking at login.ts", model: "big-pickle" });
    expect(cursor.value).toBe(2000);
  });

  it("routes tool output and reasoning text to toolText, never prose (low-weight, spec-mandated)", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 5000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "assistant", timeCreated: 1000, timeUpdated: 5000 });
    insertPart(db, { id: "p-reason", messageId: "msg1", sessionId: "ses1", type: "reasoning", text: "thinking about the bug", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p-tool", messageId: "msg1", sessionId: "ses1", type: "tool", tool: "bash", output: "no such file", timeCreated: 2000, timeUpdated: 2000 });
    insertPart(db, { id: "p-text", messageId: "msg1", sessionId: "ses1", type: "text", text: "here's the fix", timeCreated: 3000, timeUpdated: 5000 });
    db.close();

    const { sessions } = new OpenCodeAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.text).toBe("here's the fix");
    expect(msg.toolText).toContain("thinking about the bug");
    expect(msg.toolText).toContain("no such file");
    expect(msg.tools).toEqual(["bash"]);
  });

  it("indexes a failed tool call's error text (state.error), not just successful output", () => {
    // Confirmed against the real corpus: state.output and state.error are
    // mutually exclusive — an error-status tool part never carries output.
    // Without reading state.error, a failed command's actual error text
    // (often the only place it's recorded) never enters the index.
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "assistant", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, {
      id: "p-tool-err",
      messageId: "msg1",
      sessionId: "ses1",
      type: "tool",
      tool: "glob",
      error: "ripgrep archive did not contain executable",
      timeCreated: 1000,
      timeUpdated: 1000,
    });
    db.close();

    const { sessions } = new OpenCodeAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.toolText).toContain("ripgrep archive did not contain executable");
    expect(msg.tools).toEqual(["glob"]);
  });

  it("ignores step-start, step-finish, patch, and compaction parts (v1 scope)", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 4000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "assistant", timeCreated: 1000, timeUpdated: 4000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "step-start", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p2", messageId: "msg1", sessionId: "ses1", type: "step-finish", timeCreated: 2000, timeUpdated: 2000 });
    insertPart(db, { id: "p3", messageId: "msg1", sessionId: "ses1", type: "patch", timeCreated: 3000, timeUpdated: 3000 });
    insertPart(db, { id: "p4", messageId: "msg1", sessionId: "ses1", type: "compaction", timeCreated: 4000, timeUpdated: 4000 });
    db.close();

    const { sessions } = new OpenCodeAdapter().parseSince(dbPath);
    const msg = sessions[0].messages[0];
    expect(msg.text).toBe("");
    expect(msg.toolText ?? "").toBe("");
    expect(msg.tools).toEqual([]);
  });

  it("excludes sessions with parent_id set (sub-sessions, v1 scope) but still advances the cursor past their rows", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "parent", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertSession(db, { id: "child", directory: "/tmp", parentId: "parent", timeCreated: 1000, timeUpdated: 2000 });
    insertMessage(db, { id: "msg-child", sessionId: "child", role: "user", timeCreated: 1000, timeUpdated: 2000 });
    insertPart(db, { id: "p1", messageId: "msg-child", sessionId: "child", type: "text", text: "hi", timeCreated: 1000, timeUpdated: 1000 });
    db.close();

    const { sessions, cursor } = new OpenCodeAdapter().parseSince(dbPath);
    expect(sessions.find((s) => s.id === "child")).toBeUndefined();
    expect(cursor.value).toBe(2000);
  });

  it("skips a message row whose parent session no longer exists, without throwing", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertMessage(db, { id: "orphan-msg", sessionId: "missing-session", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p1", messageId: "orphan-msg", sessionId: "missing-session", type: "text", text: "hi", timeCreated: 1000, timeUpdated: 1000 });
    db.close();

    const adapter = new OpenCodeAdapter();
    expect(() => adapter.parseSince(dbPath)).not.toThrow();
    expect(adapter.parseSince(dbPath).sessions).toEqual([]);
  });

  it("skips a message with malformed JSON data, counting a parse error instead of throwing", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 2000 });
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
      "bad-msg",
      "ses1",
      1000,
      1000,
      "not valid json {"
    );
    insertMessage(db, { id: "msg2", sessionId: "ses1", role: "user", timeCreated: 1500, timeUpdated: 2000 });
    insertPart(db, { id: "p1", messageId: "msg2", sessionId: "ses1", type: "text", text: "hello", timeCreated: 1500, timeUpdated: 1500 });
    db.close();

    const { sessions } = new OpenCodeAdapter().parseSince(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messages.map((m) => m.uuid)).toEqual(["msg2"]);
    expect(sessions[0].parseErrors).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a parse error even when the only touched message for a session is malformed (F6)", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
      "bad-msg",
      "ses1",
      1000,
      1000,
      "not valid json {"
    );
    db.close();

    const { sessions } = new OpenCodeAdapter().parseSince(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("ses1");
    expect(sessions[0].messages).toEqual([]);
    expect(sessions[0].parseErrors).toBeGreaterThanOrEqual(1);
  });

  it("picks up a session-only update (e.g. an async title write) even with no message/part activity in the window (F2)", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", title: "untitled", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "text", text: "hi", timeCreated: 1000, timeUpdated: 1000 });

    const adapter = new OpenCodeAdapter();
    const first = adapter.parseSince(dbPath);
    expect(first.sessions[0].title).toBe("untitled");

    // Title arrives asynchronously later (real OpenCode behavior: AI-generated
    // titles land after the session's last message), with no new message/part.
    db.prepare("UPDATE session SET title = ?, time_updated = ? WHERE id = 'ses1'").run("AI-generated title", 9000);
    db.close();

    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].messages).toEqual([]);
    expect(second.sessions[0].title).toBe("AI-generated title");
  });

  it("treats a restored/rolled-back source (whole-db max behind the persisted cursor) as a fresh full scan (F5)", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "text", text: "hello", timeCreated: 1000, timeUpdated: 1000 });
    db.close();

    // A persisted cursor from before an older backup was restored over this
    // db: the cursor is now ahead of anything the (rolled-back) db contains.
    const staleCursor = { value: 99999, tieBreakIds: ["m:some-id-that-no-longer-exists"] };
    const result = new OpenCodeAdapter().parseSince(dbPath, staleCursor);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages[0].uuid).toBe("msg1");
  });
});

describe("OpenCodeAdapter.parseSince — incremental resume (watermark cursor)", () => {
  it("returns nothing when nothing changed since the cursor", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "text", text: "hi", timeCreated: 1000, timeUpdated: 1000 });
    db.close();

    const adapter = new OpenCodeAdapter();
    const first = adapter.parseSince(dbPath);
    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toEqual([]);
    expect(second.cursor).toEqual(first.cursor);
  });

  it("rebuilds a message's full text when a new part streams into it after it was already indexed", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "assistant", modelID: "m", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "text", text: "first part", timeCreated: 1000, timeUpdated: 1000 });

    const adapter = new OpenCodeAdapter();
    const first = adapter.parseSince(dbPath);
    expect(first.sessions[0].messages[0].text).toBe("first part");

    insertPart(db, { id: "p2", messageId: "msg1", sessionId: "ses1", type: "text", text: "second part", timeCreated: 2000, timeUpdated: 2000 });
    db.prepare("UPDATE message SET time_updated = 2000 WHERE id = 'msg1'").run();
    db.close();

    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].messages).toHaveLength(1);
    expect(second.sessions[0].messages[0].uuid).toBe("msg1");
    expect(second.sessions[0].messages[0].text).toBe("first part\n\nsecond part");
  });

  it("picks up a message whose own time_updated changed even when none of its parts did", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "assistant", modelID: "m", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "text", text: "answer", timeCreated: 1000, timeUpdated: 1000 });

    const adapter = new OpenCodeAdapter();
    const first = adapter.parseSince(dbPath);

    db.prepare("UPDATE message SET time_updated = 5000 WHERE id = 'msg1'").run();
    db.close();

    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].messages[0].uuid).toBe("msg1");
    expect(second.cursor.value).toBe(5000);
  });

  it("does not skip a new part landing at the exact tied timestamp of a message already accounted for (F3, row-granular tie-break)", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 5000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "assistant", timeCreated: 1000, timeUpdated: 5000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "text", text: "first", timeCreated: 1000, timeUpdated: 5000 });

    const adapter = new OpenCodeAdapter();
    const first = adapter.parseSince(dbPath);
    expect(first.cursor.value).toBe(5000);

    // A second part lands on the SAME message, tied at the exact same ms.
    // Message-granular tie-breaking would treat msg1 as "already seen" (it's
    // in tieBreakIds from run 1) and wrongly skip this — row-granular must
    // catch it since p2's own row id was never scanned before.
    insertPart(db, { id: "p2", messageId: "msg1", sessionId: "ses1", type: "text", text: "second", timeCreated: 1000, timeUpdated: 5000 });
    db.close();

    const second = adapter.parseSince(dbPath, first.cursor);
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].messages[0].text).toBe("first\n\nsecond");
  });

  it("does not permanently lose a distinct message that ties the exact cursor timestamp of one already seen", () => {
    // Confirmed against the real opencode.db: distinct rows sharing an
    // identical epoch-ms time_updated are not hypothetical (multiple parts
    // land in the same millisecond routinely). A bare max(time_updated)
    // cursor with a strict "> " boundary would exclude msgB forever, since
    // its time_updated ties the value already persisted from run 1.
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 5000 });
    insertMessage(db, { id: "msgA", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 5000 });
    insertPart(db, { id: "pA", messageId: "msgA", sessionId: "ses1", type: "text", text: "first", timeCreated: 1000, timeUpdated: 5000 });

    const adapter = new OpenCodeAdapter();
    const first = adapter.parseSince(dbPath);
    expect(first.cursor.value).toBe(5000);

    // A second, DISTINCT message arrives later but happens to tie the exact
    // same time_updated value the previous run already advanced past.
    insertMessage(db, { id: "msgB", sessionId: "ses1", role: "user", timeCreated: 6000, timeUpdated: 5000 });
    insertPart(db, { id: "pB", messageId: "msgB", sessionId: "ses1", type: "text", text: "second, tied timestamp", timeCreated: 6000, timeUpdated: 5000 });
    db.close();

    const second = adapter.parseSince(dbPath, first.cursor);
    const seenUuids = second.sessions.flatMap((s) => s.messages.map((m) => m.uuid));
    expect(seenUuids).toContain("msgB");
  });

  it("stays a true no-op on a third run when nothing changed after the tie was already accounted for", () => {
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 5000 });
    insertMessage(db, { id: "msgA", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 5000 });
    insertPart(db, { id: "pA", messageId: "msgA", sessionId: "ses1", type: "text", text: "first", timeCreated: 1000, timeUpdated: 5000 });
    insertMessage(db, { id: "msgB", sessionId: "ses1", role: "user", timeCreated: 6000, timeUpdated: 5000 });
    insertPart(db, { id: "pB", messageId: "msgB", sessionId: "ses1", type: "text", text: "second, tied timestamp", timeCreated: 6000, timeUpdated: 5000 });
    db.close();

    const adapter = new OpenCodeAdapter();
    const first = adapter.parseSince(dbPath); // catches both msgA and msgB in one pass
    const second = adapter.parseSince(dbPath, first.cursor); // nothing new: must be empty
    expect(second.sessions).toEqual([]);
  });
});

describe("OpenCodeAdapter.parseSince — safe reads from a live/shared database", () => {
  it("opens the database strictly read-only, working even when the file and its directory cannot be written", () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses permission bits
    const { dbPath, db } = makeDb(tmpDir);
    insertSession(db, { id: "ses1", directory: "/tmp", timeCreated: 1000, timeUpdated: 1000 });
    insertMessage(db, { id: "msg1", sessionId: "ses1", role: "user", timeCreated: 1000, timeUpdated: 1000 });
    insertPart(db, { id: "p1", messageId: "msg1", sessionId: "ses1", type: "text", text: "hi", timeCreated: 1000, timeUpdated: 1000 });
    db.close();

    fs.chmodSync(dbPath, 0o444);
    fs.chmodSync(tmpDir, 0o555);
    try {
      const adapter = new OpenCodeAdapter();
      expect(() => adapter.parseSince(dbPath)).not.toThrow();
      expect(adapter.parseSince(dbPath).sessions).toHaveLength(1);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
      fs.chmodSync(dbPath, 0o644);
    }
  });
});
