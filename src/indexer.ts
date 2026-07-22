import fs from "node:fs";
import type Database from "better-sqlite3";
import type { SourceAdapter, WatermarkSourceAdapter } from "./types.js";
import {
  getFileRecord,
  upsertFileRecord,
  upsertSessionMessages,
  markSessionArchived,
  listTrackedFiles,
  getSession,
  getSourceCursor,
  upsertSourceCursor,
} from "./db.js";

export interface IndexStats {
  filesScanned: number;
  filesNew: number;
  filesUpdated: number;
  messagesIndexed: number;
  parseErrors: number;
  elapsedMs: number;
}

interface FileIndexResult {
  status: "new" | "updated" | "unchanged";
  messagesIndexed: number;
  parseErrors: number;
}

// byteOffset/size must come from what adapter.parse() actually consumed
// (session.bytesConsumed), never from an independent fs.stat. adapter.parse()
// does its own fs.readFileSync internally; a stat taken by the caller — before
// OR after that call — can disagree with what was actually read if the source
// file grows concurrently (a real risk: these files are actively appended to
// by live agent sessions). Using a stat instead of the parser's own count is
// wrong in both directions: a pre-parse stat can under-count what parse() then
// reads (duplicate messages next run), and a post-parse stat can over-count it
// if the file grew after the read but before the stat (silently skipped bytes
// — permanent data loss, the worse failure mode). bytesConsumed is derived
// solely from the buffer parse() actually read, so there is no such race.
//
// mtimeMs is persisted (it's part of the locked schema) but change detection
// below is deliberately size-only: these files are append-only JSONL, so size
// is a strictly stronger signal than mtime for "did new records show up." We
// reuse the pre-parse stat's mtime as a best-effort value; it's never used
// for decisions.
function recordFile(db: Database.Database, filePath: string, sessionId: string, bytesConsumed: number, mtimeMs: number): void {
  upsertFileRecord(db, {
    path: filePath,
    sessionId,
    size: bytesConsumed,
    mtimeMs,
    byteOffset: bytesConsumed,
  });
}

function indexOneFile(db: Database.Database, adapter: SourceAdapter, filePath: string): FileIndexResult {
  const stat = fs.statSync(filePath);
  const existing = getFileRecord(db, filePath);

  if (!existing) {
    const session = adapter.parse(filePath, 0);
    upsertSessionMessages(db, session, { mode: "replace" });
    recordFile(db, filePath, session.id, session.bytesConsumed, stat.mtimeMs);
    return { status: "new", messagesIndexed: session.messages.length, parseErrors: session.parseErrors };
  }

  const offsetValid = existing.byteOffset <= stat.size;

  if (stat.size < existing.size || !offsetValid) {
    // upsertSessionMessages in "replace" mode deletes existing messages and
    // re-inserts inside a single transaction; no separate delete needed here.
    const session = adapter.parse(filePath, 0);
    upsertSessionMessages(db, session, { mode: "replace" });
    recordFile(db, filePath, session.id, session.bytesConsumed, stat.mtimeMs);
    return { status: "updated", messagesIndexed: session.messages.length, parseErrors: session.parseErrors };
  }

  if (stat.size > existing.size) {
    const session = adapter.parse(filePath, existing.byteOffset);
    upsertSessionMessages(db, session, { mode: "append" });
    recordFile(db, filePath, existing.sessionId, session.bytesConsumed, stat.mtimeMs);
    return { status: "updated", messagesIndexed: session.messages.length, parseErrors: session.parseErrors };
  }

  // Unchanged on disk. A session archived because its file briefly vanished
  // un-archives here once the (byte-for-byte identical) file reappears.
  const sessionRow = getSession(db, existing.sessionId);
  if (sessionRow?.archived) {
    upsertSessionMessages(
      db,
      {
        id: sessionRow.id,
        source: "claude-code",
        projectDir: sessionRow.projectDir,
        filePath,
        parseErrors: 0,
        messages: [],
        bytesConsumed: 0,
      },
      { mode: "append" }
    );
  }

  return { status: "unchanged", messagesIndexed: 0, parseErrors: 0 };
}

export function indexAll(db: Database.Database, adapter: SourceAdapter, roots: string[]): IndexStats {
  const start = Date.now();
  const discovered = adapter.discover(roots);
  const discoveredSet = new Set(discovered);

  let filesNew = 0;
  let filesUpdated = 0;
  let messagesIndexed = 0;
  let parseErrors = 0;

  for (const filePath of discovered) {
    const result = indexOneFile(db, adapter, filePath);
    if (result.status === "new") filesNew++;
    else if (result.status === "updated") filesUpdated++;
    messagesIndexed += result.messagesIndexed;
    parseErrors += result.parseErrors;
  }

  const tracked = listTrackedFiles(db);
  for (const row of tracked) {
    if (!discoveredSet.has(row.path) && !fs.existsSync(row.path)) {
      markSessionArchived(db, row.sessionId);
    }
  }

  return {
    filesScanned: discovered.length,
    filesNew,
    filesUpdated,
    messagesIndexed,
    parseErrors,
    elapsedMs: Date.now() - start,
  };
}

// Counterpart to indexAll() for watermark-cursor sources (see
// WatermarkSourceAdapter in types.ts): one source can hold many sessions and
// rows update in place, so tracking is per-source-path (the `sources` table)
// rather than per-file-per-session (the `files` table), and messages are
// upserted by uuid rather than appended. IndexStats' filesScanned/filesNew/
// filesUpdated fields are reused here for "sources" — same shape, no reason
// for a parallel stats type.
export function indexAllWatermark(
  db: Database.Database,
  adapter: WatermarkSourceAdapter,
  roots: string[]
): IndexStats {
  const start = Date.now();
  const discovered = adapter.discover(roots);

  let sourcesNew = 0;
  let sourcesUpdated = 0;
  let messagesIndexed = 0;
  let parseErrors = 0;

  for (const sourcePath of discovered) {
    const existing = getSourceCursor(db, sourcePath);
    const { sessions, cursor } = adapter.parseSince(sourcePath, existing?.value);

    for (const session of sessions) {
      upsertSessionMessages(db, session, { mode: "upsert" });
      messagesIndexed += session.messages.length;
      parseErrors += session.parseErrors;
    }

    // Persisted even when nothing was indexed this run: the cursor tracks
    // everything parseSince scanned, not just what got upserted, so a
    // no-op run doesn't leave the source stuck re-scanning the same rows.
    upsertSourceCursor(db, sourcePath, adapter.id, { kind: "watermark", value: cursor });
    if (!existing) sourcesNew++;
    else if (sessions.length > 0) sourcesUpdated++;
  }

  return {
    filesScanned: discovered.length,
    filesNew: sourcesNew,
    filesUpdated: sourcesUpdated,
    messagesIndexed,
    parseErrors,
    elapsedMs: Date.now() - start,
  };
}
