import { escapeHtml } from "./html.js";

export type NavKey = "search" | "timeline" | "stats";

export interface LayoutOptions {
  title: string;
  activeNav?: NavKey;
  body: string;
}

const NAV_ITEMS: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "search", href: "/", label: "Search" },
  { key: "timeline", href: "/timeline", label: "Timeline" },
  { key: "stats", href: "/stats", label: "Stats" },
];

// Small magnifying-glass mark in the brand blue/orange, inlined as a data URI
// so the favicon never triggers an external request (README promises zero
// network calls, and the phone workflow is often offline/Tailscale-only).
const FAVICON_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='13' cy='13' r='9' fill='none' stroke='#2563eb' stroke-width='4'/><line x1='20' y1='20' x2='28' y2='28' stroke='#ea580c' stroke-width='4' stroke-linecap='round'/></svg>`;
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

// Colorblind-safe palette: blue (primary) / orange (accent) only.
// Never use red/green to convey status — pair icons or labels with color instead.
// navigator.clipboard requires a secure context (HTTPS or localhost). The
// primary phone workflow is plain HTTP over Tailscale, so fall back to a
// hidden-textarea + execCommand copy when the Clipboard API is unavailable.
// Copy buttons use a delegated click listener + data-copy-target (rather than
// per-button onclick handlers) so an arbitrary number of copy buttons can
// appear on one page (e.g. one per search result) without inline JS that
// would need to interpolate untrusted ids into a JS string literal.
const COPY_SCRIPT = `
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
    return;
  }
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}
document.addEventListener("click", function (e) {
  var btn = e.target.closest && e.target.closest(".copy-btn");
  if (!btn) return;
  var targetId = btn.getAttribute("data-copy-target");
  var el = targetId && document.getElementById(targetId);
  if (!el) return;
  copyText(el.textContent);
  var original = btn.textContent;
  btn.textContent = "Copied ✓";
  btn.disabled = true;
  setTimeout(function () {
    btn.textContent = original;
    btn.disabled = false;
  }, 1500);
});
`;

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a2e;
    --muted: #5b6472;
    --border: #e2e5ea;
    --primary: #2563eb;
    --primary-fg: #ffffff;
    --accent: #ea580c;
    --surface: #f6f7f9;
    --shadow: 0 4px 16px rgba(26, 26, 46, 0.08);
    --mark-bg: rgba(234, 88, 12, 0.22);

    --space-1: 0.25rem;
    --space-2: 0.5rem;
    --space-3: 0.75rem;
    --space-4: 1rem;
    --space-6: 1.5rem;
    --space-8: 2rem;

    --radius-sm: 0.5rem;
    --radius: 0.75rem;

    --fs-xs: 0.75rem;
    --fs-sm: 0.875rem;
    --fs-base: 1rem;
    --fs-lg: 1.125rem;
    --fs-xl: 1.375rem;
    --fs-2xl: 2rem;

    --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101218;
      --fg: #e7e9ee;
      --muted: #9aa3b2;
      --border: #2a2e38;
      --primary: #5b9bf7;
      --primary-fg: #0b1220;
      --accent: #ff9d52;
      --surface: #171a22;
      --shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      --mark-bg: rgba(255, 157, 82, 0.3);
    }
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--fs-base);
    color: var(--fg);
    background: var(--bg);
    line-height: 1.5;
  }
  a { color: var(--primary); }
  code, pre { font-family: var(--font-mono); }
  .cost, .count, .tabular, .stat-number { font-variant-numeric: tabular-nums; }

  header.site {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }
  header.site .brand {
    font-weight: 700;
    font-size: var(--fs-lg);
    margin-right: auto;
    letter-spacing: -0.02em;
  }
  .brand-accent { color: var(--accent); font-weight: 800; }
  nav.site-nav { display: flex; gap: var(--space-1); }
  nav.site-nav a {
    padding: 0.5rem var(--space-3);
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
    text-decoration: none;
    color: var(--muted);
    font-weight: 600;
    font-size: var(--fs-sm);
  }
  nav.site-nav a[aria-current="page"] {
    background: var(--primary);
    color: var(--primary-fg);
  }

  main { max-width: 960px; margin: 0 auto; padding: var(--space-4); }

  /* Filesystem paths, session ids, and cost/count text can be long unbroken
     strings with no natural break point — without this, a long project dir
     in an h1 or table cell forces horizontal scroll on narrow viewports. */
  h1, h2, h3, .muted, td, th, code { overflow-wrap: anywhere; }

  h1 { font-size: var(--fs-2xl); margin: 0 0 var(--space-2); }
  h2 { font-size: var(--fs-xl); margin: var(--space-6) 0 var(--space-3); }
  h3 { font-size: var(--fs-lg); margin: 0 0 var(--space-1); }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-3);
    background: var(--surface);
    transition: box-shadow 0.15s ease, transform 0.15s ease;
  }
  .card:hover {
    box-shadow: var(--shadow);
    transform: translateY(-1px);
  }

  .muted { color: var(--muted); font-size: var(--fs-sm); }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: var(--fs-xs);
    font-weight: 600;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .badge.accent { border-color: var(--accent); color: var(--accent); }
  .tool-chip { font-family: var(--font-mono); }
  .role-label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }

  .message { border-left: 4px solid var(--border); }
  .message-user { border-left-color: var(--primary); }
  .message-assistant { border-left-color: var(--accent); }

  .session-header .resume-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }

  .day-header {
    font-size: var(--fs-sm);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--space-2);
  }
  .session-row { padding: var(--space-2) var(--space-4); }
  .session-row-title { font-weight: 600; margin-bottom: var(--space-1); }
  .session-row-title a { text-decoration: none; }
  .session-row-title a:hover { text-decoration: underline; }

  .project-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .project-link { display: block; text-decoration: none; color: var(--fg); font-weight: 600; }
  .project-link:hover { border-color: var(--primary); color: var(--primary); }

  .stat-cards { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-4); }
  .stat-card { flex: 1 1 10rem; text-align: center; }
  .stat-number { font-size: var(--fs-2xl); font-weight: 700; }
  .stat-label { color: var(--muted); font-size: var(--fs-sm); }
  .sparkline .bar { fill: var(--primary); }

  .error-page { text-align: center; padding: var(--space-8) var(--space-4); }
  .error-code { font-size: var(--fs-2xl); font-weight: 800; color: var(--muted); }

  mark {
    background: var(--mark-bg);
    color: inherit;
    border-radius: 0.2rem;
    padding: 0 0.15rem;
  }

  .hero { text-align: center; padding: var(--space-8) var(--space-4) var(--space-6); }
  .hero-tagline { font-size: var(--fs-lg); color: var(--muted); margin: 0 0 var(--space-6); }
  form.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4); }
  form.filters-hero { justify-content: center; }
  form.filters-hero input[name="q"] {
    font-size: var(--fs-lg);
    text-align: center;
    flex: 1 1 100%;
    max-width: 32rem;
  }
  .example-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: center;
    margin-top: var(--space-4);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--space-4);
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
    text-decoration: none;
    font-size: var(--fs-sm);
  }
  .chip:hover { border-color: var(--primary); color: var(--primary); }

  .hit-meta { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); }
  .hit-title { margin: 0 0 var(--space-2); }
  .hit-title a { text-decoration: none; }
  .hit-title a:hover { text-decoration: underline; }
  .snippet { margin: 0 0 var(--space-3); }
  .hit-footer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .hit-footer code { flex: 1 1 auto; }

  input, select, button {
    font: inherit;
    padding: 0.6rem var(--space-3);
    min-height: 44px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
  }
  button, .copy-btn {
    background: var(--primary);
    color: var(--primary-fg);
    border-color: var(--primary);
    cursor: pointer;
    font-weight: 600;
  }
  .copy-btn { padding: 0.4rem var(--space-3); min-height: 44px; font-size: var(--fs-xs); }
  .copy-btn:disabled { opacity: 0.8; cursor: default; }

  /* Text links that act as a card/row's primary tap target (not inline prose)
     need a real 44px hit box even though the text itself renders smaller. */
  .tap-target { display: inline-flex; align-items: center; min-height: 44px; }

  pre { white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); }

  nav.pagination {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-3) 0;
    font-size: var(--fs-sm);
  }
  nav.pagination a {
    padding: 0.5rem var(--space-3);
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-decoration: none;
    font-weight: 600;
  }

  @media (max-width: 600px) {
    main { padding: var(--space-3); }
    form.filters { flex-direction: column; }
    table, thead, tbody, th, td, tr { display: block; }
    thead { display: none; }
    td { border: none; padding: 0.15rem 0; }
    tr { border-bottom: 1px solid var(--border); padding-bottom: var(--space-2); margin-bottom: var(--space-2); }
  }
`;

export function renderLayout(opts: LayoutOptions): string {
  const navHtml = NAV_ITEMS.map((item) => {
    const current = item.key === opts.activeNav ? ' aria-current="page"' : "";
    return `<a href="${item.href}"${current}>${escapeHtml(item.label)}</a>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)} · agentgrep</title>
<link rel="icon" href="${FAVICON_HREF}" />
<style>${STYLES}</style>
<script>${COPY_SCRIPT}</script>
</head>
<body>
<header class="site">
  <span class="brand">agent<span class="brand-accent">grep</span></span>
  <nav class="site-nav">${navHtml}</nav>
</header>
<main>${opts.body}</main>
</body>
</html>`;
}
