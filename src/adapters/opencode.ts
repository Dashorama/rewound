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
//   part type='tool'         -> tool name + state.output/state.error, low weight
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

// A single scanned row from any of the three tables that carry time_updated,
// tagged by kind so downstream logic can tell "this row IS a message" from
// "this row is a session's own metadata bump" from "this is one of a
// message's parts" without a second query. row_id is that row's own primary
// key (namespaced by kind below into a tie-break key) — never the message id
// for a part row, so a part row and its parent message are distinguishable.
interface ScanRow {
  kind: "m" | "p" | "s";
  row_id: string;
  msg_id: string | null; // the owning message id for kind m/p; null for kind s
  session_id: string;
  ts: number;
}

// Storage/snapshot trees under a real OpenCode home can be large and there is
// no reason to walk them: the db always lives directly at <root>/opencode.db
// (checked first, below). This bound exists purely as a safety net against a
// pathologically deep or symlink-cyclic tree if a root is ever pointed
// somewhere unusual — depth alone bounds a cycle too, since every recursive
// call increments it regardless of whether the path repeats.
const MAX_DISCOVER_DEPTH = 8;

function walkForOpenCodeDb(entry: string, found: string[], depth = 0): void {
  if (depth > MAX_DISCOVER_DEPTH) return;
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
    walkForOpenCodeDb(path.join(entry, e.name), found, depth + 1);
  }
}

function tieKey(r: Pick<ScanRow, "kind" | "row_id">): string {
  return `${r.kind}:${r.row_id}`;
}

export class OpenCodeAdapter implements WatermarkSourceAdapter {
  id = "opencode";
  cursorKind = "watermark" as const;

  discover(roots: string[]): string[] {
    const found: string[] = [];
    for (const root of roots) {
      // Fast path: the well-known, documented layout — skips walking
      // storage/snapshot/log/tool-output entirely for the common case.
      const wellKnown = path.join(root, "opencode.db");
      let isWellKnownFile = false;
      try {
        isWellKnownFile = fs.statSync(wellKnown).isFile();
      } catch {
        // doesn't exist — fall through to the bounded walk below
      }
      if (isWellKnownFile) {
        found.push(wellKnown);
        continue;
      }
      // root may itself be the db file (unusual, but supported), or the db
      // could be nested somewhere under it — bounded recursive fallback.
      walkForOpenCodeDb(root, found);
    }
    return found;
  }

