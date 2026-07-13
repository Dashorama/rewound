import { escapeHtml } from "../html.js";
import { resumeCommand } from "../../search.js";

export interface SessionPageSession {
  id: string;
  source?: string;
  projectDir: string;
  gitBranch?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  messageCount: number;
  models: string[];
  estCostUsd: number;
  archived: boolean;
}

export interface SessionPageMessage {
  uuid: string;
  role: string;
  ts: string;
  text: string;
  tools: string[];
  model?: string;
  isSidechain: boolean;
}

function renderMessage(m: SessionPageMessage): string {
  const sidechainBadge = m.isSidechain ? `<span class="badge accent">subagent</span>` : "";
  const modelBadge = m.model ? `<span class="badge">${escapeHtml(m.model)}</span>` : "";
  const meta = `<div class="muted">${escapeHtml(m.ts)} · <span class="role-label">${escapeHtml(m.role)}</span> ${modelBadge} ${sidechainBadge}</div>`;
  const text = escapeHtml(m.text);
  const roleClass = m.role === "assistant" ? "message-assistant" : "message-user";
  const cardClass = `card message ${roleClass}`;

  if (m.tools.length === 0) {
    return `<article class="${cardClass}">${meta}<pre>${text}</pre></article>`;
  }

  const toolChips = m.tools.map((t) => `<span class="badge tool-chip">${escapeHtml(t)}</span>`).join(" ");
  return `<article class="${cardClass}">${meta}<details><summary>🔧 ${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}: ${toolChips}</summary><pre>${text}</pre></details></article>`;
}

export interface SessionPagePagination {
  page: number;
  totalPages: number;
}

function renderPagination(sessionId: string, p: SessionPagePagination): string {
  if (p.totalPages <= 1) return "";
  const prev =
    p.page > 1
      ? `<a rel="prev" href="/session/${encodeURIComponent(sessionId)}?page=${p.page - 1}">&larr; Earlier</a>`
      : "";
  const next =
    p.page < p.totalPages
      ? `<a rel="next" href="/session/${encodeURIComponent(sessionId)}?page=${p.page + 1}">Later &rarr;</a>`
      : "";
  return `<nav class="pagination"><span class="muted">Page ${p.page} of ${p.totalPages}</span> ${prev} ${next}</nav>`;
}

export function renderSessionPage(
  session: SessionPageSession,
  messages: SessionPageMessage[],
  pagination?: SessionPagePagination
): string {
  const heading = escapeHtml(session.title ?? session.id);
  const archivedBadge = session.archived
    ? `<span class="badge accent">archived</span>`
    : "";
  const resumeCmd = resumeCommand(session.source, session.id);

  const header = `
<header class="session-header">
  <h1>${heading} ${archivedBadge}</h1>
  <div class="muted">
    ${escapeHtml(session.projectDir)} · branch ${escapeHtml(session.gitBranch ?? "?")} ·
    ${escapeHtml(session.startedAt ?? "?")} &ndash; ${escapeHtml(session.endedAt ?? "?")} ·
    ${session.messageCount} messages · <span title="Estimated cost at API list prices">est. API $${session.estCostUsd.toFixed(4)}</span> ·
    ${session.models.map(escapeHtml).join(", ") || "no model recorded"}
  </div>
  <p class="resume-row">
    <code id="resume-cmd">${escapeHtml(resumeCmd)}</code>
    <button type="button" class="copy-btn" data-copy-target="resume-cmd">Copy</button>
  </p>
</header>`;

  const transcript = messages.map(renderMessage).join("");
  const paginationHtml = pagination ? renderPagination(session.id, pagination) : "";

  return `${header}${paginationHtml}<section class="transcript">${transcript}</section>${paginationHtml}`;
}
