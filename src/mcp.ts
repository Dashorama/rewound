import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { search, collapseSnippetWhitespace } from "./search.js";
import { getSessionByIdOrPrefix, getMessagesForSession, parseJsonStringArray, hasAnyMessages } from "./db.js";

const MAX_RESPONSE_BYTES = 8192;
const EXCERPT_CHARS = 700;
const SUMMARY_TEXT_CHARS = 500;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_EXCERPT_CONTEXT = 3;
const MAX_EXCERPT_CONTEXT = 20;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

// Windows `text` to `maxChars` centered on the first query term found in it (case-
// insensitive substring search), so a hit whose match falls past `maxChars` still shows
// the match instead of unrelated leading text. FTS5 uses porter stemming, so a query term
// may not appear verbatim (e.g. "trigger" matching stored "triggers") — falls back to a
// leading truncate() in that case, same as before this existed.
function centeredExcerpt(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const lowerText = text.toLowerCase();
  let matchIndex = -1;
  for (const term of query.trim().split(/\s+/).filter(Boolean)) {
    const idx = lowerText.indexOf(term.toLowerCase());
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) matchIndex = idx;
  }
  if (matchIndex === -1) return truncate(text, maxChars);

  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, Math.min(matchIndex - half, text.length - maxChars));
  const end = start + maxChars;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}

// Byte-safe truncation for the joinWithinBudget backstop below: char-level truncate()
// already keeps normal content well under budget, this only fires as a last resort.
function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(0, Math.max(0, maxBytes - 1)).toString("utf8") + "…";
}

