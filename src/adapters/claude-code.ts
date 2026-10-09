import fs from "node:fs";
import path from "node:path";
import type { NormalizedMessage, NormalizedSession, SourceAdapter } from "../types.js";
import { consumeCompleteLines, walkJsonlFiles } from "./jsonl.js";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  aiTitle?: string;
  // For a top-level session file, this equals the file's own id (filename
  // stem). For a subagent transcript (<parent>/subagents/agent-<id>.jsonl),
  // it's the PARENT session's id instead — confirmed on real transcripts.
  // That mismatch is the only signal available; there's no explicit
  // "parentSessionId" field.
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: RawUsage;
  };
}

// Sibling metadata file Claude Code writes next to each subagent transcript
// (<parent>/subagents/agent-<id>.meta.json) — the Task tool call's own
// inputs, not present anywhere in the transcript itself.
interface SubagentMeta {
  agentType?: string;
  description?: string;
}

function extractBlockText(block: unknown): string {
  if (block == null) return "";
  if (typeof block === "string") return block;
  if (Array.isArray(block)) {
    return block.map(extractBlockText).filter(Boolean).join("\n\n");
  }
  if (typeof block === "object") {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") return b.text;
    if (b.type === "thinking" && typeof b.thinking === "string") return b.thinking;
    if (b.type === "tool_result") return extractBlockText(b.content);
    // tool_use, image, and any unknown block type contribute no searchable text.
  }
  return "";
}

function extractUserContent(content: unknown): { text: string; toolText: string } {
  if (typeof content === "string") return { text: content, toolText: "" };
  if (!Array.isArray(content)) return { text: extractBlockText(content), toolText: "" };
  const prose: string[] = [];
  const tool: string[] = [];
  for (const block of content) {
    const isToolResult =
      block != null && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result";
    const t = extractBlockText(block);
    if (!t) continue;
    (isToolResult ? tool : prose).push(t);
  }
  return { text: prose.join("\n\n"), toolText: tool.join("\n\n") };
}

// tool_use.input (the command, file path, edit strings, ...) used to be
// dropped entirely — only the tool NAME was kept, same class of gap as the
// Cursor adapter's edit_file_v2 issue. The corresponding tool_result (the
// output) already lands correctly on the following user-role message via
// extractUserContent below; this only fixes the input/arguments side.
function extractAssistantContent(content: unknown): { text: string; tools: string[]; toolText: string } {
  const tools: string[] = [];
  const toolInputs: string[] = [];
  if (!Array.isArray(content)) return { text: extractBlockText(content), tools, toolText: "" };

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") {
        tools.push(b.name);
        if (b.input !== undefined) {
          try {
            toolInputs.push(typeof b.input === "string" ? b.input : JSON.stringify(b.input));
          } catch {
            // circular or unserializable input — skip rather than throw
          }
        }
        continue;
      }
    }
    const t = extractBlockText(block);
    if (t) parts.push(t);
  }
  return { text: parts.join("\n\n"), tools, toolText: toolInputs.join("\n\n") };
}

function decodeProjectDir(filePath: string): string {
  const dirName = path.basename(path.dirname(filePath));
  return dirName.replace(/-/g, "/");
}

// <dir>/agent-<id>.jsonl -> <dir>/agent-<id>.meta.json, read only for
// subagent transcripts (harmless if it doesn't exist — most transcripts
// don't have one).
function readSubagentMeta(jsonlPath: string): SubagentMeta | undefined {
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return undefined;
  }
}

export class ClaudeCodeAdapter implements SourceAdapter {
  id = "claude-code";

  discover(roots: string[]): string[] {
    const found: string[] = [];
    for (const root of roots) walkJsonlFiles(root, found);
    // rollout-*.jsonl are Codex CLI files (CodexAdapter's territory) — keep the
    // two adapters disjoint even when a user points --roots at a mixed tree.
    return found.filter((f) => !/^rollout-.*\.jsonl$/.test(path.basename(f)));
  }

  parse(filePath: string, fromByte = 0): NormalizedSession {
    const id = path.basename(filePath, ".jsonl");
    const { lines, bytesConsumed } = consumeCompleteLines(filePath, fromByte);

    const messages: NormalizedMessage[] = [];
    let title: string | undefined;
    let gitBranch: string | undefined;
    let projectDir: string | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let parentSessionId: string | undefined;
    let parseErrors = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record: RawRecord;
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

      if (record.cwd && !projectDir) projectDir = record.cwd;
      if (record.gitBranch && !gitBranch) gitBranch = record.gitBranch;
      // A top-level session's own sessionId always equals its filename; a
      // subagent transcript's sessionId is the PARENT's id instead — the only
      // signal available (confirmed against real transcripts, no separate
      // "parentSessionId" field exists).
      if (!parentSessionId && record.sessionId && record.sessionId !== id) parentSessionId = record.sessionId;

      if (record.type === "user" || record.type === "assistant") {
        const msg = record.message;
        const isAssistant = record.type === "assistant";
        const userContent = isAssistant ? undefined : extractUserContent(msg?.content);
        const { text: msgText, tools, toolText: assistantToolText } = isAssistant
          ? extractAssistantContent(msg?.content)
          : { text: userContent!.text, tools: [] as string[], toolText: "" };

        const usage =
          isAssistant && msg?.usage
            ? {
                input: msg.usage.input_tokens ?? 0,
                output: msg.usage.output_tokens ?? 0,
                cacheRead: msg.usage.cache_read_input_tokens ?? 0,
                cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
              }
            : undefined;

        messages.push({
          uuid: record.uuid ?? "",
          role: record.type,
          ts: record.timestamp ?? "",
          text: msgText,
          toolText: (isAssistant ? assistantToolText : userContent?.toolText) || undefined,
          tools,
          model: isAssistant ? msg?.model : undefined,
          isSidechain: Boolean(record.isSidechain),
          usage,
        });

        if (record.timestamp) {
          if (!startedAt || record.timestamp < startedAt) startedAt = record.timestamp;
          if (!endedAt || record.timestamp > endedAt) endedAt = record.timestamp;
        }
      } else if (record.type === "ai-title") {
        if (typeof record.aiTitle === "string") title = record.aiTitle;
      }
      // system, attachment, file-history-snapshot, last-prompt, mode,
      // permission-mode, bridge-session, and any unrecognized type: skip silently.
    }

    const meta = parentSessionId ? readSubagentMeta(filePath) : undefined;

    return {
      id,
      source: "claude-code",
      projectDir: projectDir ?? decodeProjectDir(filePath),
      projectDirSource: projectDir ? "cwd" : "fallback",
      filePath,
      title,
      gitBranch,
      startedAt,
      endedAt,
      parentSessionId,
      agentType: meta?.agentType,
      agentDescription: meta?.description,
      messages,
      parseErrors,
      bytesConsumed,
    };
  }
}
