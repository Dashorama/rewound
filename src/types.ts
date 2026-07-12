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
  source: "claude-code"; // adapter id; more later
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