// Joins parts with `separator`, dropping trailing parts (and noting it) once the
// joined text would exceed `budgetBytes` — keeps any single MCP response bounded
// regardless of how many hits/messages matched. Callers should already truncate
// each part to a sane char length; this also hard-truncates a lone first part that
// alone exceeds the budget, so the cap holds even if a caller forgets to.
function joinWithinBudget(parts: string[], separator: string, budgetBytes: number): string {
  const kept: string[] = [];
  let usedBytes = 0;
  let truncated = false;
  for (const part of parts) {
    const partBytes = Buffer.byteLength(part, "utf8");
    if (kept.length === 0 && partBytes > budgetBytes) {
      kept.push(truncateBytes(part, budgetBytes));
      truncated = true;
      break;
    }
    const additional = partBytes + (kept.length > 0 ? Buffer.byteLength(separator, "utf8") : 0);
    if (kept.length > 0 && usedBytes + additional > budgetBytes) {
      truncated = true;
      break;
    }
    kept.push(part);
    usedBytes += additional;
  }
  const joined = kept.join(separator);
  return truncated ? `${joined}${separator}…(response truncated to stay under ~${budgetBytes} bytes)` : joined;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function createMcpServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: "rewound", version: "0.1.0" });

  server.registerTool(
    "search_history",
    {
      description:
        "Full-text search over past AI coding agent session transcripts on this machine. " +
        "Returns ranked excerpts with session id/title/date; use get_session_excerpt for more context around a hit.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms (plain words, matched as an AND of terms)"),
        project: z.string().optional().describe("Filter to sessions whose project directory contains this substring"),
        since: z.string().optional().describe("ISO timestamp or relative shorthand like '7d' / '24h'"),
        limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional().describe(`Max hits (default ${DEFAULT_SEARCH_LIMIT})`),
        all_matches: z
          .boolean()
          .optional()
          .describe("Return every matching message instead of one best hit per session"),
      },
    },
    async ({ query, project, since, limit, all_matches }) => {
      const hits = search(db, query, {
        project,
        since,
        allMatches: all_matches,
        limit: limit ?? DEFAULT_SEARCH_LIMIT,
      });
      if (hits.length === 0) {
        if (!hasAnyMessages(db)) {
          return textResult(
            `No matches for "${query}" — the index is empty. Run \`rewound index\` on this machine first to index its session transcripts.`
          );
        }
        return textResult(`No matches for "${query}".`);
      }

      const blocks = hits.map((h) =>
        [
          `session: ${h.sessionId}${h.title ? ` (${h.title})` : ""}`,
          `project: ${h.projectDir}  date: ${h.ts}  match_uuid: ${h.uuid}` +
            (h.matchesInSession > 1 ? `  matches_in_session: ${h.matchesInSession}` : ""),
          collapseSnippetWhitespace(centeredExcerpt(h.text, query, EXCERPT_CHARS)),
        ].join("\n")
      );
      const body = joinWithinBudget(blocks, "\n\n---\n\n", MAX_RESPONSE_BYTES - 200);
      return textResult(`${body}\n\nUse get_session_excerpt(session_id, match_uuid) for more context around a hit.`);
    }
  );

  server.registerTool(
    "get_session_summary",
    {
      description:
        "Summary of one past session: title, project, dates, message count, tools/models used, " +
        "first user prompt and last assistant response (truncated).",
      inputSchema: {
        session_id: z.string().describe("Session id or a unique id prefix"),
      },
    },
    async ({ session_id }) => {
      const session = getSessionByIdOrPrefix(db, session_id);
      if (!session) return textResult(`No session found matching "${session_id}".`, true);

      const messages = getMessagesForSession(db, session.id);
      const firstUser = messages.find((m) => m.role === "user");
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const toolsUsed = new Set<string>();
      for (const m of messages) {
        for (const t of parseJsonStringArray(m.tools)) toolsUsed.add(t);
      }

      const lines = [
        `session: ${session.id}`,
        `title: ${truncate(session.title ?? "(untitled)", SUMMARY_TEXT_CHARS)}`,
        `project: ${session.projectDir}  branch: ${session.gitBranch ?? "?"}`,
        `started: ${session.startedAt ?? "?"}  ended: ${session.endedAt ?? "?"}`,
        `messages: ${session.messageCount}`,
        `models: ${truncate(session.models.join(", ") || "(none)", SUMMARY_TEXT_CHARS)}`,
        `tools used: ${truncate(Array.from(toolsUsed).join(", ") || "(none)", SUMMARY_TEXT_CHARS)}`,
        `first user prompt: ${truncate(firstUser?.text ?? "", SUMMARY_TEXT_CHARS)}`,
        `last assistant response: ${truncate(lastAssistant?.text ?? "", SUMMARY_TEXT_CHARS)}`,
      ];
      return textResult(joinWithinBudget(lines, "\n", MAX_RESPONSE_BYTES));
    }
  );

  server.registerTool(
    "get_session_excerpt",
    {
      description:
        "Readable excerpt of a session: the message matching match_uuid plus `context` messages on " +
        "each side (or the start of the session if match_uuid is omitted).",
      inputSchema: {
        session_id: z.string().describe("Session id or a unique id prefix"),
        match_uuid: z.string().optional().describe("uuid of the message to center the excerpt on (from search_history)"),
        context: z
          .number()
          .int()
          .min(0)
          .max(MAX_EXCERPT_CONTEXT)
          .optional()
          .describe(`Messages of context on each side (default ${DEFAULT_EXCERPT_CONTEXT})`),
      },
    },
    async ({ session_id, match_uuid, context }) => {
      const session = getSessionByIdOrPrefix(db, session_id);
      if (!session) return textResult(`No session found matching "${session_id}".`, true);

      const messages = getMessagesForSession(db, session.id);
      const windowSize = context ?? DEFAULT_EXCERPT_CONTEXT;

      let start = 0;
      let end = Math.min(messages.length, windowSize * 2 + 1);
      if (match_uuid) {
        const idx = messages.findIndex((m) => m.uuid === match_uuid);
        if (idx === -1) {
          return textResult(`No message with uuid "${match_uuid}" in session "${session.id}".`, true);
        }
        start = Math.max(0, idx - windowSize);
        end = Math.min(messages.length, idx + windowSize + 1);
      }

      const lines = messages.slice(start, end).map((m) => {
        const tools = parseJsonStringArray(m.tools);
        const toolSummary = tools.length ? ` [tools: ${tools.join(", ")}]` : "";
        const sidechain = m.is_sidechain ? " (sidechain)" : "";
        return `[${m.ts}] ${m.role}${sidechain}: ${truncate(m.text, EXCERPT_CHARS)}${toolSummary}`;
      });
      return textResult(joinWithinBudget(lines, "\n", MAX_RESPONSE_BYTES));
    }
  );

  return server;
}

export async function startMcpServer(db: Database.Database): Promise<void> {
  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
