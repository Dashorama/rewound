import { describe, it, expect } from "vitest";
import { fillDailySeries, renderStatsPage } from "../../../src/web/pages/stats.js";

describe("fillDailySeries", () => {
  it("zero-fills every day in the window, ordered ascending, ending on `now`", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const series = fillDailySeries([{ date: "2026-07-10", count: 5 }], 3, now);
    expect(series).toEqual([
      { date: "2026-07-09", count: 0 },
      { date: "2026-07-10", count: 5 },
      { date: "2026-07-11", count: 0 },
    ]);
  });

  it("ignores counts for dates outside the window", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const series = fillDailySeries([{ date: "2020-01-01", count: 99 }], 3, now);
    expect(series.reduce((sum, d) => sum + d.count, 0)).toBe(0);
  });
});

describe("renderStatsPage", () => {
  const baseOpts = {
    totalSessions: 10,
    totalMessages: 500,
    totalCostUsd: 12.3456,
    byProject: [
      { projectDir: "/home/dev/myapp", sessions: 6, messages: 300, estCostUsd: 8.0 },
      { projectDir: "/home/dev/rewound", sessions: 4, messages: 200, estCostUsd: 4.3456 },
    ],
    dailyCounts: [
      { date: "2026-07-10", count: 5 },
      { date: "2026-07-11", count: 12 },
    ],
  };

  it("renders totals", () => {
    const html = renderStatsPage(baseOpts);
    expect(html).toContain("10");
    expect(html).toContain("500");
    expect(html).toContain("$12.3456");
  });

  it("renders totals as stat cards with a big tabular number and a label", () => {
    const html = renderStatsPage(baseOpts);
    expect(html.match(/class="card stat-card"/g)?.length).toBe(3);
    expect(html).toMatch(/<div class="stat-number">10<\/div>\s*<div class="stat-label">Sessions<\/div>/);
  });

  it("renders a table row per project with sessions, messages and cost", () => {
    const html = renderStatsPage(baseOpts);
    expect(html).toContain("/home/dev/myapp");
    expect(html).toContain("/home/dev/rewound");
    expect(html).toContain("$8.0000");
  });

  it("labels cost figures as estimated API cost with a list-price footnote (not real spend)", () => {
    const html = renderStatsPage(baseOpts);
    // Heavy subscription users see totals like $74K here — the math is API list price,
    // and the label must say so or the number reads as a bug.
    expect(html).toContain("Est. API cost");
    expect(html).toMatch(/API list price/i);
  });

  it("reflects the actual number of project rows in the heading, not a hardcoded count", () => {
    const html = renderStatsPage(baseOpts);
    expect(html).toMatch(/By project \(2\)/);
  });

  it("escapes a malicious project directory name (XSS safety)", () => {
    const html = renderStatsPage({
      ...baseOpts,
      byProject: [{ projectDir: "<script>alert(1)</script>", sessions: 1, messages: 1, estCostUsd: 0 }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders an inline SVG sparkline with no external chart library", () => {
    const html = renderStatsPage(baseOpts);
    expect(html).toMatch(/<svg[^>]*>/);
    expect(html).not.toContain("<script src=");
  });

  it("renders a valid sparkline even when there is no data at all", () => {
    const html = renderStatsPage({ ...baseOpts, dailyCounts: [] });
    expect(html).toMatch(/<svg[^>]*>/);
    expect(html).not.toMatch(/NaN/);
  });

  it("styles the sparkline bars via a CSS class instead of a hardcoded hex fill, so it themes for dark mode", () => {
    const html = renderStatsPage(baseOpts);
    expect(html).not.toMatch(/fill="#[0-9a-f]{3,6}"/i);
    expect(html).toContain('class="bar"');
  });
});
