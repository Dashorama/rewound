import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, upsertSessionMessages, getSession, searchMessagesRaw, markSessionArchived } from "../src/db.js";
import { mergeDb, exportSnapshot, syncDir } from "../src/sync.js";
import type { NormalizedSession } from "../src/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-sync-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeSession(id: string, msgs: Array<{ uuid: string; text: string; ts: string }>): NormalizedSession {
  return {
    id,
    source: "claude-code",
    projectDir: "/home/dev/myapp",
    projectDirSource: "cwd",
    filePath: `/x/${id}.jsonl`,
    title: `Session ${id}`,
    gitBranch: "main",
    startedAt: msgs[0]?.ts,
    endedAt: msgs[msgs.length - 1]?.ts,
    parseErrors: 0,
    bytesConsumed: 0,
    messages: msgs.map((m) => ({
      uuid: m.uuid,
      role: "user" as const,
      ts: m.ts,
      text: m.text,
      tools: [],
      isSidechain: false,
    })),
  };
}

function dbAt(name: string): Database.Database {
  return openDb(path.join(tmp, name));
}

describe("mergeDb", () => {
  it("unions sessions the local db does not have", () => {
    const local = dbAt("local.db");
    const other = dbAt("other.db");
    upsertSessionMessages(local, makeSession("s-local", [{ uuid: "l1", text: "local only fact", ts: "2026-07-01T10:00:00.000Z" }]), { mode: "replace" });
    upsertSessionMessages(other, makeSession("s-other", [{ uuid: "o1", text: "remote only fact", ts: "2026-07-02T10:00:00.000Z" }]), { mode: "replace" });
    other.close();

    const stats = mergeDb(local, path.join(tmp, "other.db"));
    expect(stats.sessionsAdded).toBe(1);
    expect(stats.sessionsUpdated).toBe(0);
    expect(getSession(local, "s-other")?.messageCount).toBe(1);
    expect(getSession(local, "s-local")?.messageCount).toBe(1);
    local.close();
  });

  it("keeps the richer copy on collision (more messages wins, both directions)", () => {
    const local = dbAt("local.db");
    const other = dbAt("other.db");
    upsertSessionMessages(local, makeSession("s-both", [{ uuid: "m1", text: "first", ts: "2026-07-01T10:00:00.000Z" }]), { mode: "replace" });
    upsertSessionMessages(
      other,
      makeSession("s-both", [
        { uuid: "m1", text: "first", ts: "2026-07-01T10:00:00.000Z" },
        { uuid: "m2", text: "second richer", ts: "2026-07-01T10:01:00.000Z" },
      ]),
      { mode: "replace" }
    );
    other.close();

    const stats = mergeDb(local, path.join(tmp, "other.db"));
    expect(stats.sessionsUpdated).toBe(1);
    expect(getSession(local, "s-both")?.messageCount).toBe(2);

    // Re-merge the now-poorer snapshot: local richer copy must survive.
    const stats2 = mergeDb(local, path.join(tmp, "other.db"));
    expect(stats2.sessionsAdded).toBe(0);
    expect(stats2.sessionsUpdated).toBe(0);
    expect(getSession(local, "s-both")?.messageCount).toBe(2);
    local.close();
  });

  it("makes merged content searchable via FTS", () => {
    const local = dbAt("local.db");
    const other = dbAt("other.db");
    upsertSessionMessages(other, makeSession("s-fts", [{ uuid: "f1", text: "the laptop fixed the webpack chunk hash bug", ts: "2026-07-03T10:00:00.000Z" }]), { mode: "replace" });
    other.close();

    mergeDb(local, path.join(tmp, "other.db"));
    const hits = searchMessagesRaw(local, '"webpack"', {});
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe("s-fts");
    local.close();
  });

  it("is idempotent", () => {
    const local = dbAt("local.db");
    const other = dbAt("other.db");
    upsertSessionMessages(other, makeSession("s-i", [{ uuid: "i1", text: "idempotent", ts: "2026-07-04T10:00:00.000Z" }]), { mode: "replace" });
    other.close();

    mergeDb(local, path.join(tmp, "other.db"));
    const stats2 = mergeDb(local, path.join(tmp, "other.db"));
    expect(stats2.sessionsAdded).toBe(0);
    expect(stats2.sessionsUpdated).toBe(0);
    expect(getSession(local, "s-i")?.messageCount).toBe(1);
    local.close();
  });

  it("carries the archived flag with the winning copy", () => {
    const local = dbAt("local.db");
    const other = dbAt("other.db");
    upsertSessionMessages(
      other,
      makeSession("s-arch", [
        { uuid: "a1", text: "one", ts: "2026-07-05T10:00:00.000Z" },
        { uuid: "a2", text: "two", ts: "2026-07-05T10:01:00.000Z" },
      ]),
      { mode: "replace" }
    );
    markSessionArchived(other, "s-arch");
    other.close();

    mergeDb(local, path.join(tmp, "other.db"));
    expect(getSession(local, "s-arch")?.archived).toBe(true);
    local.close();
  });
});

