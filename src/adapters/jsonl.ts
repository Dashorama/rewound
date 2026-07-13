import fs from "node:fs";
import path from "node:path";

// Shared machinery for append-only JSONL transcript files.
//
// Only ever consume complete, newline-terminated lines. If the file is
// mid-write (the writer appended a record's bytes but hasn't flushed its
// trailing "\n" yet), the last fragment is torn — leave it unconsumed and
// unparsed so the next incremental call re-reads it whole, rather than either
// erroring on it or silently skipping past it.
export function consumeCompleteLines(
  filePath: string,
  fromByte: number
): { lines: string[]; bytesConsumed: number } {
  const buf = fs.readFileSync(filePath);
  const slice = buf.subarray(fromByte);
  const lastNewline = slice.lastIndexOf(0x0a); // "\n"
  const consumedSlice = lastNewline === -1 ? slice.subarray(0, 0) : slice.subarray(0, lastNewline + 1);
  const bytesConsumed = fromByte + consumedSlice.length;
  const text = consumedSlice.length > 0 ? consumedSlice.toString("utf8") : "";
  const lines = text.length > 0 ? text.split("\n") : [];
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
