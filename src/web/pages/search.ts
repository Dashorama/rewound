import { escapeHtml, highlightSnippetHtml } from "../html.js";

export interface SearchPageHit {
  sessionId: string;
  uuid: string;
  role: string;
  ts: string;
  projectDir: string;
  title?: string;
  snippet: string;
  isSidechain: boolean;
  estCostUsd: number;
}

export interface SearchPageOptions {
  q: string;
  project: string;
  since: string;
  role: string;
  sidechains: boolean;
  hits: SearchPageHit[];
  projects: string[];
  page: number;
  hasMore: boolean;
}

const EXAMPLE_QUERIES = ["auth bug", "database migration", "failing test", "refactor", "TODO"];

function pageQueryString(opts: SearchPageOptions, page: number): string {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.project) params.set("project", opts.project);
  if (opts.since) params.set("since", opts.since);
  if (opts.role) params.set("role", opts.role);
  if (opts.sidechains) params.set("sidechains", "1");
  if (page > 1) params.set("page", String(page));
  // URLSearchParams percent-encodes every value, so the only raw character
  // left over is the "&" joining params — escape it for valid HTML markup.
  const qs = params.toString().replace(/&/g, "&amp;");
  return qs ? `?${qs}` : "";
}

function renderFilters(opts: SearchPageOptions, variant: "hero" | "compact"): string {
  const projectOptions = opts.projects
    .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
    .join("");

  const roleOptions = ["", "user", "assistant"]
    .map((r) => {
      const label = r === "" ? "Any role" : r;
      return `<option value="${r}"${r === opts.role ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const formClass = variant === "hero" ? "filters filters-hero" : "filters";
  const autofocus = variant === "hero" ? " autofocus" : "";

  return `
<form class="${formClass}" method="get" action="/">
  <input type="text" name="q" placeholder="Search your agent history..." value="${escapeHtml(opts.q)}"${autofocus} />
  <input type="text" name="project" list="project-options" placeholder="filter by project (optional)" value="${escapeHtml(opts.project)}" />
  <datalist id="project-options">${projectOptions}</datalist>
  <input type="text" name="since" placeholder="since: 7d, 24h, or ISO" value="${escapeHtml(opts.since)}" />
  <select name="role">${roleOptions}</select>
  <label><input type="checkbox" name="sidechains" value="1" ${opts.sidechains ? "checked" : ""} /> include subagent traffic</label>
  <button type="submit">Search</button>
</form>`;
}

function renderHero(opts: SearchPageOptions): string {
  const filters = renderFilters(opts, "hero");
  const chips = EXAMPLE_QUERIES.map(
    (q) => `<a class="chip" href="/?q=${encodeURIComponent(q)}">${escapeHtml(q)}</a>`
  ).join("");

  return `
<section class="hero">
  <p class="hero-tagline">Search everything your AI agents have ever done &mdash; every session, every project.</p>
  ${filters}
  <div class="example-chips">${chips}</div>
</section>`;
}

function renderHitCard(hit: SearchPageHit, index: number): string {
  const heading = escapeHtml(hit.title ?? hit.sessionId);
  const sidechainBadge = hit.isSidechain ? `<span class="badge accent">subagent</span>` : "";
  const resumeCmd = `claude --resume ${hit.sessionId}`;
  const resumeId = `resume-hit-${index}`;

  return `
<article class="card hit-card">
  <div class="hit-meta muted">
    <span class="badge">${escapeHtml(hit.projectDir)}</span>
    <span>${escapeHtml(hit.ts)}</span>
    <span class="badge">${escapeHtml(hit.role)}</span>
    ${sidechainBadge}
  </div>
  <h3 class="hit-title"><a class="tap-target" href="/session/${encodeURIComponent(hit.sessionId)}">${heading}</a></h3>
  <p class="snippet">${highlightSnippetHtml(hit.snippet)}</p>
  <div class="hit-footer">
    <span class="cost muted" title="Estimated cost at API list prices">$${hit.estCostUsd.toFixed(4)}</span>
    <code id="${resumeId}">${escapeHtml(resumeCmd)}</code>
    <button type="button" class="copy-btn" data-copy-target="${resumeId}">Copy</button>
  </div>
</article>`;
}

function renderPagination(opts: SearchPageOptions): string {
  const prev =
    opts.page > 1
      ? `<a rel="prev" href="/${pageQueryString(opts, opts.page - 1)}">&larr; Previous</a>`
      : "";
  const next = opts.hasMore
    ? `<a rel="next" href="/${pageQueryString(opts, opts.page + 1)}">Next &rarr;</a>`
    : "";
  if (!prev && !next) return "";
  return `<nav class="pagination">${prev} ${next}</nav>`;
}

export function renderSearchPage(opts: SearchPageOptions): string {
  if (!opts.q) {
    return renderHero(opts);
  }

  const filters = renderFilters(opts, "compact");

  if (opts.hits.length === 0) {
    return `${filters}<p class="muted">No results for "${escapeHtml(opts.q)}".</p>`;
  }

  const cards = opts.hits.map(renderHitCard).join("");
  return `${filters}${cards}${renderPagination(opts)}`;
}