  parseSince(dbPath: string, cursor?: WatermarkCursorValue): { sessions: NormalizedSession[]; cursor: WatermarkCursorValue } {
    const persistedWatermark = cursor?.value ?? 0;
    // Read-only, with a busy timeout: OpenCode may be actively writing (WAL
    // mode) while we read. Never open read-write against another tool's DB.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      // A restored/rolled-back source (e.g. an older backup copied back over
      // opencode.db) can have a current max activity BEHIND our persisted
      // cursor. Scanning "time_updated >= persistedWatermark" against that
      // would then find nothing, forever — the byte-offset adapters have the
      // analogous case (file shrank -> full reparse); here, reset to a fresh
      // full scan instead.
      const overallMax = db
        .prepare(
          `SELECT MAX(x) as m FROM (
             SELECT time_updated as x FROM message
             UNION ALL SELECT time_updated FROM part
             UNION ALL SELECT time_updated FROM session
           )`
        )
        .get() as { m: number | null };
      const rolledBack = overallMax.m !== null && overallMax.m < persistedWatermark;
      const watermark = rolledBack ? 0 : persistedWatermark;
      const seenAtWatermark = rolledBack ? new Set<string>() : new Set(cursor?.tieBreakIds ?? []);

      // ONE combined, atomic read of every message/part/session row that
      // could matter, tagged by kind — the next cursor AND which
      // messages/sessions are touched are both derived purely from this same
      // in-memory rowset below, never by issuing a second query against
      // current DB state. An earlier version ran the touched-rows query and
      // the next-cursor query separately; on a live WAL db (OpenCode may be
      // writing while we read) a row committed between the two could be
      // folded into the new cursor/tieBreakIds without ever having been in
      // the touched set — silently skipped forever. A single statement
      // closes that: there is no point after this call returns where a
      // concurrent write could still affect what we derive from it.
      const rows = db
        .prepare(
          `SELECT 'm' as kind, id as row_id, id as msg_id, session_id, time_updated as ts FROM message WHERE time_updated >= ?
           UNION ALL
           SELECT 'p' as kind, id as row_id, message_id as msg_id, session_id, time_updated as ts FROM part WHERE time_updated >= ?
           UNION ALL
           SELECT 's' as kind, id as row_id, NULL as msg_id, id as session_id, time_updated as ts FROM session WHERE time_updated >= ?`
        )
        .all(watermark, watermark, watermark) as ScanRow[];

      if (rows.length === 0) {
        return { sessions: [], cursor: { value: watermark, tieBreakIds: [...seenAtWatermark] } };
      }

      let nextValue = watermark;
      for (const r of rows) if (r.ts > nextValue) nextValue = r.ts;
      const nextTieBreakIds = rows.filter((r) => r.ts === nextValue).map(tieKey);
      const nextCursor: WatermarkCursorValue = { value: nextValue, tieBreakIds: nextTieBreakIds };

      // A row is "new" if it's strictly newer than the watermark, or it ties
      // the watermark but its own row id was never accounted for before —
      // row-granular (not message-granular), so a new part landing at the
      // same tied ms as an already-seen sibling row on the SAME message still
      // counts as new (a message-level tie-break would wrongly suppress it).
      const isNewRow = (r: ScanRow) => r.ts > watermark || (r.ts === watermark && !seenAtWatermark.has(tieKey(r)));

      const touchedMessageIds = new Set<string>();
      const touchedSessionIds = new Set<string>(); // sessions whose OWN row (title/etc) was touched
      for (const r of rows) {
        if (!isNewRow(r)) continue;
        if (r.kind === "s") touchedSessionIds.add(r.session_id);
        else touchedMessageIds.add(r.msg_id!);
      }

      if (touchedMessageIds.size === 0 && touchedSessionIds.size === 0) {
        return { sessions: [], cursor: nextCursor };
      }

      const getMessage = db.prepare(
        "SELECT id, session_id, time_created, time_updated, data FROM message WHERE id = ?"
      );
      const getParts = db.prepare(
        "SELECT id, time_created, time_updated, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC"
      );
      const getSessionRow = db.prepare("SELECT id, directory, title, parent_id FROM session WHERE id = ?");

      const sessionRowCache = new Map<string, SessionRow | undefined>();
      const resolveSessionRow = (sessionId: string): SessionRow | undefined => {
        if (!sessionRowCache.has(sessionId)) {
          sessionRowCache.set(sessionId, getSessionRow.get(sessionId) as SessionRow | undefined);
        }
        return sessionRowCache.get(sessionId);
      };

      const bySessionMessages = new Map<string, NormalizedMessage[]>();
      const bySessionParseErrors = new Map<string, number>();
      const emittedSessionIds = new Set<string>();

      for (const message_id of touchedMessageIds) {
        const msgRow = getMessage.get(message_id) as MessageRow | undefined;
        if (!msgRow) continue; // deleted between discover and parse

        const sessionRow = resolveSessionRow(msgRow.session_id);
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

        if (!bySessionMessages.has(msgRow.session_id)) bySessionMessages.set(msgRow.session_id, []);
        bySessionMessages.get(msgRow.session_id)!.push(normMsg);
      }

      const sessions: NormalizedSession[] = [];
      for (const [sessionId, messages] of bySessionMessages) {
        messages.sort((a, b) => a.ts.localeCompare(b.ts));
        const meta = resolveSessionRow(sessionId)!;
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
        emittedSessionIds.add(sessionId);
      }

      // Sessions touched only via their own row (e.g. an AI-generated title
      // that lands after the last message) get an empty-messages entry so
      // the title/directory refresh still reaches upsertSessionMessages —
      // and any session whose only touched message this round was malformed
      // (parse error recorded, but never added to bySessionMessages) gets one
      // too, so that error isn't silently dropped from the output entirely.
      const needsEmptyEntry = new Set([...touchedSessionIds, ...bySessionParseErrors.keys()]);
      for (const sessionId of needsEmptyEntry) {
        if (emittedSessionIds.has(sessionId)) continue;
        const sessionRow = resolveSessionRow(sessionId);
        if (!sessionRow || sessionRow.parent_id) continue; // gone, or a sub-session (v1 scope)
        sessions.push({
          id: sessionId,
          source: "opencode",
          projectDir: sessionRow.directory,
          projectDirSource: "cwd",
          filePath: dbPath,
          title: sessionRow.title,
          messages: [],
          parseErrors: bySessionParseErrors.get(sessionId) ?? 0,
          bytesConsumed: 0,
        });
        emittedSessionIds.add(sessionId);
      }

      return { sessions, cursor: nextCursor };
    } finally {
      db.close();
    }
  }
}
