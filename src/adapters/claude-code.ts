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
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: RawUsage;
  };
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

function extractAssistantContent(content: unknown): { text: string; tools: string[] } {
  const tools: string[] = [];
  if (!Array.isArray(content)) return { text: extractBlockText(content), tools };

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") {
        tools.push(b.name);
        continue;
      }
    }
    const t = extractBlockText(block);
    if (t) parts.push(t);
  }
  return { text: parts.join("\n\n"), tools };
}

function decodeProjectDir(filePath: string): string {
  const dirName = path.basename(path.dirname(filePath));
  return dirName.replace(/-/g, "/");
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

      if (record.type === "user" || record.type === "assistant") {
        const msg = record.message;
        const isAssistant = record.type === "assistant";
        const userContent = isAssistant ? undefined : extractUserContent(msg?.content);
        const { text: msgText, tools } = isAssistant
          ? extractAssistantContent(msg?.content)
          : { text: userContent!.text, tools: [] as string[] };

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
          toolText: userContent?.toolText || undefined,
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
      messages,
      parseErrors,
      bytesConsumed,
    };
  }
}
