import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { NormalizedMessage, NormalizedSession, WatermarkCursorValue, WatermarkSourceAdapter } from "../types.js";

// OpenCode persists all sessions in one shared SQLite DB (drizzle schema),
// not one file per session — session/message/part, WAL mode, possibly being
// written by a live agent while we read. Mapping (verified against a real
// opencode.db — see docs-internal/specs/2026-07-21-opencode-adapter-design.md):
//   session.directory        -> projectDir (always present, so always "cwd"-sourced)
//   session.title            -> title
//   message.data.role        -> role
//   message.data.modelID     -> model (assistant only)
//   part type='text'         -> prose (high FTS weight)
//   part type='tool'         -> tool name + state.output, low weight
//   part type='reasoning'    -> low weight, NOT prose (model monologue, user never typed it)
// v1 deliberately skips: sessions with parent_id set (sub-sessions), and
// step-start/step-finish/patch/compaction parts (no searchable content).
// Per-message token usage (message.data.tokens/cost) is available in the raw
// data but unmapped in v1 — out of scope per the design spec.

interface SessionRow {
  id: string;
  directory: string;
  title: string;
  parent_id: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface PartRow {
  id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

function walkForOpenCodeDb(entry: string, found: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(entry);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (path.basename(entry) === "opencode.db") found.push(entry);
    return;
  }
  if (!stat.isDirectory()) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(entry, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    walkForOpenCodeDb(path.join(entry, e.name), found);
  }
}

export class OpenCodeAdapter implements WatermarkSourceAdapter {
  id = "opencode";
  cursorKind = "watermark" as const;

  discover(roots: string[]): string[] {
    const found: string[] = [];
    for (const root of roots) walkForOpenCodeDb(root, found);
    return found;
  }

