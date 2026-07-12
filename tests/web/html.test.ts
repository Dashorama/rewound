import { describe, it, expect } from "vitest";
import { escapeHtml, highlightSnippetHtml } from "../../src/web/html.js";

describe("escapeHtml", () => {
  it("escapes angle brackets to prevent tag injection", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("escapes double and single quotes so text is safe inside attributes", () => {
    expect(escapeHtml(`He said "hi" & 'bye'`)).toBe("He said &quot;hi&quot; &amp; &#39;bye&#39;");
  });

  it("passes plain text through unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("highlightSnippetHtml", () => {
  it("converts FTS5 marker bytes into <mark> tags", () => {
    expect(highlightSnippetHtml("hello \x01world\x02 done")).toBe("hello <mark>world</mark> done");
  });

  it("escapes HTML in the surrounding snippet text (XSS safety)", () => {
    const out = highlightSnippetHtml("<script>alert(1)</script> \x01hit\x02");
    expect(out).not.toContain("<script>");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt; <mark>hit</mark>");
  });
});