describe("exportSnapshot / syncDir", () => {
  it("exports an openable snapshot and leaves no tmp file behind", () => {
    const local = dbAt("local.db");
    upsertSessionMessages(local, makeSession("s-x", [{ uuid: "x1", text: "snapshot me", ts: "2026-07-06T10:00:00.000Z" }]), { mode: "replace" });
    const out = path.join(tmp, "shared", "hostA.rewound.db");
    exportSnapshot(local, out);
    local.close();

    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.includes(".tmp"))).toEqual([]);
    const snap = new Database(out, { readonly: true });
    const n = (snap.prepare("SELECT count(*) c FROM sessions").get() as any).c;
    expect(n).toBe(1);
    snap.close();
  });

  it("round-trips sessions between two hosts through one shared dir", () => {
    const shared = path.join(tmp, "shared");
    const hostA = dbAt("a.db");
    const hostB = dbAt("b.db");
    upsertSessionMessages(hostA, makeSession("s-a", [{ uuid: "a1", text: "born on laptop", ts: "2026-07-07T10:00:00.000Z" }]), { mode: "replace" });
    upsertSessionMessages(hostB, makeSession("s-b", [{ uuid: "b1", text: "born on desktop", ts: "2026-07-08T10:00:00.000Z" }]), { mode: "replace" });

    const statsA1 = syncDir(hostA, shared, "laptop");
    expect(statsA1.exported).toBe(true);
    expect(statsA1.snapshotsMerged).toBe(0); // nothing else there yet

    const statsB1 = syncDir(hostB, shared, "desktop");
    expect(statsB1.snapshotsMerged).toBe(1);
    expect(getSession(hostB, "s-a")?.messageCount).toBe(1); // B now has A's session

    const statsA2 = syncDir(hostA, shared, "laptop");
    expect(statsA2.snapshotsMerged).toBe(1);
    expect(getSession(hostA, "s-b")?.messageCount).toBe(1); // A now has B's session

    // Stability: repeated syncs change nothing.
    const statsA3 = syncDir(hostA, shared, "laptop");
    expect(statsA3.sessionsAdded).toBe(0);
    hostA.close();
    hostB.close();
  });

  it("never merges the host's own snapshot back into itself", () => {
    const shared = path.join(tmp, "shared");
    const hostA = dbAt("a.db");
    upsertSessionMessages(hostA, makeSession("s-self", [{ uuid: "s1", text: "self", ts: "2026-07-09T10:00:00.000Z" }]), { mode: "replace" });
    syncDir(hostA, shared, "laptop");
    const stats = syncDir(hostA, shared, "laptop");
    expect(stats.snapshotsMerged).toBe(0);
    hostA.close();
  });
});
