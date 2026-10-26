import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { NormalizedMessage, NormalizedSession, WatermarkCursorValue, WatermarkSourceAdapter } from "../types.js";

// Cursor persists conversations in a global SQLite db (all projects mixed
// together) plus one per-workspace SQLite db per project. Mapping verified
// against a real, in-use Cursor install — see
// docs-internal/specs/2026-08-26-cursor-adapter-design.md for the full
// investigation (74,691 real bubble rows, static analysis of the packaged
// app bundle to find the actual tool-call field name, etc.):
//
//   User/globalStorage/state.vscdb
//     cursorDiskKV['composerData:<id>']         -> session (name, bubble list)
//     cursorDiskKV['bubbleId:<composerId>:<id>'] -> message (type/text/tools)
//     composerHeaders(composerId, recency, lastUpdatedAt, value) -> newer,
//       faster session index; value JSON has workspaceIdentifier.uri.fsPath
//       (the project path), but only covers composers touched since this
//       table was introduced (~48% of composers on the reference install) —
//       never backfilled for older ones. Watermark on `recency`, not
//       `lastUpdatedAt`: the latter is NULL on ~19% of rows on the reference
//       install (confirmed — chat-mode/single-exchange composers, it looks
//       like), which silently drops them from a `WHERE lastUpdatedAt >= ?`
//       scan forever (NULL >= x is NULL, never true in SQL). `recency` is
//       never NULL and equals `lastUpdatedAt` in every row where both are
//       present — it's the column composerHeaders' own covering index
//       (idx_composerHeaders_1) is built on, so it's the intended field.
//   User/workspaceStorage/<hash>/
//     workspace.json                 -> {"folder": "file:///abs/path"}
//     state.vscdb ItemTable['composer.composerData'].allComposers[].composerId
//       -> which composers belong to this project (the fallback path for
//          composers composerHeaders doesn't cover)
//
// Tool calls: message.toolFormerData (NOT the public-docs-cited
// `toolResults`, which is empty on every real bubble sampled). Its `name`
// field is a human-readable tool name (used as-is for NormalizedMessage.tools,
// same as every other adapter — no cross-tool name normalization, even
// though Cursor itself has at least two different MCP tool-name spellings
// across versions). `result`'s shape varies by tool; edit-type tools
// (edit_file_v2 and friends) don't inline their diff there at all, just a
// content-hash reference into a separate composer.content.<hash> blob
// cache. That join is still deliberately NOT resolved (same "defer the
// expensive low-value lookup" call the OpenCode adapter made for
// sub-sessions) — but confirmed unnecessary for edit_file_v2 specifically:
// its real diff (`streamingContent`) is already inline in `params`, which
// `rawArgs` (the field every other tool's diff/content lives in) doesn't
// even carry for this tool. search_replace/write/MultiEdit/apply_patch all
// keep their content in `rawArgs` as before; `params` is included as a
// third source alongside it for exactly this edit_file_v2 case.

interface ComposerHeaderRow {
  composerId: string;
  recency: number;
  createdAt: number | null;
  value: string;
}

interface ConversationHeader {
  bubbleId: string;
  type: number; // 1 = user, 2 = assistant
}

interface ComposerDataValue {
  name?: string;
  createdAt?: number;
  fullConversationHeadersOnly?: ConversationHeader[];
  // Pre-`_v` composers store the whole conversation inline here — full
  // bubble objects, not the ID references fullConversationHeadersOnly uses.
  // 147 composers / 2,840 messages on the reference install, and 2,818 of
  // those bubbles have NO bubbleId: KV row at all, so they can only be read
  // from here. Without this the entire conversation indexes as empty.
  conversation?: Array<BubbleValue & { bubbleId?: string }>;
}

