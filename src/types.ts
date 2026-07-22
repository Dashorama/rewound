export interface NormalizedMessage {
  uuid: string;
  role: "user" | "assistant";
  ts: string; // ISO timestamp
  text: string; // extracted searchable prose — typed user text, assistant text/thinking ("" if none)
  // tool_result output carried by this message. Kept apart from `text` so search
  // can rank a human sentence above a shell dump that merely mentions the term.
  toolText?: string;
  tools: string[]; // tool_use names in this message
  model?: string;
  isSidechain: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface NormalizedSession {
  id: string; // sessionId (filename stem)
  source: string; // adapter id, e.g. "claude-code" | "codex"
  projectDir: string; // decoded, e.g. /home/dev/myapp
  // How projectDir was derived. "cwd" = from a message's cwd field (authoritative);
  // "fallback" = naive dash→slash decode of the transcript dir name, which is ambiguous
  // for hyphenated project names. Consumers must never let a fallback-derived value
  // overwrite a stored cwd-derived one. Absent = treat as fallback.
  projectDirSource?: "cwd" | "fallback";
  filePath: string;
  title?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  messages: NormalizedMessage[];
  // Session-level token usage for this parse chunk, for sources (Codex CLI)
  // that report usage in separate per-turn events rather than on messages.
  // Summed into the session totals exactly like per-message usage.
  usageDelta?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  parseErrors: number;
  // Byte offset (relative to the whole file, i.e. fromByte + bytes read this
  // call) right after the last complete (newline-terminated) line this parse
  // actually processed. A trailing line with no newline yet (the file is
  // mid-write) is never consumed, so this authoritatively reflects what was
  // parsed — the caller must use this, not an independent fs.stat, as the
  // resume point for the next incremental parse.
  bytesConsumed: number;
}

export interface SourceAdapter {
  id: string;
  discover(roots: string[]): string[]; // files it owns
  parse(filePath: string, fromByte?: number): NormalizedSession; // partial parse for incremental
}

// The resume token an adapter defines for its own source, persisted by the
// indexer between runs. Two kinds exist: "byte-offsets" (SourceAdapter above —
// one append-only file per session) and "watermark" (WatermarkSourceAdapter
// below — one shared source holds many sessions and rows update in place, so
// resume is a high-water mark on last-modified time instead of a byte count).
export type SourceCursor =
  | { kind: "byte-offsets"; value: number }
  | { kind: "watermark"; value: number };

// For sources where one file/DB is shared by many sessions and existing rows
// are updated in place rather than only appended (e.g. OpenCode's SQLite DB).
// Unlike SourceAdapter.parse, one call can return zero, one, or many sessions,
// and a returned message may be a revision of one already indexed — the
// indexer upserts by NormalizedMessage.uuid instead of blind-appending.
export interface WatermarkSourceAdapter {
  id: string;
  cursorKind: "watermark";
  discover(roots: string[]): string[]; // source paths it owns (e.g. a shared db file)
  parseSince(sourcePath: string, cursor?: number): { sessions: NormalizedSession[]; cursor: number };
}
