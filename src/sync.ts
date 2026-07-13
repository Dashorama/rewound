import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";

export interface MergeStats {
  sessionsAdded: number;
  sessionsUpdated: number;
}

export interface SyncStats extends MergeStats {
  exported: boolean;
  snapshotsMerged: number;
}

// Merge another rewound database into `local`: union by session id, and on
// collision the richer copy wins (more messages; tie broken by newer ended_at).
// The source file is never written to — it is copied aside first, because sync
// snapshots belong to other hosts and mutating them (e.g. a schema migration)
// would fight their next export through the user's file-sync service.
export function mergeDb(local: Database.Database, otherPath: string): MergeStats {
  const tmpCopy = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "rewound-merge-")),
    "snapshot.db"
  );
  fs.copyFileSync(otherPath, tmpCopy);
  // Round-trip through openDb so pre-v2 snapshots are migrated before ATTACH.
  openDb(tmpCopy).close();

  const stats: MergeStats = { sessionsAdded: 0, sessionsUpdated: 0 };
  local.prepare("ATTACH DATABASE ? AS other").run(tmpCopy);
  try {
    const merge = local.transaction(() => {
      const otherSessions = local
        .prepare("SELECT id, message_count, ended_at FROM other.sessions")
        .all() as Array<{ id: string; message_count: number; ended_at: string | null }>;
      const getLocal = local.prepare("SELECT message_count, ended_at FROM sessions WHERE id = ?");
      const copySession = local.prepare(
        "INSERT INTO sessions SELECT * FROM other.sessions WHERE id = ?"
      );
      const copyMessages = local.prepare(
        `INSERT INTO messages (session_id, uuid, role, ts, text, tools, model, is_sidechain, tool_text)
         SELECT session_id, uuid, role, ts, text, tools, model, is_sidechain, tool_text
         FROM other.messages WHERE session_id = ?`
      );
      const deleteSession = local.prepare("DELETE FROM sessions WHERE id = ?");
      const deleteMessages = local.prepare("DELETE FROM messages WHERE session_id = ?");

      for (const o of otherSessions) {
        const l = getLocal.get(o.id) as { message_count: number; ended_at: string | null } | undefined;
        if (!l) {
          copySession.run(o.id);
          copyMessages.run(o.id);
          stats.sessionsAdded++;
          continue;
        }
        const richer =
          o.message_count > l.message_count ||
          (o.message_count === l.message_count && (o.ended_at ?? "") > (l.ended_at ?? ""));
        if (richer) {
          deleteMessages.run(o.id); // FTS delete-triggers fire per row
          deleteSession.run(o.id);
          copySession.run(o.id);
          copyMessages.run(o.id);
          stats.sessionsUpdated++;
        }
      }
    });
    merge();
  } finally {
    local.prepare("DETACH DATABASE other").run();
    fs.rmSync(path.dirname(tmpCopy), { recursive: true, force: true });
  }
  return stats;
}

// Write a compact single-file snapshot of the database, atomically (tmp +
// rename), so eventually-consistent file syncers never observe a half-written
// or WAL-split database.
export function exportSnapshot(db: Database.Database, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  db.prepare("VACUUM INTO ?").run(tmp);
  fs.renameSync(tmp, outPath);
}

export function sanitizeHostName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
}

// One-command multi-host continuity over any user-synced folder (Drive,
// Dropbox, Syncthing, a git repo, an rclone mount of S3/Supabase storage...):
// merge every other host's snapshot, then export ours — so each snapshot also
// propagates what its host has learned from the others. Each host only ever
// writes its own <host>.rewound.db: no write conflicts on the sync medium.
export function syncDir(db: Database.Database, dir: string, hostName?: string): SyncStats {
  const host = sanitizeHostName(hostName ?? os.hostname());
  const ownSnapshot = `${host}.rewound.db`;
  fs.mkdirSync(dir, { recursive: true });

  const stats: SyncStats = { exported: false, snapshotsMerged: 0, sessionsAdded: 0, sessionsUpdated: 0 };
  const snapshots = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".rewound.db") && f !== ownSnapshot);
  for (const snap of snapshots) {
    const m = mergeDb(db, path.join(dir, snap));
    stats.snapshotsMerged++;
    stats.sessionsAdded += m.sessionsAdded;
    stats.sessionsUpdated += m.sessionsUpdated;
  }

  exportSnapshot(db, path.join(dir, ownSnapshot));
  stats.exported = true;
  return stats;
}
