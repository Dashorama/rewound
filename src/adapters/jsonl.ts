import fs from "node:fs";
import path from "node:path";

// Shared machinery for append-only JSONL transcript files.
//
// Only ever consume complete, newline-terminated lines. If the file is
// mid-write (the writer appended a record's bytes but hasn't flushed its
// trailing "\n" yet), the last fragment is torn — leave it unconsumed and
// unparsed so the next incremental call re-reads it whole, rather than either
// erroring on it or silently skipping past it.
// V8 caps a single string at ~512 MB (ERR_STRING_TOO_LONG), so decoding the
// whole consumed region in one toString() aborts on transcripts that grew past
// it even when every individual line is small (#2). Decode in newline-aligned
// chunks instead: cuts always land after a "\n" byte (0x0a never appears
// inside a multi-byte UTF-8 sequence), so no record and no character is ever
// split. A single line longer than the chunk is extended to its terminating
// newline rather than torn.
const DECODE_CHUNK_BYTES = 128 * 1024 * 1024;

export function consumeCompleteLines(
  filePath: string,
  fromByte: number,
  chunkBytes: number = DECODE_CHUNK_BYTES
): { lines: string[]; bytesConsumed: number } {
  const buf = fs.readFileSync(filePath);
  const slice = buf.subarray(fromByte);
  const lastNewline = slice.lastIndexOf(0x0a); // "\n"
  const consumedSlice = lastNewline === -1 ? slice.subarray(0, 0) : slice.subarray(0, lastNewline + 1);
  const bytesConsumed = fromByte + consumedSlice.length;

  const lines: string[] = [];
  let offset = 0;
  while (offset < consumedSlice.length) {
    let end = Math.min(offset + chunkBytes, consumedSlice.length);
    if (end < consumedSlice.length) {
      const nl = consumedSlice.lastIndexOf(0x0a, end - 1);
      if (nl >= offset) {
        end = nl + 1;
      } else {
        // Single line longer than chunkBytes: consumedSlice always ends on a
        // newline, so the forward scan is guaranteed to find one.
        const next = consumedSlice.indexOf(0x0a, end);
        end = next === -1 ? consumedSlice.length : next + 1;
      }
    }
    for (const line of consumedSlice.subarray(offset, end).toString("utf8").split("\n")) {
      if (line.length > 0) lines.push(line); // callers skip blank lines anyway
    }
    offset = end;
  }
  return { lines, bytesConsumed };
}

export function walkJsonlFiles(dir: string, found: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(full);
    }
  }
}
