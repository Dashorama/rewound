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
  parentSessionId?: string;
  agentType?: string;
  agentDescription?: string;
}

export interface SessionPageMessage {
  uuid: string;
  role: string;
  ts: string;
  text: string;
  tools: string[];
  toolText?: string;
  model?: string;
  isSidechain: boolean;
}

function renderMessage(m: SessionPageMessage): string {
  // A genuinely contentless turn (confirmed real: e.g. a Claude Code
  // extended-thinking block with empty thinking text but real billed
  // usage — signature present, no plaintext returned). Kept in storage
  // deliberately (its token usage feeds the session's cost estimate,
  // unlike Cursor's messages which never carry usage at all) — this is a
  // display-only skip, not a data gap.
  if (!m.text.trim() && m.tools.length === 0 && !m.toolText) return "";

  const sidechainBadge = m.isSidechain ? `<span class="badge accent">subagent</span>` : "";
  const modelBadge = m.model ? `<span class="badge">${escapeHtml(m.model)}</span>` : "";
  const meta = `<div class="muted">${escapeHtml(m.ts)} · <span class="role-label">${escapeHtml(m.role)}</span> ${modelBadge} ${sidechainBadge}</div>`;
  const text = escapeHtml(m.text);
  const roleClass = m.role === "assistant" ? "message-assistant" : "message-user";
  const cardClass = `card message ${roleClass}`;

  const toolTextBlock = m.toolText ? `<div class="muted">detail</div><pre>${escapeHtml(m.toolText)}</pre>` : "";

  // No tool call, but there's still reasoning/status content in toolText
  // (e.g. Cursor's thinking blocks or a service-status note) — show it
  // plainly, no <details> collapse, since there are no tool chips to serve
  // as the "click to expand" affordance.
  if (m.tools.length === 0) {
    return `<article class="${cardClass}">${meta}<pre>${text}</pre>${toolTextBlock}</article>`;
  }

  const toolChips = m.tools.map((t) => `<span class="badge tool-chip">${escapeHtml(t)}</span>`).join(" ");
  return `<article class="${cardClass}">${meta}<details><summary>🔧 ${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}: ${toolChips}</summary><pre>${text}</pre>${toolTextBlock}</details></article>`;
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
  // Subagent sessions never get a title (no ai-title record) — the task
  // description from the sibling .meta.json is a far better heading than
  // the raw "agent-<id>" fallback.
  const heading = escapeHtml(session.title ?? session.agentDescription ?? session.id);
  const archivedBadge = session.archived
    ? `<span class="badge accent">archived</span>`
    : "";
  const subagentBadge = session.parentSessionId
    ? `<span class="badge accent">subagent${session.agentType ? `: ${escapeHtml(session.agentType)}` : ""}</span>`
    : "";
  const parentRow = session.parentSessionId
    ? `<div class="muted">spawned by <a href="/session/${encodeURIComponent(session.parentSessionId)}">${escapeHtml(session.parentSessionId)}</a></div>`
    : "";
  const resumeCmd = resumeCommand(session.source, session.id, session.projectDir);

  const header = `
<header class="session-header">
  <h1>${heading} ${archivedBadge} ${subagentBadge}</h1>
  <div class="muted">
    ${escapeHtml(session.projectDir)} · branch ${escapeHtml(session.gitBranch ?? "?")} ·
    ${escapeHtml(session.startedAt ?? "?")} &ndash; ${escapeHtml(session.endedAt ?? "?")} ·
    ${session.messageCount} messages · <span title="Estimated cost at API list prices">est. API $${session.estCostUsd.toFixed(4)}</span> ·
    ${session.models.map(escapeHtml).join(", ") || "no model recorded"}
  </div>
  ${parentRow}
  <p class="resume-row">
    <code id="resume-cmd">${escapeHtml(resumeCmd)}</code>
    <button type="button" class="copy-btn" data-copy-target="resume-cmd">Copy</button>
  </p>
</header>`;

  const transcript = messages.map(renderMessage).join("");
  const paginationHtml = pagination ? renderPagination(session.id, pagination) : "";

  return `${header}${paginationHtml}<section class="transcript">${transcript}</section>${paginationHtml}`;
}