interface BubbleValue {
  type?: number;
  text?: string;
  createdAt?: number;
  // Model reasoning, when present — a *different* field than the public-docs-
  // cited `allThinkingBlocks` (which was empty on every bubble in the
  // original reference sample; this nested `thinking.text` shape is what
  // real reasoning-model bubbles on this install actually use).
  thinking?: { text?: string };
  // A pure UI notification bubble (e.g. "Switched to Composer 2 after
  // reaching API limit") — not something the user or model said, but
  // informative enough to keep rather than silently drop.
  serviceStatusUpdate?: { message?: string };
  // A turn that failed outright (model provider unreachable, etc). `message`
  // is a short label, `error` a JSON string carrying the human-readable
  // title/detail. stackTrace (Cursor's own internal JS stack) and
  // extraButtons (UI button labels) are deliberately not indexed — noise.
  errorDetails?: { message?: string; error?: string };
  toolFormerData?: {
    name?: string;
    // Outcome of the call. Two places carry it and they disagree: a call can
    // be top-level "completed" while additionalData says "error" (the
    // request finished; the tool itself failed), so additionalData wins.
    status?: string;
    additionalData?: { status?: string };
    rawArgs?: string;
    // edit_file_v2's real diff (streamingContent) lives only here — it has
    // no rawArgs at all, unlike every other edit-type tool.
    params?: string;
    result?: string;
  };
  // Assistant-authored/referenced code shown inline, outside any tool call —
  // confirmed real and substantial on the reference install (2,169 bubbles,
  // some a full file's worth), not redundant with `text`. codeBlockIdx/_v
  // are UI bookkeeping, not indexed.
  codeBlocks?: Array<{ uri?: { _fsPath?: string; path?: string }; content?: string }>;
}

// edit-type tool results offload their actual before/after content to a
// composer.content.<hash> blob and leave only this reference behind — a
// value matching this pattern carries no searchable text of its own.
const CONTENT_HASH_REF_RE = /^composer\.content\.[0-9a-f]+$/;

// Bubble fields this adapter reads — for content or for structure.
// KEEP IN SYNC when adding extraction: the drift detector (src/doctor.ts)
// treats any field listed in neither this set nor the ignore set below as
// unrecognised, and reports it if it turns out to carry real text. That's
// the whole point — every gap found on this branch (codeBlocks, thinking,
// serviceStatusUpdate, errorDetails, tool status) was a field nobody knew
// to look at, found only by hand-auditing. This makes the next one show up
// on its own.
export const CURSOR_READ_BUBBLE_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "bubbleId",
  "createdAt",
  "text",
  "thinking",
  "serviceStatusUpdate",
  "errorDetails",
  "toolFormerData",
  "codeBlocks",
]);

// Fields deliberately NOT indexed, each because it carries no searchable
// prose: identifiers, enums, counters, timings, booleans, and UI/transport
// bookkeeping. Deliberately kept tight — a field belongs here only once
// someone has actually looked at it and decided, never merely to quiet the
// detector. Anything genuinely uninspected should stay unknown and get
// reported.
export const CURSOR_IGNORED_BUBBLE_FIELDS: ReadonlySet<string> = new Set([
  // identifiers
  "_v", "serverBubbleId", "usageUuid", "requestId", "checkpointId", "afterCheckpointId",
  "generationUUID", "subagentSpawnTaskToolCallId",
  // enums / modes / flags
  "unifiedMode", "unifiedModeSetExplicitly", "capabilityType", "capabilityTypes",
  "thinkingStyle", "intermediateSectionType", "conversationState",
  "isAgentic", "isNudge", "isPlanExecution", "isSimulatedMsg", "isReviewEditsFollowup",
  "isRefunded", "isReadingLongFile", "skipRendering", "useWeb",
  "editToolSupportsSearchAndReplace", "existedPreviousTerminalCommand",
  "existedSubsequentTerminalCommand",
  // counters / timings
  "tokenCount", "tokenCountUpUntilHere", "tokenDetailsUpUntilHere",
  "thinkingDurationMs", "turnDurationMs", "timingInfo",
  // per-turn lifecycle bookkeeping (arrays of capability ids, mostly empty)
  "capabilityStatuses", "capabilitiesRan",
  // a Lexical-editor JSON mirror of `text` — redundant with what we index
  "richText",
]);

// Tool call params/results have no fixed schema across ~70 distinct tool
// names (confirmed on the reference corpus) and drift between Cursor
// versions (edit_file -> edit_file_v2, read_file -> read_file_v2, ...), so
// rather than a per-tool-name parser this walks whatever JSON shape shows
// up and collects prose, skipping the one identified noise pattern above.
// Bounded in both depth and total size so one huge read_file/grep dump
// doesn't dominate a message's indexed text.
const TOOL_TEXT_DEPTH_LIMIT = 8;
const TOOL_TEXT_CHAR_BUDGET = 6000;

