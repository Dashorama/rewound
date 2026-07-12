import { describe, it, expect } from "vitest";
import { renderLayout } from "../../src/web/layout.js";

describe("renderLayout", () => {
  it("includes the page title in <title>", () => {
    const html = renderLayout({ title: "Search", activeNav: "search", body: "<p>hi</p>" });
    expect(html).toContain("<title>Search · rewound</title>");
  });

  it("escapes the title to prevent injection via session titles", () => {
    const html = renderLayout({ title: "<script>x</script>", activeNav: "search", body: "" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("embeds the body markup as-is (caller is responsible for escaping)", () => {
    const html = renderLayout({
      title: "Search",
      activeNav: "search",
      body: "<p id=\"marker\">body content</p>",
    });
    expect(html).toContain('<p id="marker">body content</p>');
  });

  it("marks the active nav item for assistive tech and styling", () => {
    const html = renderLayout({ title: "Stats", activeNav: "stats", body: "" });
    const statsLinkMatch = html.match(/<a[^>]*href="\/stats"[^>]*>/);
    expect(statsLinkMatch).toBeTruthy();
    expect(statsLinkMatch![0]).toMatch(/aria-current="page"/);
  });

  it("does not mark inactive nav items as current", () => {
    const html = renderLayout({ title: "Stats", activeNav: "stats", body: "" });
    const searchLinkMatch = html.match(/<a[^>]*href="\/"[^>]*>/);
    expect(searchLinkMatch).toBeTruthy();
    expect(searchLinkMatch![0]).not.toMatch(/aria-current/);
  });

  it("includes a responsive viewport meta tag", () => {
    const html = renderLayout({ title: "Search", body: "" });
    expect(html).toContain('name="viewport"');
  });

  it("never pairs red and green for status (colorblind-safe palette)", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).toBeTruthy();
    const css = styleMatch![1].toLowerCase();
    expect(css).not.toMatch(/\bred\b/);
    expect(css).not.toMatch(/\bgreen\b/);
  });

  it("supports dark mode via prefers-color-scheme, defaulting to light", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).toBeTruthy();
    const css = styleMatch![1];
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(css).toMatch(/color-scheme:\s*light/);
  });

  it("renders a distinctive wordmark with 'grep' set apart from 'agent'", () => {
    const html = renderLayout({ title: "Search", body: "" });
    expect(html).toMatch(/<span class="brand">re<span class="brand-accent">wound<\/span><\/span>/);
  });

  it("ships a self-contained inline SVG favicon with no external request", () => {
    const html = renderLayout({ title: "Search", body: "" });
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
  });

  it("defines a monospace font stack for code and session ids", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch![1]).toMatch(/ui-monospace/);
  });

  it("uses tabular figures for numeric columns like costs and counts", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch![1]).toMatch(/tabular-nums/);
  });

  it("gives cards a hover elevation treatment", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch![1]).toMatch(/\.card:hover\s*\{[^}]*box-shadow/);
  });

  it("provides copy-with-feedback behavior that changes the button label, not just color", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).toBeTruthy();
    const js = scriptMatch![1];
    expect(js).toMatch(/Copied/);
    expect(js).toMatch(/setTimeout/);
  });

  it("delegates copy-button clicks via data-copy-target so multiple copy buttons work per page", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch![1]).toMatch(/data-copy-target/);
  });

  it("keeps the copy button at a 44px touch target (regression: live-browser check found it at 36px)", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    const copyBtnRules = [...styleMatch![1].matchAll(/\.copy-btn\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(copyBtnRules.some((rule) => /min-height:\s*44px/.test(rule))).toBe(true);
  });

  it("gives card/row title links a real 44px tap target via .tap-target, not just their text line height", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch![1]).toMatch(/\.tap-target\s*\{[^}]*min-height:\s*44px/);
  });

  it("lets long unbroken strings in headings (e.g. a project path in an <h1>) wrap instead of forcing horizontal scroll", () => {
    const html = renderLayout({ title: "Search", body: "" });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    const h1Rule = styleMatch![1].match(/([^{}]*\bh1\b[^{}]*)\{([^}]*)\}/);
    expect(h1Rule).toBeTruthy();
    expect(h1Rule![2]).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