  parseSince(dbPath: string, cursor?: WatermarkCursorValue): { sessions: NormalizedSession[]; cursor: WatermarkCursorValue } {
    const watermark = cursor?.value ?? 0;
    const seenAtWatermark = new Set(cursor?.tieBreakIds ?? []);
    // Read-only, with a busy timeout: OpenCode may be actively writing (WAL
    // mode) while we read. Never open read-write against another tool's DB.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      // A bare max(time_updated) is not a safe cursor on its own: two distinct
      // rows can share the exact same millisecond (confirmed on a real
      // opencode.db), so a row tied with the persisted boundary but written
      // after the run that set it would be silently skipped forever under a
      // strict "> " comparison — and a blanket ">=" instead reprocesses the
      // same already-seen row on every subsequent no-op run, forever. Splitting
      // the query into "strictly newer" (always new) and "tied with the
      // boundary but not in tieBreakIds" (new only if we haven't already
      // accounted for that exact row) gets both properties at once.
      const newerRows = db
        .prepare(
          `SELECT DISTINCT message_id FROM (
             SELECT id as message_id FROM message WHERE time_updated > ?
             UNION
             SELECT message_id FROM part WHERE time_updated > ?
           )`
        )
        .all(watermark, watermark) as Array<{ message_id: string }>;
      const tiedRows = db
        .prepare(
          `SELECT DISTINCT message_id FROM (
             SELECT id as message_id FROM message WHERE time_updated = ?
             UNION
             SELECT message_id FROM part WHERE time_updated = ?
           )`
        )
        .all(watermark, watermark) as Array<{ message_id: string }>;

      const touchedIds = new Set<string>(newerRows.map((r) => r.message_id));
      for (const r of tiedRows) if (!seenAtWatermark.has(r.message_id)) touchedIds.add(r.message_id);

      if (touchedIds.size === 0) {
        return { sessions: [], cursor: { value: watermark, tieBreakIds: [...seenAtWatermark] } };
      }

      // Next cursor: the max time_updated among every row >= the current
      // watermark (independent of which rows we actually choose to index
      // below, so a skipped row — bad JSON, a sub-session — can never
      // permanently block the watermark from advancing), plus every message
      // id tied at exactly that new max, to carry forward as the next run's
      // tieBreakIds.
      const maxRow = db
        .prepare(
          `SELECT MAX(x) as maxTs FROM (
             SELECT time_updated as x FROM message WHERE time_updated >= ?
             UNION ALL
             SELECT time_updated FROM part WHERE time_updated >= ?
           )`
        )
        .get(watermark, watermark) as { maxTs: number | null };
      const nextValue = maxRow.maxTs ?? watermark;
      const tiedAtNext = db
        .prepare(
          `SELECT DISTINCT message_id FROM (
             SELECT id as message_id FROM message WHERE time_updated = ?
             UNION
             SELECT message_id FROM part WHERE time_updated = ?
           )`
        )
        .all(nextValue, nextValue) as Array<{ message_id: string }>;
      const nextCursor: WatermarkCursorValue = { value: nextValue, tieBreakIds: tiedAtNext.map((r) => r.message_id) };

      const getMessage = db.prepare(
        "SELECT id, session_id, time_created, time_updated, data FROM message WHERE id = ?"
      );
      const getParts = db.prepare(
        "SELECT id, time_created, time_updated, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC"
      );
      const getSessionRow = db.prepare("SELECT id, directory, title, parent_id FROM session WHERE id = ?");

      const bySessionMeta = new Map<string, SessionRow>();
      const bySessionMessages = new Map<string, NormalizedMessage[]>();
      const bySessionParseErrors = new Map<string, number>();

      for (const message_id of touchedIds) {
        const msgRow = getMessage.get(message_id) as MessageRow | undefined;
        if (!msgRow) continue; // deleted between discover and parse

        const sessionRow = getSessionRow.get(msgRow.session_id) as SessionRow | undefined;
        if (!sessionRow || sessionRow.parent_id) continue; // gone, or a sub-session (v1 scope)

        const bumpParseErrors = () =>
          bySessionParseErrors.set(msgRow.session_id, (bySessionParseErrors.get(msgRow.session_id) ?? 0) + 1);

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(msgRow.data);
        } catch {
          bumpParseErrors();
          continue;
        }
        const role = data.role === "assistant" ? "assistant" : data.role === "user" ? "user" : undefined;
        if (!role) continue;

        const proseParts: string[] = [];
        const toolParts: string[] = [];
        const tools: string[] = [];
        for (const part of getParts.all(message_id) as PartRow[]) {
          let pd: Record<string, unknown>;
          try {
            pd = JSON.parse(part.data);
          } catch {
            bumpParseErrors();
            continue;
          }
          if (pd.type === "text") {
            if (typeof pd.text === "string" && pd.text) proseParts.push(pd.text);
          } else if (pd.type === "tool") {
            if (typeof pd.tool === "string") tools.push(pd.tool);
            const state = pd.state as Record<string, unknown> | undefined;
            const output = state?.output;
            const error = state?.error;
            // A failed tool call reports its error in state.error, not state.output
            // (confirmed mutually exclusive on the real corpus) — without this, a
            // failed command's actual error text never enters the index at all.
            if (typeof output === "string" && output) toolParts.push(output);
            else if (typeof error === "string" && error) toolParts.push(error);
          } else if (pd.type === "reasoning") {
            if (typeof pd.text === "string" && pd.text) toolParts.push(pd.text);
          }
          // step-start / step-finish / patch / compaction: no searchable content, v1 skip.
        }

        const normMsg: NormalizedMessage = {
          uuid: msgRow.id,
          role,
          ts: new Date(msgRow.time_created).toISOString(),
          text: proseParts.join("\n\n"),
          toolText: toolParts.length > 0 ? toolParts.join("\n\n") : undefined,
          tools,
          model: role === "assistant" && typeof data.modelID === "string" ? data.modelID : undefined,
          isSidechain: false,
        };

        if (!bySessionMeta.has(msgRow.session_id)) bySessionMeta.set(msgRow.session_id, sessionRow);
        if (!bySessionMessages.has(msgRow.session_id)) bySessionMessages.set(msgRow.session_id, []);
        bySessionMessages.get(msgRow.session_id)!.push(normMsg);
      }

      const sessions: NormalizedSession[] = [];
      for (const [sessionId, messages] of bySessionMessages) {
        messages.sort((a, b) => a.ts.localeCompare(b.ts));
        const meta = bySessionMeta.get(sessionId)!;
        sessions.push({
          id: sessionId,
          source: "opencode",
          projectDir: meta.directory,
          projectDirSource: "cwd",
          filePath: dbPath,
          title: meta.title,
          startedAt: messages[0]?.ts,
          endedAt: messages[messages.length - 1]?.ts,
          messages,
          parseErrors: bySessionParseErrors.get(sessionId) ?? 0,
          bytesConsumed: 0, // unused: watermark-cursor sources resume via parseSince's returned cursor, not a byte offset
        });
      }

      return { sessions, cursor: nextCursor };
    } finally {
      db.close();
    }
  }
}
