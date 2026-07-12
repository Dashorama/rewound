import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { search, type SearchOptions } from "./search.js";
import {
  listRecentProjects,
  listSessions,
  getSessionByIdOrPrefix,
  getMessagesForSession,
  getStats,
  getDailyMessageCounts,
  parseJsonStringArray,
} from "./db.js";
import { renderLayout } from "./web/layout.js";
import { escapeHtml } from "./web/html.js";
import { renderSearchPage } from "./web/pages/search.js";
import { renderSessionPage, type SessionPageMessage } from "./web/pages/session.js";
import { renderTimelinePage } from "./web/pages/timeline.js";
import { fillDailySeries, renderStatsPage } from "./web/pages/stats.js";

const PAGE_SIZE = 25;
const STATS_DAYS = 30;
const TIMELINE_SESSION_LIMIT = 500;
// Cap the search page's project suggestions so page weight stays bounded
// regardless of corpus size — the underlying filter still accepts any
// substring typed in, this just limits the datalist hint list.
const DEFAULT_SEARCH_PROJECT_SUGGESTIONS = 50;
// Same reasoning for the timeline's "pick a project" list.
const DEFAULT_TIMELINE_PROJECT_LIMIT = 100;
// Cap messages rendered per session page — real corpus sessions can run to
// 10k+ messages / several MB of HTML, which is unusable over a phone/Tailscale
// connection. Defaults to the most recent page (where a resumed session's
// context actually is); ?page= navigates to earlier parts of the transcript.
const DEFAULT_SESSION_PAGE_SIZE = 150;

export interface BuildServerOptions {
  db: Database.Database;
  searchProjectSuggestions?: number;
  timelineProjectLimit?: number;
  sessionPageSize?: number;
}

function parseRole(v: unknown): "user" | "assistant" | undefined {
  return v === "user" || v === "assistant" ? v : undefined;
}

// Fastify parses a repeated query param (?q=a&q=b) as an array rather than
// erroring, so every query field must be coerced through this before use.
function firstQueryValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

// `message` is always escaped internally so callers can pass raw untrusted
// text (e.g. a session id) straight in; `extraHtml` is an explicit raw-HTML
// slot for callers that already built safe markup (e.g. a pre-escaped link).
function renderErrorBody(code: number, message: string, extraHtml = ""): string {
  return `<div class="error-page"><div class="error-code">${code}</div><p>${escapeHtml(message)}</p>${extraHtml}</div>`;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const { db } = opts;
  const searchProjectSuggestions = opts.searchProjectSuggestions ?? DEFAULT_SEARCH_PROJECT_SUGGESTIONS;
  const timelineProjectLimit = opts.timelineProjectLimit ?? DEFAULT_TIMELINE_PROJECT_LIMIT;
  const sessionPageSize = opts.sessionPageSize ?? DEFAULT_SESSION_PAGE_SIZE;
  const app = Fastify({ logger: false });

  app.setNotFoundHandler((_req, reply) => {
    reply
      .code(404)
      .type("text/html; charset=utf-8")
      .send(
        renderLayout({
          title: "Not found",
          body: renderErrorBody(404, "Page not found.", '<p><a class="tap-target" href="/">Back to search</a></p>'),
        })
      );
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    reply
      .code(500)
      .type("text/html; charset=utf-8")
      .send(
        renderLayout({
          title: "Error",
          body: renderErrorBody(
            500,
            "Something went wrong handling your request.",
            `<p class="muted">${escapeHtml(err.message)}</p>`
          ),
        })
      );
  });

  app.get("/", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const q = (firstQueryValue(query.q) ?? "").trim();
    const page = Math.max(1, parseInt(firstQueryValue(query.page) ?? "1", 10) || 1);
    const project = firstQueryValue(query.project) || undefined;
    const since = firstQueryValue(query.since) || undefined;
    const role = parseRole(firstQueryValue(query.role));
    const sidechains = firstQueryValue(query.sidechains) === "1";
    const allMatches = firstQueryValue(query.all) === "1";

    const searchOpts: SearchOptions = {
      project,
      since,
      role,
      sidechains,
      allMatches,
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    };

    const hits = q ? search(db, q, searchOpts) : [];
    const hasMore = hits.length > PAGE_SIZE;
    const pageHits = hits.slice(0, PAGE_SIZE);
    const projects = listRecentProjects(db, searchProjectSuggestions);

    const body = renderSearchPage({
      q,
      project: project ?? "",
      since: since ?? "",
      role: role ?? "",
      sidechains,
      allMatches,
      hits: pageHits,
      projects,
      page,
      hasMore,
    });

    reply
      .type("text/html; charset=utf-8")
      .send(renderLayout({ title: "Search", activeNav: "search", body }));
  });

  app.get("/session/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSessionByIdOrPrefix(db, id);
    if (!session) {
      reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          renderLayout({
            title: "Not found",
            body: renderErrorBody(
              404,
              `No session found matching "${id}".`,
              '<p><a class="tap-target" href="/">Back to search</a></p>'
            ),
          })
        );
      return;
    }

    const totalPages = Math.max(1, Math.ceil(session.messageCount / sessionPageSize));
    const query = req.query as Record<string, unknown>;
    const requestedPage = parseInt(firstQueryValue(query.page) ?? "", 10);
    const page =
      Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= totalPages
        ? requestedPage
        : totalPages;
    const offset = (page - 1) * sessionPageSize;

    const messages: SessionPageMessage[] = getMessagesForSession(db, session.id, {
      limit: sessionPageSize,
      offset,
    }).map((r) => ({
      uuid: r.uuid,
      role: r.role,
      ts: r.ts,
      text: r.text,
      tools: parseJsonStringArray(r.tools),
      model: r.model ?? undefined,
      isSidechain: Boolean(r.is_sidechain),
    }));

    const body = renderSessionPage(session, messages, { page, totalPages });
    reply
      .type("text/html; charset=utf-8")
      .send(renderLayout({ title: session.title ?? session.id, body }));
  });

  app.get("/timeline", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const project = firstQueryValue(query.project) || undefined;
    const projects = listRecentProjects(db, timelineProjectLimit);
    const sessions = project ? listSessions(db, { project, limit: TIMELINE_SESSION_LIMIT }) : [];

    const body = renderTimelinePage({
      projects,
      selectedProject: project,
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        startedAt: s.startedAt,
        estCostUsd: s.estCostUsd,
        messageCount: s.messageCount,
      })),
    });

    reply
      .type("text/html; charset=utf-8")
      .send(renderLayout({ title: "Timeline", activeNav: "timeline", body }));
  });

  app.get("/stats", async (_req, reply) => {
    const stats = getStats(db, 20);
    const since = new Date(Date.now() - (STATS_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
    const daily = getDailyMessageCounts(db, since);
    const dailyCounts = fillDailySeries(daily, STATS_DAYS, new Date());

    const body = renderStatsPage({
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      totalCostUsd: stats.totalCostUsd,
      byProject: stats.byProject,
      dailyCounts,
    });

    reply
      .type("text/html; charset=utf-8")
      .send(renderLayout({ title: "Stats", activeNav: "stats", body }));
  });

  return app;
}
