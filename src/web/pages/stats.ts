import { escapeHtml } from "../html.js";

export interface StatsPageProjectRow {
  projectDir: string;
  sessions: number;
  messages: number;
  estCostUsd: number;
}

export interface DailyCount {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface StatsPageOptions {
  totalSessions: number;
  totalMessages: number;
  totalCostUsd: number;
  byProject: StatsPageProjectRow[];
  dailyCounts: DailyCount[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function fillDailySeries(counts: DailyCount[], days: number, now: Date): DailyCount[] {
  const byDate = new Map(counts.map((c) => [c.date, c.count]));
  const series: DailyCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * MS_PER_DAY);
    const date = toDateKey(d);
    series.push({ date, count: byDate.get(date) ?? 0 });
  }
  return series;
}

function renderSparklineSvg(series: DailyCount[]): string {
  const width = 300;
  const height = 60;
  const max = Math.max(1, ...series.map((d) => d.count));
  const n = Math.max(1, series.length);
  const barWidth = width / n;

  const bars = series
    .map((d, i) => {
      const barHeight = (d.count / max) * (height - 4);
      const x = i * barWidth;
      const y = height - barHeight;
      return `<rect class="bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(barWidth - 1).toFixed(2)}" height="${barHeight.toFixed(2)}"><title>${escapeHtml(d.date)}: ${d.count}</title></rect>`;
    })
    .join("");

  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="messages per day, last ${series.length} days">${bars}</svg>`;
}

function renderProjectTable(rows: StatsPageProjectRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.projectDir)}</td><td class="tabular">${r.sessions}</td><td class="tabular">${r.messages}</td><td class="cost">$${r.estCostUsd.toFixed(4)}</td></tr>`
    )
    .join("");
  return `<table><thead><tr><th>Project</th><th>Sessions</th><th>Messages</th><th>Est. cost</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderStatCards(opts: StatsPageOptions): string {
  const cards: Array<{ value: string; label: string }> = [
    { value: String(opts.totalSessions), label: "Sessions" },
    { value: String(opts.totalMessages), label: "Messages" },
    { value: `$${opts.totalCostUsd.toFixed(4)}`, label: "Estimated cost" },
  ];
  return `<div class="stat-cards">${cards
    .map(
      (c) =>
        `<div class="card stat-card"><div class="stat-number">${c.value}</div><div class="stat-label">${c.label}</div></div>`
    )
    .join("")}</div>`;
}

export function renderStatsPage(opts: StatsPageOptions): string {
  const summary = renderStatCards(opts);
  const sparkline = `<h2>Messages / day (last ${opts.dailyCounts.length || 30} days)</h2>${renderSparklineSvg(opts.dailyCounts)}`;

  return `${summary}<h2>By project (${opts.byProject.length})</h2>${renderProjectTable(opts.byProject)}${sparkline}`;
}
