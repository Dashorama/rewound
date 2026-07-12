import { describe, it, expect } from "vitest";
import { renderSearchPage } from "../../../src/web/pages/search.js";

function baseOpts(overrides: Partial<Parameters<typeof renderSearchPage>[0]> = {}) {
  return {
    q: "",
    project: "",
    since: "",
    role: "",
    sidechains: false,
    hits: [],
    projects: ["/home/dev/agentgrep", "/home/dev/myapp"],
    page: 1,
    hasMore: false,
    ...overrides,
  };
}

const sampleHit = {
  sessionId: "sess-1",
  uuid: "u1",
  role: "user",
  ts: "2026-07-01T10:00:00.000Z",
  projectDir: "/home/dev/myapp",
  title: "Fix auth bug",
  snippet: "hit",
  isSidechain: false,
  estCostUsd: 0.01,
};

describe("renderSearchPage", () => {
  it("reflects the current query back into the search input value", () => {
    const html = renderSearchPage(baseOpts({ q: "fts5 trigger" }));
    expect(html).toContain('value="fts5 trigger"');
  });

  it("escapes an injected query so it cannot break out of the input attribute", () => {
    const html = renderSearchPage(baseOpts({ q: '"><script>alert(1)</script>' }));
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("shows a prominent hero prompt (not just a bare instruction) when no query has been entered", () => {
    const html = renderSearchPage(baseOpts());
    expect(html).toMatch(/search (your|everything).*agent/i);
    expect(html).toContain('class="hero"');
  });

  it("offers clickable example-query chips in the empty state", () => {
    const html = renderSearchPage(baseOpts());
    const chipLinks = html.match(/<a class="chip" href="\/\?q=[^"]+">[^<]+<\/a>/g) ?? [];
    expect(chipLinks.length).toBeGreaterThan(0);
  });

  it("autofocuses the query input on the empty-state hero", () => {
    const html = renderSearchPage(baseOpts());
    expect(html).toMatch(/<input[^>]*name="q"[^>]*autofocus/);
  });

  it("does not autofocus the query input on the results page (would steal focus from results on every load)", () => {
    const html = renderSearchPage(baseOpts({ q: "auth bug", hits: [sampleHit] }));
    expect(html).not.toMatch(/<input[^>]*name="q"[^>]*autofocus/);
  });

  it("shows a no-results message for a query with zero hits", () => {
    const html = renderSearchPage(baseOpts({ q: "nothing matches this" }));
    expect(html).toMatch(/no results/i);
  });

  it("renders one card per hit with project, title, snippet and cost", () => {
    const html = renderSearchPage(
      baseOpts({
        q: "auth bug",
        hits: [
          {
            sessionId: "sess-1",
            uuid: "u1",
            role: "user",
            ts: "2026-07-01T10:00:00.000Z",
            projectDir: "/home/dev/myapp",
            title: "Fix auth bug",
            snippet: "please fix the \x01auth\x02 bug",
            isSidechain: false,
            estCostUsd: 0.1234,
          },
        ],
      })
    );
    expect(html).toContain("/home/dev/myapp");
    expect(html).toContain("Fix auth bug");
    expect(html).toContain("<mark>auth</mark>");
    expect(html).toContain("$0.1234");
    expect(html).toContain('href="/session/sess-1"');
  });

  it("annotates each hit's cost figure as API list price via tooltip", () => {
    const html = renderSearchPage(baseOpts({ q: "auth bug", hits: [sampleHit] }));
    expect(html).toMatch(/<span class="cost[^"]*"[^>]*title="[^"]*API list price[^"]*"/i);
  });

  it("shows the message role in each result card's metadata row", () => {
    const html = renderSearchPage(
      baseOpts({ q: "auth bug", hits: [{ ...sampleHit, role: "assistant" }] })
    );
    expect(html).toMatch(/assistant/);
  });

  it("gives each result card a monospace resume command and a wired-up copy button", () => {
    const html = renderSearchPage(baseOpts({ q: "auth bug", hits: [sampleHit] }));
    expect(html).toMatch(/<code[^>]*id="([^"]+)"[^>]*>claude --resume sess-1<\/code>/);
    const codeId = html.match(/<code[^>]*id="([^"]+)"[^>]*>claude --resume sess-1<\/code>/)![1];
    expect(html).toContain(`class="copy-btn" data-copy-target="${codeId}"`);
  });

  it("escapes a malicious session title in a result card (XSS safety)", () => {
    const html = renderSearchPage(
      baseOpts({
        q: "x",
        hits: [
          {
            sessionId: "sess-1",
            uuid: "u1",
            role: "user",
            ts: "2026-07-01T10:00:00.000Z",
            projectDir: "/home/dev/myapp",
            title: "<script>alert(1)</script>",
            snippet: "hit",
            isSidechain: false,
            estCostUsd: 0,
          },
        ],
      })
    );
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes a malicious session id in the resume command (XSS safety)", () => {
    const html = renderSearchPage(
      baseOpts({
        q: "x",
        hits: [{ ...sampleHit, sessionId: '"><script>alert(1)</script>' }],
      })
    );
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("offers known projects as datalist suggestions and pre-fills the current filter value", () => {
    const html = renderSearchPage(baseOpts({ project: "/home/dev/myapp" }));
    expect(html).toContain('value="/home/dev/myapp"');
    expect(html).toContain('list="project-options"');
    expect(html).toContain('<option value="/home/dev/myapp">');
    expect(html).toContain('<option value="/home/dev/agentgrep">');
  });

  it("escapes a malicious project name in the datalist (XSS safety)", () => {
    const html = renderSearchPage(baseOpts({ projects: ["<script>alert(1)</script>"] }));
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("does not render a previous-page link on page 1", () => {
    const html = renderSearchPage(baseOpts({ q: "x", hits: [sampleHit], page: 1, hasMore: true }));
    expect(html).not.toMatch(/rel="prev"/);
  });

  it("renders a next-page link when hasMore is true", () => {
    const html = renderSearchPage(baseOpts({ q: "x", hits: [sampleHit], page: 1, hasMore: true }));
    expect(html).toMatch(/page=2/);
  });

  it("does not render a next-page link when hasMore is false", () => {
    const html = renderSearchPage(baseOpts({ q: "x", hits: [sampleHit], page: 1, hasMore: false }));
    expect(html).not.toMatch(/page=2/);
  });

  it("HTML-escapes the ampersand joining multiple query params in pagination links", () => {
    const html = renderSearchPage(
      baseOpts({ q: "x", project: "/home/dev/myapp", hits: [sampleHit], page: 1, hasMore: true })
    );
    const link = html.match(/<a rel="next"[^>]*>/)?.[0] ?? "";
    expect(link).toContain("&amp;");
    expect(link).not.toMatch(/href="[^"]*[^&]&[^a][^"]*"/);
  });
});
