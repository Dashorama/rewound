import { escapeHtml } from "../html.js";

export interface TimelineSession {
  id: string;
  title?: string;
  startedAt?: string;
  estCostUsd: number;
  messageCount: number;
  parentSessionId?: string;
  agentType?: string;
  agentDescription?: string;
}

export interface TimelinePageOptions {
  projects: string[];
  selectedProject?: string;
  sessions: TimelineSession[];
}

function renderProjectList(projects: string[]): string {
  const items = projects
    .map(
      (p) =>
        `<li><a class="card project-link" href="/timeline?project=${encodeURIComponent(p)}">${escapeHtml(p)}</a></li>`
    )
    .join("");
  return `<p class="muted">Pick a project to see its timeline:</p><ul class="project-list">${items}</ul>`;
}

function dayKey(startedAt: string | undefined): string {
  return startedAt ? startedAt.slice(0, 10) : "unknown date";
}

function renderSessionRow(s: TimelineSession): string {
  // Subagent sessions never get a title (no ai-title record) — the task
  // description from the sibling .meta.json is a far better heading than
  // the raw "agent-<id>" fallback.
  const heading = escapeHtml(s.title ?? s.agentDescription ?? s.id);
  const subagentBadge = s.parentSessionId
    ? `<span class="badge accent">subagent${s.agentType ? `: ${escapeHtml(s.agentType)}` : ""}</span>`
    : "";
  const parentLink = s.parentSessionId
    ? ` · <a href="/session/${encodeURIComponent(s.parentSessionId)}">parent session</a>`
    : "";
  return `
<article class="card session-row">
  <div class="session-row-title"><a class="tap-target" href="/session/${encodeURIComponent(s.id)}">${heading}</a> ${subagentBadge}</div>
  <div class="muted">${escapeHtml(s.startedAt ?? "?")} · <span class="count">${s.messageCount} msgs</span> · <span class="cost" title="Estimated cost at API list prices">$${s.estCostUsd.toFixed(4)}</span>${parentLink}</div>
</article>`;
}

export function renderTimelinePage(opts: TimelinePageOptions): string {
  if (!opts.selectedProject) {
    return renderProjectList(opts.projects);
  }

  const heading = `<h1>${escapeHtml(opts.selectedProject)}</h1>`;

  if (opts.sessions.length === 0) {
    return `${heading}<p class="muted">No sessions found for this project.</p>`;
  }

  const groups = new Map<string, TimelineSession[]>();
  for (const s of opts.sessions) {
    const key = dayKey(s.startedAt);
    const group = groups.get(key) ?? [];
    group.push(s);
    groups.set(key, group);
  }

  const days = Array.from(groups.entries())
    .map(
      ([date, sessions]) =>
        `<section class="day-group"><h2 class="day-header">${escapeHtml(date)}</h2>${sessions.map(renderSessionRow).join("")}</section>`
    )
    .join("");

  return `${heading}${days}`;
}
