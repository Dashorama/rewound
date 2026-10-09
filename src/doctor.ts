import fs from "node:fs";
import Database from "better-sqlite3";
import { CURSOR_READ_BUBBLE_FIELDS, CURSOR_IGNORED_BUBBLE_FIELDS } from "./adapters/cursor.js";

// Schema-drift detection.
//
// Cursor's transcript format moves under us: this project has already hit
// four distinct composerData shapes (pre-`_v`, and `_v` 2/3/10/13), two MCP
// tool-name conventions, edit_file -> edit_file_v2, and five separate
// content fields nobody knew to read (codeBlocks, thinking,
// serviceStatusUpdate, errorDetails, tool-call status). Every one of those
// was found by hand-auditing the raw store; nothing would have flagged them
// otherwise, and sessions just quietly got thinner.
//
// This reports fields the adapter doesn't read that nonetheless carry real
// text. It judges by CONTENT, not by a hand-maintained name list, so it
// keeps working as Cursor adds fields we've never heard of.

export interface DriftFinding {
  field: string;
  /** Bubbles where this field holds text worth looking at. */
  bubblesWithText: number;
  /** Bubbles where it's non-empty at all (text or not). */
  bubblesNonEmpty: number;
  /** Of bubblesWithText, how many are in bubbles the adapter indexes nothing for. */
  inOtherwiseEmptyBubbles: number;
  sampleText: string;
  sampleKey: string;
}

export interface DriftReport {
  source: string;
  dbPath: string;
  scannedBubbles: number;
  findings: DriftFinding[];
}

export interface DriftOptions {
  /**
   * A string this long is almost always prose or content; shorter ones are
   * labels, enum values and ids. Crude, but honest and tunable — and it
   * needs no per-field knowledge, which is the point.
   */
  minTextLength?: number;
  /** Cap the scan (0 = no cap). Useful on very large stores. */
  maxBubbles?: number;
}

const DEFAULT_MIN_TEXT_LENGTH = 40;
const COLLECT_DEPTH_LIMIT = 8;
// Values that are long but still not prose: hashes, uuids, base64 blobs.
const OPAQUE_RE = /^(?:[0-9a-f]{16,}|[A-Za-z0-9+/=]{80,}|[0-9a-f-]{32,})$/;

function collectText(value: unknown, minLength: number, depth = 0, out: string[] = []): string[] {
  if (depth > COLLECT_DEPTH_LIMIT) return out;
  if (typeof value === "string") {
    const s = value.trim();
    if (s.length >= minLength && !OPAQUE_RE.test(s)) out.push(s);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, minLength, depth + 1, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectText(v, minLength, depth + 1, out);
    }
  }
  return out;
}

function isNonEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

// Mirrors what parseBubble would end up indexing, without importing its
// internals: does this bubble contribute anything at all today?
function adapterFindsContent(d: Record<string, unknown>): boolean {
  if (typeof d.text === "string" && d.text.trim()) return true;
  const thinking = d.thinking as { text?: string } | undefined;
  if (thinking?.text?.trim()) return true;
  const status = d.serviceStatusUpdate as { message?: string } | undefined;
  if (status?.message) return true;
  const err = d.errorDetails as { message?: string } | undefined;
  if (err?.message) return true;
  const tfd = d.toolFormerData as Record<string, unknown> | undefined;
  if (tfd && (tfd.name || tfd.rawArgs || tfd.params || tfd.result || tfd.additionalData || tfd.status)) return true;
  const blocks = d.codeBlocks as Array<{ content?: string }> | undefined;
  if (blocks?.some((b) => b?.content)) return true;
  return false;
}

export function analyzeCursorDrift(dbPath: string, opts: DriftOptions = {}): DriftReport {
  const minTextLength = opts.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
  const maxBubbles = opts.maxBubbles ?? 0;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    interface Acc {
      bubblesWithText: number;
      bubblesNonEmpty: number;
      inOtherwiseEmptyBubbles: number;
      sampleText: string;
      sampleKey: string;
    }
    const acc = new Map<string, Acc>();
    let scanned = 0;

    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").iterate() as Iterable<{
      key: string;
      value: string;
    }>;

    for (const row of rows) {
      if (maxBubbles && scanned >= maxBubbles) break;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(row.value);
      } catch {
        continue;
      }
      // A bubble row can be literally `null` (valid JSON) — found in the real
      // store, not hypothetical.
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;
      if (d.type !== 1 && d.type !== 2) continue;
      scanned++;
      const otherwiseEmpty = !adapterFindsContent(d);

      for (const [field, value] of Object.entries(d)) {
        if (CURSOR_READ_BUBBLE_FIELDS.has(field) || CURSOR_IGNORED_BUBBLE_FIELDS.has(field)) continue;
        if (!isNonEmpty(value)) continue;

        let entry = acc.get(field);
        if (!entry) {
          entry = { bubblesWithText: 0, bubblesNonEmpty: 0, inOtherwiseEmptyBubbles: 0, sampleText: "", sampleKey: "" };
          acc.set(field, entry);
        }
        entry.bubblesNonEmpty++;

        const texts = collectText(value, minTextLength);
        if (texts.length === 0) continue;
        entry.bubblesWithText++;
        if (otherwiseEmpty) entry.inOtherwiseEmptyBubbles++;
        if (!entry.sampleText) {
          entry.sampleText = texts[0].slice(0, 200);
          entry.sampleKey = row.key;
        }
      }
    }

    const findings: DriftFinding[] = [...acc.entries()]
      .filter(([, v]) => v.bubblesWithText > 0)
      .map(([field, v]) => ({ field, ...v }))
      .sort((a, b) => b.bubblesWithText - a.bubblesWithText);

    return { source: "cursor", dbPath, scannedBubbles: scanned, findings };
  } finally {
    db.close();
  }
}

export function formatDriftReport(report: DriftReport): string[] {
  const lines: string[] = [];
  lines.push(`${report.source}: scanned ${report.scannedBubbles} bubbles in ${report.dbPath}`);
  if (report.findings.length === 0) {
    lines.push("no unrecognised fields carrying text — adapter coverage looks complete");
    return lines;
  }
  lines.push("");
  lines.push(`${report.findings.length} unrecognised field(s) carrying real text:`);
  lines.push("");
  for (const f of report.findings) {
    const lost = f.inOtherwiseEmptyBubbles > 0 ? `, ${f.inOtherwiseEmptyBubbles} in bubbles we index NOTHING for` : "";
    lines.push(`  ${f.field}  —  ${f.bubblesWithText} bubbles with text (of ${f.bubblesNonEmpty} non-empty)${lost}`);
    lines.push(`      e.g. ${JSON.stringify(f.sampleText)}`);
    lines.push(`      at   ${f.sampleKey}`);
    lines.push("");
  }
  lines.push("Each of these is either content worth indexing, or something to add to");
  lines.push("CURSOR_IGNORED_BUBBLE_FIELDS in src/adapters/cursor.ts with a reason.");
  return lines;
}

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
