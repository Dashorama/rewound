import crypto from "node:crypto";
import path from "node:path";
import type { NormalizedMessage, NormalizedSession, SourceAdapter } from "../types.js";
import { consumeCompleteLines, walkJsonlFiles } from "./jsonl.js";

// Codex CLI persists sessions as ~/.codex/sessions/YYYY/MM/DD/
// rollout-<timestamp>-<uuid>.jsonl — newline-delimited RolloutLine records:
// { timestamp, type, payload }. We map:
//   session_meta                → session id / cwd / git branch
//   turn_context                → current model (applied to assistant messages)
//   response_item message       → user/assistant prose
//   response_item reasoning     → assistant prose (like Claude thinking)
//   response_item function_call → assistant tool-call entry
//   response_item function_call_output → tool output (ranked below prose)
//   compacted / event_msg / anything unknown → skipped silently
// Rollout files can reach hundreds of MB from compaction replay; skipping
// unknown types cheaply and never re-reading consumed bytes matters here.

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

const ROLLOUT_RE = /rollout-.*\.jsonl$/;
const UUID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const t = (item as Record<string, unknown>).text;
      if (typeof t === "string" && t) parts.push(t);
    }
  }
  return parts.join("\n\n");
}

function messageUuid(ts: string, role: string, text: string): string {
  return crypto.createHash("sha1").update(`${ts}|${role}|${text}`).digest("hex").slice(0, 16);
}

export class CodexAdapter implements SourceAdapter {
  id = "codex";

  discover(roots: string[]): string[] {
    const found: string[] = [];
    for (const root of roots) walkJsonlFiles(root, found);
    return found.filter((f) => ROLLOUT_RE.test(path.basename(f)));
  }

  parse(filePath: string, fromByte = 0): NormalizedSession {
    const uuidMatch = UUID_RE.exec(path.basename(filePath));
    const id = uuidMatch ? uuidMatch[1] : path.basename(filePath, ".jsonl");
    const { lines, bytesConsumed } = consumeCompleteLines(filePath, fromByte);

    const messages: NormalizedMessage[] = [];
    let projectDir: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let parseErrors = 0;

    const push = (m: Omit<NormalizedMessage, "uuid" | "isSidechain">) => {
      messages.push({ ...m, uuid: messageUuid(m.ts, m.role, m.text || m.toolText || ""), isSidechain: false });
      if (m.ts) {
        if (!startedAt || m.ts < startedAt) startedAt = m.ts;
        if (!endedAt || m.ts > endedAt) endedAt = m.ts;
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record: RolloutLine;
      try {
        record = JSON.parse(trimmed);
      } catch {
        parseErrors++;
        continue;
      }
      if (!record || typeof record !== "object" || typeof record.type !== "string") {
        parseErrors++;
        continue;
      }
      const ts = record.timestamp ?? "";
      const p = record.payload;
      if (!p || typeof p !== "object") continue;

      if (record.type === "session_meta") {
        if (typeof p.cwd === "string" && !projectDir) projectDir = p.cwd;
        const git = p.git as Record<string, unknown> | undefined;
        if (git && typeof git.branch === "string" && !gitBranch) gitBranch = git.branch;
        continue;
      }
      if (record.type === "turn_context") {
        if (typeof p.model === "string") model = p.model;
        continue;
      }
      if (record.type !== "response_item") continue; // compacted, event_msg, drift: skip

      const itemType = p.type;
      if (itemType === "message") {
        const role = p.role === "assistant" ? "assistant" : p.role === "user" ? "user" : undefined;
        if (!role) continue;
        const text = contentText(p.content);
        if (!text) continue;
        push({ role, ts, text, tools: [], model: role === "assistant" ? model : undefined });
      } else if (itemType === "reasoning") {
        const text = [contentText(p.summary), contentText(p.content)].filter(Boolean).join("\n\n");
        if (text) push({ role: "assistant", ts, text, tools: [], model });
      } else if (itemType === "function_call" || itemType === "local_shell_call" || itemType === "custom_tool_call") {
        const name = typeof p.name === "string" ? p.name : itemType === "local_shell_call" ? "shell" : "tool";
        push({ role: "assistant", ts, text: "", tools: [name], model });
      } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        const out = typeof p.output === "string" ? p.output : contentText(p.output);
        if (out) push({ role: "user", ts, text: "", toolText: out, tools: [] });
      }
      // unknown response_item types: skip silently (format drift tolerance)
    }

    return {
      id,
      source: "codex",
      projectDir: projectDir ?? "(unknown project)",
      projectDirSource: projectDir ? "cwd" : "fallback",
      filePath,
      gitBranch,
      startedAt,
      endedAt,
      messages,
      parseErrors,
      bytesConsumed,
    };
  }
}