// Bounds how many composers a single parseSince() call will touch. A full
// historical backfill (reprocessing all ~850 composers on the reference
// install after a watermark reset) reliably crashed with a native
// GC-timing bug in better-sqlite3 under Node 24 — reproduced 4/4 times,
// including with a 4x larger V8 heap, so it isn't simple memory pressure;
// most likely cumulative Statement/GC churn within one process's lifetime.
// Capping work per call means a large backlog drains safely across several
// `rw index` invocations (each a fresh process, fresh V8 heap) instead of
// needing to complete in one process's lifetime. Normal incremental runs
// (a handful of changed sessions) are far below this and are unaffected —
// this only changes behavior for a large first-time or reset backfill.
const MAX_COMPOSERS_PER_CALL = 50;

function collectStrings(value: unknown, depth: number, budget: { remaining: number }, out: string[]): void {
  if (budget.remaining <= 0 || depth > TOOL_TEXT_DEPTH_LIMIT) return;
  if (typeof value === "string") {
    if (value && !CONTENT_HASH_REF_RE.test(value)) {
      const take = value.slice(0, budget.remaining);
      out.push(take);
      budget.remaining -= take.length;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (budget.remaining <= 0) break;
      collectStrings(v, depth + 1, budget, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (budget.remaining <= 0) break;
      collectStrings(v, depth + 1, budget, out);
    }
  }
}

function extractToolText(...jsons: (string | undefined)[]): string | undefined {
  const parts: string[] = [];
  const budget = { remaining: TOOL_TEXT_CHAR_BUDGET };
  for (const raw of jsons) {
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw; // not JSON — index the raw string itself
    }
    collectStrings(parsed, 0, budget, parts);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// A tool call's outcome, but only when it's worth recording. "completed"/
// "success"/"submitted" is the overwhelming norm and says nothing; a
// failure or cancellation is real information that exists NOWHERE else in
// the record — on the reference install 887 *named* tool calls failed and
// currently read as indistinguishable from successful ones, plus 1,308
// that failed before Cursor even recorded which tool it was (no name, no
// args, no result — status is literally all that survives, so without this
// the whole bubble looks empty and gets skipped).
//
// additionalData.status wins over the top-level one: a call is routinely
// top-level "completed" (the request finished) while additionalData says
// "error" (the tool itself failed).
const NORMAL_TOOL_STATUSES = new Set(["completed", "success", "submitted"]);

export function abnormalToolStatus(toolFormerData: BubbleValue["toolFormerData"]): string | undefined {
  const status = toolFormerData?.additionalData?.status ?? toolFormerData?.status;
  if (!status || NORMAL_TOOL_STATUSES.has(status)) return undefined;
  return status;
}

// Same char budget as extractToolText — a codeBlocks entry can be a whole
// file, so this stays bounded for the same reason (one huge block
// shouldn't dominate a message's indexed text).
function extractCodeBlocksText(codeBlocks: BubbleValue["codeBlocks"]): string | undefined {
  if (!codeBlocks || codeBlocks.length === 0) return undefined;
  const parts: string[] = [];
  let remaining = TOOL_TEXT_CHAR_BUDGET;
  for (const cb of codeBlocks) {
    if (remaining <= 0) break;
    if (!cb?.content) continue;
    const filePath = cb.uri?._fsPath ?? cb.uri?.path;
    const block = filePath ? `${filePath}\n\n${cb.content}` : cb.content;
    const take = block.slice(0, remaining);
    parts.push(take);
    remaining -= take.length;
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// 32% of bubbles on the reference install have no createdAt of their own
// (confirmed by sampling — not rare). Falling back to 0 (1970-01-01) would
// be actively misleading, and falling back to the *composer's* createdAt
// sorts the bubble before the conversation's opening message once mixed
// with real timestamps. Since fullConversationHeadersOnly is already true
// conversation order, the caller carries the previous bubble's timestamp
// forward and passes it here as fallbackTs (previous bubble's ts, else the
// composer's createdAt, else the header row's own timestamp) — Array.sort
// is stable, so equal timestamps keep push order and nothing scrambles.
function parseBubbleValue(
  d: BubbleValue,
  bubbleId: string,
  fallbackTs: number | undefined
): NormalizedMessage | undefined {
  const role = d.type === 1 ? "user" : d.type === 2 ? "assistant" : undefined;
  if (!role) return undefined;

  const toolFormerData = d.toolFormerData;
  const tools = toolFormerData?.name ? [toolFormerData.name] : [];
  // Reasoning and service-status notes are low-weight/non-prose, same as the
  // OpenCode adapter's "model monologue, user never typed it" precedent —
  // folded into toolText rather than the high-weight `text` field, alongside
  // any tool call's own args/result text.
  const extras: string[] = [];
  if (d.thinking?.text) extras.push(d.thinking.text);
  if (d.serviceStatusUpdate?.message) extras.push(d.serviceStatusUpdate.message);
  const failureStatus = abnormalToolStatus(toolFormerData);
  if (failureStatus) extras.push(`tool call status: ${failureStatus}`);
  if (d.errorDetails?.message) extras.push(d.errorDetails.message);
  const errorText = extractToolText(d.errorDetails?.error);
  if (errorText) extras.push(errorText);
  const toolCallText = extractToolText(toolFormerData?.rawArgs, toolFormerData?.params, toolFormerData?.result);
  if (toolCallText) extras.push(toolCallText);
  const codeBlocksText = extractCodeBlocksText(d.codeBlocks);
  if (codeBlocksText) extras.push(codeBlocksText);
  const toolText = extras.length > 0 ? extras.join("\n\n") : undefined;

  return {
    uuid: bubbleId,
    role,
    ts: new Date(d.createdAt ?? fallbackTs ?? 0).toISOString(),
    text: d.text ?? "",
    toolText,
    tools,
    isSidechain: false,
  };
}

export function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  let p: string;
  try {
    p = decodeURIComponent(uri.slice("file://".length));
  } catch {
    p = uri.slice("file://".length);
  }
  // Windows file URIs are file:///C:/Users/... (or %3A-encoded) — the path
  // component keeps a leading slash that is not part of the real path, and
  // leaving it produces "/C:/Users/..." projectDirs that split one project
  // in two against the drive-lettered paths composerHeaders carries.
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

// composerHeaders.value is JSON with workspaceIdentifier.uri.fsPath — the
// fast, authoritative project-dir signal, when a header row exists at all.
function projectDirFromHeaderValue(headerValueJson: string): string | undefined {
  try {
    const v = JSON.parse(headerValueJson) as { workspaceIdentifier?: { uri?: { fsPath?: unknown } } };
    const fsPath = v.workspaceIdentifier?.uri?.fsPath;
    return typeof fsPath === "string" && fsPath ? fsPath : undefined;
  } catch {
    return undefined;
  }
}

// Fallback for composers composerHeaders doesn't cover: join every
// workspaceStorage/<hash>/workspace.json (folder path) against that same
// workspace's own state.vscdb, which lists which composerIds belong to it.
// Expensive (opens every per-workspace db) — only called when there's at
// least one composer that actually needs it (see parseSince below), so it's
// a one-time cost on first index and rarely touched again afterward.
function buildLegacyProjectDirMap(workspaceStorageDir: string): Map<string, string> {
  const map = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceStorageDir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wsDir = path.join(workspaceStorageDir, entry.name);
    let folder: string | undefined;
    try {
      const wsJson = JSON.parse(fs.readFileSync(path.join(wsDir, "workspace.json"), "utf8")) as { folder?: unknown };
      folder = typeof wsJson.folder === "string" ? fileUriToPath(wsJson.folder) : undefined;
    } catch {
      continue; // no workspace.json (e.g. an empty/orphaned storage dir) — skip
    }
    if (!folder) continue;

    let wsDb: Database.Database;
    try {
      wsDb = new Database(path.join(wsDir, "state.vscdb"), { readonly: true, fileMustExist: true, timeout: 2000 });
    } catch {
      continue;
    }
    try {
      const row = wsDb.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as
        | { value: string }
        | undefined;
      if (!row) continue;
      const parsed = JSON.parse(row.value) as { allComposers?: unknown };
      const composers = Array.isArray(parsed.allComposers) ? parsed.allComposers : [];
      for (const c of composers) {
        const composerId = (c as { composerId?: unknown } | null)?.composerId;
        if (typeof composerId === "string" && !map.has(composerId)) {
          map.set(composerId, folder);
        }
      }
    } catch {
      // malformed/locked per-workspace db — that one workspace's composers
      // stay unresolved this run, doesn't abort the others.
    } finally {
      wsDb.close();
    }
  }
  return map;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

export class CursorAdapter implements WatermarkSourceAdapter {
  id = "cursor";
  cursorKind = "watermark" as const;

  discover(roots: string[]): string[] {
    const found: string[] = [];
    for (const root of roots) {
      // Cursor's layout is fixed (unlike OpenCode's, which can nest an
      // opencode.db arbitrarily) — root is either the "Cursor" app-support
      // dir or, as DEFAULT_CURSOR_ROOTS points at, the "User" dir directly.
      const candidates = [
        path.join(root, "User", "globalStorage", "state.vscdb"),
        path.join(root, "globalStorage", "state.vscdb"),
      ];
      for (const candidate of candidates) {
        try {
          if (fs.statSync(candidate).isFile()) {
            found.push(candidate);
            break;
          }
        } catch {
          // try the next candidate
        }
      }
    }
    return found;
  }

  parseSince(
    dbPath: string,
    cursor?: WatermarkCursorValue
  ): { sessions: NormalizedSession[]; cursor: WatermarkCursorValue; backlogRemaining?: number; skipped?: string[] } {
    const persistedWatermark = cursor?.value ?? 0;
    // Two independent id namespaces packed into one tieBreakIds array: "hdr:"
    // entries are composerHeaders rows tied at the current watermark
    // boundary (same tie-break need as OpenCode's — two composers CAN share
    // a recency millisecond); "legacy:" entries are every headerless
    // composer ever indexed, tracked by pure id membership since
    // cursorDiskKV has no per-row timestamp column to watermark against at
    // all. A legacy composer is treated as static once indexed — the one
    // documented gap is a previously-empty draft that gets a real message
    // without ever gaining a composerHeaders row, which would go unnoticed
    // until a full reindex. Reference data suggests header rows appear on
    // real activity, so this should be rare in practice.
    const prevHdrTies = new Set<string>();
    const prevLegacySeen = new Set<string>();
    // "retry:"/"lretry:" entries are composers a previous run could NOT index
    // (unresolvable project dir — workspace not reopened yet). They sit
    // outside the watermark: it advances past them so the rest of the scan
    // makes progress, and they're re-attempted every call (one KV get each)
    // until they resolve or their composer row disappears.
    const prevRetry = new Set<string>();
    const prevLegacyRetry = new Set<string>();
    for (const id of cursor?.tieBreakIds ?? []) {
      if (id.startsWith("hdr:")) prevHdrTies.add(id.slice(4));
      else if (id.startsWith("legacy:")) prevLegacySeen.add(id.slice(7));
      else if (id.startsWith("lretry:")) prevLegacyRetry.add(id.slice(7));
      else if (id.startsWith("retry:")) prevRetry.add(id.slice(6));
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      const hasHeaders = tableExists(db, "composerHeaders");

      const overallMax = hasHeaders
        ? ((db.prepare("SELECT MAX(recency) as m FROM composerHeaders").get() as { m: number | null }).m ?? 0)
        : 0;
      const rolledBack = overallMax < persistedWatermark;
      const watermark = rolledBack ? 0 : persistedWatermark;
      const hdrTies = rolledBack ? new Set<string>() : prevHdrTies;

      // Keyset pagination on (recency, composerId): the tie set alone can't
      // page through a plateau of equal-recency rows wider than the per-call
      // cap — a plain `recency >= ?` scan would re-fetch the same first batch
      // of ties forever and never reach the rest of the plateau or anything
      // newer. Resuming from (watermark, max already-seen tie id) makes every
      // fetched row new by construction. composerIds are ASCII UUIDs, so JS
      // and SQLite BINARY ordering agree.
      const lastTieId = hdrTies.size > 0 ? [...hdrTies].sort().at(-1)! : "";
      let headerRows = hasHeaders
        ? (db
            .prepare(
              `SELECT composerId, recency, createdAt, value FROM composerHeaders
               WHERE recency > ? OR (recency = ? AND composerId > ?)
               ORDER BY recency ASC, composerId ASC LIMIT ?`
            )
            .all(watermark, watermark, lastTieId, MAX_COMPOSERS_PER_CALL) as ComposerHeaderRow[])
        : [];
      // Gap check: a live writer can commit a row AT the watermark recency
      // with a composerId at or below the keyset position after our previous
      // scan read past it (two commits of one same-millisecond burst, read in
      // between). The keyset alone would never fetch it again; the persisted
      // tie set makes it detectable — any unseen row at the boundary joins
      // this batch. (A late commit whose recency lands BELOW an already-
      // advanced watermark needs out-of-timestamp-order commits under writer
      // contention and is not covered — the old >= scheme didn't cover it
      // either.)
      if (hasHeaders && hdrTies.size > 0) {
        const gapRows = (
          db
            .prepare(
              `SELECT composerId, recency, createdAt, value FROM composerHeaders
               WHERE recency = ? AND composerId <= ?`
            )
            .all(watermark, lastTieId) as ComposerHeaderRow[]
        ).filter((r) => !hdrTies.has(r.composerId));
        if (gapRows.length > 0) headerRows = [...gapRows, ...headerRows];
      }

      let nextWatermark = watermark;
      for (const r of headerRows) if (r.recency > nextWatermark) nextWatermark = r.recency;
      const batchTies = headerRows.filter((r) => r.recency === nextWatermark).map((r) => r.composerId);
      // Watermark unchanged means we're still inside the same recency plateau:
      // the already-seen ties stay relevant for the next page's keyset, so
      // accumulate. Once it advances, only the new boundary's ties matter.
      const nextHdrTies = nextWatermark === watermark ? new Set([...hdrTies, ...batchTies]) : new Set(batchTies);

      const touchedHeaderedIds = new Set(headerRows.map((r) => r.composerId));

      const headeredIds = hasHeaders
        ? new Set((db.prepare("SELECT composerId FROM composerHeaders").all() as { composerId: string }[]).map((r) => r.composerId))
        : new Set<string>();

      // Whatever's left of this call's budget after the headered batch above —
      // keeps total touched composers per call bounded regardless of how the
      // two channels split.
      const legacyBudget = Math.max(0, MAX_COMPOSERS_PER_CALL - touchedHeaderedIds.size);
      // Known v1-scale costs, deliberate: this key scan and the headeredIds
      // fetch above run even on a no-op call (needed to notice brand-new
      // headerless composers and to count backlog honestly — a count-equality
      // fast path can mask a new legacy composer behind a deleted seen one),
      // and tieBreakIds re-serializes every legacy id each run. Fine at the
      // reference install's ~850 composers; revisit if either shows up in a
      // profile.
      const allComposerKeys = db
        .prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY key ASC")
        .all() as { key: string }[];
      const newLegacyIds: string[] = [];
      let legacyRemaining = 0;
      for (const { key } of allComposerKeys) {
        const id = key.slice("composerData:".length);
        if (headeredIds.has(id)) continue; // covered by the headered path above
        if (prevLegacySeen.has(id)) continue; // already indexed once, treated as static
        if (prevLegacyRetry.has(id)) continue; // re-attempted via the retry path below
        if (newLegacyIds.length < legacyBudget) newLegacyIds.push(id);
        else legacyRemaining++; // over budget this call — counted so the backlog is visible
      }

      // Headered rows beyond this call's cap: counted with the same keyset
      // predicate the next call will fetch with. Only worth a COUNT when the
      // batch actually filled up — a partial batch proves nothing remains.
      let headeredRemaining = 0;
      if (headerRows.length === MAX_COMPOSERS_PER_CALL) {
        const last = headerRows[headerRows.length - 1];
        headeredRemaining = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM composerHeaders
               WHERE recency > ? OR (recency = ? AND composerId > ?)`
            )
            .get(last.recency, last.recency, last.composerId) as { c: number }
        ).c;
      }
      const backlogRemaining = headeredRemaining + legacyRemaining;

      const headerValueById = new Map(headerRows.map((r) => [r.composerId, r.value]));
      // Last-resort per-composer timestamp when neither any bubble nor the
      // composer itself carries one: the header row's own createdAt (recency
      // when that is null) — approximate, but in the right era, unlike 1970.
      const headerTsById = new Map(headerRows.map((r) => [r.composerId, r.createdAt ?? r.recency]));
      // Retried headered composers are behind the watermark, so their header
      // rows weren't in this batch — fetch each directly for its project dir.
      if (prevRetry.size > 0) {
        const getHeader = db.prepare("SELECT recency, createdAt, value FROM composerHeaders WHERE composerId = ?");
        for (const id of prevRetry) {
          const row = getHeader.get(id) as { recency: number; createdAt: number | null; value: string } | undefined;
          if (row) {
            headerValueById.set(id, row.value);
            headerTsById.set(id, row.createdAt ?? row.recency);
          }
        }
      }

      const legacyIds = new Set<string>([...newLegacyIds, ...prevLegacyRetry]);
      const touchedIds = new Set<string>([...touchedHeaderedIds, ...prevRetry, ...legacyIds]);

      // Outcomes gathered by the loop below; the cursor is assembled from
      // them afterwards, so a composer that contributed nothing is never
      // advanced past silently.
      const nextRetry = new Set<string>();
      const nextLegacyRetry = new Set<string>();
      const legacySeenAdd: string[] = [];
      const skipped: string[] = [];
      const workspaceStorageDir = path.join(path.dirname(path.dirname(dbPath)), "workspaceStorage");
      let legacyProjectDirMap: Map<string, string> | undefined;

      const getComposerData = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
      const getBubble = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");

      const sessions: NormalizedSession[] = [];
      for (const composerId of touchedIds) {
        const composerRow = getComposerData.get(`composerData:${composerId}`) as { value: string } | undefined;
        // Deleted between discover and parse (or before a retry resolved):
        // permanently gone, so it leaves the retry sets and is advanced past.
        if (!composerRow) continue;

        let composer: ComposerDataValue;
        try {
          composer = JSON.parse(composerRow.value);
        } catch {
          // Corrupt composerData is permanent — surface it once instead of
          // silently indexing thinner, then stop re-scanning it (legacy ids
          // would otherwise be re-picked by every future run's key scan).
          skipped.push(`cursor composer ${composerId}: malformed composerData JSON`);
          if (legacyIds.has(composerId)) legacySeenAdd.push(composerId);
          continue;
        }

        let projectDir: string | undefined;
        let projectDirSource: "cwd" | "fallback" | undefined;
        const headerValue = headerValueById.get(composerId);
        if (headerValue) {
          projectDir = projectDirFromHeaderValue(headerValue);
          if (projectDir) projectDirSource = "cwd";
        }
        if (!projectDir) {
          if (!legacyProjectDirMap) legacyProjectDirMap = buildLegacyProjectDirMap(workspaceStorageDir);
          const fallbackDir = legacyProjectDirMap.get(composerId);
          if (fallbackDir) {
            projectDir = fallbackDir;
            projectDirSource = "fallback";
          }
        }
        // No directory-name-encodes-path convention here (composerId is a
        // bare UUID, unlike Claude Code's dash-decoded transcript dirnames),
        // so an unresolved project dir has no further fallback. The condition
        // is transient (the workspace may simply not have been reopened yet),
        // so the composer goes on the retry list rather than being advanced
        // past — indexing it under a guessed/empty path would be worse.
        if (!projectDir) {
          (legacyIds.has(composerId) ? nextLegacyRetry : nextRetry).add(composerId);
          continue;
        }

        const headers = composer.fullConversationHeadersOnly ?? [];
        // Pre-`_v` composers have no header list at all and keep their whole
        // conversation inline instead. Their bubbles usually have no KV row
        // (2,818 of 2,840 on the reference install), so the inline object IS
        // the only copy — reading it is the difference between indexing the
        // conversation and indexing nothing.
        const legacyConversation = headers.length === 0 ? composer.conversation ?? [] : [];
        const messages: NormalizedMessage[] = [];
        let parseErrors = 0;

        // A bubble that's neither a real error nor carries any of
        // text/tools/toolText (e.g. a bare step-marker with none of the
        // known content fields, or a whitespace-only `text` — confirmed
        // real: Cursor logs bare "\n\n\n" formatting-gap turns between
        // streamed tool calls) is skipped rather than indexed as a blank
        // card. Not an error: this is expected, not malformed data.
        const keep = (msg: NormalizedMessage | undefined): boolean =>
          Boolean(msg && (msg.text.trim() || msg.tools.length > 0 || msg.toolText));

        // Carried across the bubble loops: the last real createdAt seen, so a
        // bubble without one lands next to its true neighbor instead of at
        // the composer's creation time (which sorts before the opener).
        let carryTs: number | undefined;
        const headerTs = headerTsById.get(composerId);

        for (const h of headers) {
          const bubbleRow = getBubble.get(`bubbleId:${composerId}:${h.bubbleId}`) as { value: string } | undefined;
          if (!bubbleRow) continue; // pruned/expired bubble — not an error
          let d: BubbleValue | null;
          try {
            d = JSON.parse(bubbleRow.value);
          } catch {
            parseErrors++; // malformed JSON — a real error
            continue;
          }
          // A bubble row can be literally `null` (valid JSON — found in real
          // stores); anything non-object can't be a bubble.
          if (!d || typeof d !== "object" || Array.isArray(d)) {
            parseErrors++;
            continue;
          }
          const msg = parseBubbleValue(d, h.bubbleId, carryTs ?? composer.createdAt ?? headerTs);
          if (typeof d.createdAt === "number") carryTs = d.createdAt; // even when the bubble itself is dropped below
          if (!msg) {
            parseErrors++; // an unrecognized type — a real error
            continue;
          }
          if (!keep(msg)) continue;
          messages.push(msg);
        }

        for (const [i, entry] of legacyConversation.entries()) {
          if (!entry || typeof entry !== "object") continue;
          // Inline bubbles carry their own bubbleId; fall back to a
          // positional id so a malformed entry can't collide with a sibling.
          const bubbleId = entry.bubbleId ?? `${composerId}-legacy-${i}`;
          // Prefer a KV row when one does exist (22 of 2,840) — it's the
          // same bubble, but kept in sync with any later edit. If that row is
          // unreadable, the inline copy is still the same bubble — use it.
          const bubbleRow = getBubble.get(`bubbleId:${composerId}:${bubbleId}`) as { value: string } | undefined;
          let d: BubbleValue | null = entry;
          if (bubbleRow) {
            try {
              const fromRow = JSON.parse(bubbleRow.value);
              if (fromRow && typeof fromRow === "object" && !Array.isArray(fromRow)) d = fromRow;
            } catch {
              // fall through to the inline copy
            }
          }
          const msg = parseBubbleValue(d!, bubbleId, carryTs ?? composer.createdAt ?? headerTs);
          if (typeof d!.createdAt === "number") carryTs = d!.createdAt;
          if (!msg) {
            parseErrors++; // an unrecognized type — same real error the headered path counts
            continue;
          }
          if (!keep(msg)) continue;
          messages.push(msg);
        }
        messages.sort((a, b) => a.ts.localeCompare(b.ts));

        sessions.push({
          id: composerId,
          source: "cursor",
          projectDir,
          projectDirSource,
          filePath: dbPath,
          title: composer.name,
          startedAt: messages[0]?.ts,
          endedAt: messages[messages.length - 1]?.ts,
          messages,
          parseErrors,
          bytesConsumed: 0, // unused: watermark-cursor sources resume via parseSince's returned cursor
        });
        if (legacyIds.has(composerId)) legacySeenAdd.push(composerId);
      }

      const nextLegacySeen = new Set(prevLegacySeen);
      for (const id of legacySeenAdd) nextLegacySeen.add(id);
      const nextCursor: WatermarkCursorValue = {
        value: nextWatermark,
        tieBreakIds: [
          ...[...nextHdrTies].map((id) => `hdr:${id}`),
          ...[...nextRetry].map((id) => `retry:${id}`),
          ...[...nextLegacyRetry].map((id) => `lretry:${id}`),
          ...[...nextLegacySeen].map((id) => `legacy:${id}`),
        ],
      };

      return skipped.length > 0
        ? { sessions, cursor: nextCursor, backlogRemaining, skipped }
        : { sessions, cursor: nextCursor, backlogRemaining };
    } finally {
      db.close();
    }
  }
}
