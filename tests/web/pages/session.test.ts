import { describe, it, expect } from "vitest";
import { renderSessionPage } from "../../../src/web/pages/session.js";

function baseSession(overrides: Partial<Parameters<typeof renderSessionPage>[0]> = {}) {
  return {
    id: "sess-1",
    projectDir: "/home/dev/myapp",
    gitBranch: "main",
    title: "Fix auth bug",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    messageCount: 2,
    models: ["claude-sonnet-4-5"],
    estCostUsd: 0.05,
    archived: false,
    ...overrides,
  };
}

const plainMessage = {
  uuid: "u1",
  role: "user",
  ts: "2026-07-01T10:00:00.000Z",
  text: "Please fix the auth bug",
  tools: [],
  isSidechain: false,
};

describe("renderSessionPage", () => {
  it("renders the session title, project dir, branch and cost in the header", () => {
    const html = renderSessionPage(baseSession(), [plainMessage]);
    expect(html).toContain("Fix auth bug");
    expect(html).toContain("/home/dev/myapp");
    expect(html).toContain("main");
    expect(html).toContain("$0.0500");
  });

  it("labels the header cost as estimated API cost, not real spend", () => {
    const html = renderSessionPage(baseSession(), [plainMessage]);
    expect(html).toMatch(/est\. API \$0\.0500/);
  });

  it("escapes a malicious session title (XSS safety)", () => {
    const html = renderSessionPage(baseSession({ title: "<script>alert(1)</script>" }), [plainMessage]);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes malicious message text (XSS safety)", () => {
    const html = renderSessionPage(baseSession(), [
      { ...plainMessage, text: "<script>alert(1)</script>" },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a plain message without a details wrapper when it has no tool calls", () => {
    const html = renderSessionPage(baseSession(), [plainMessage]);
    expect(html).not.toContain("<details");
  });

  it("collapses a message with tool calls behind a details element", () => {
    const html = renderSessionPage(baseSession(), [
      { ...plainMessage, uuid: "a1", role: "assistant", tools: ["Read", "Bash"] },
    ]);
    expect(html).toContain("<details");
    expect(html).toContain("Read");
    expect(html).toContain("Bash");
  });

  it("renders each tool call as its own styled chip, not a comma-joined string", () => {
    const html = renderSessionPage(baseSession(), [
      { ...plainMessage, uuid: "a1", role: "assistant", tools: ["Read", "Bash"] },
    ]);
    expect(html).toContain('<span class="badge tool-chip">Read</span>');
    expect(html).toContain('<span class="badge tool-chip">Bash</span>');
  });

  it("distinguishes user and assistant messages with a role class, never color alone", () => {
    const html = renderSessionPage(baseSession(), [
      plainMessage,
      { ...plainMessage, uuid: "a1", role: "assistant", text: "found it" },
    ]);
    expect(html).toMatch(/class="card message message-user"/);
    expect(html).toMatch(/class="card message message-assistant"/);
  });

  it("wires the header's copy-resume button to the delegated copy handler", () => {
    const html = renderSessionPage(baseSession(), [plainMessage]);
    expect(html).toContain('<code id="resume-cmd"');
    expect(html).toContain('class="copy-btn" data-copy-target="resume-cmd"');
  });

  it("marks sidechain messages with a badge", () => {
    const html = renderSessionPage(baseSession(), [{ ...plainMessage, isSidechain: true }]);
    expect(html).toMatch(/subagent/i);
  });

  it("includes a resume command referencing the session id", () => {
    const html = renderSessionPage(baseSession(), [plainMessage]);
    expect(html).toContain("claude --resume sess-1");
  });

  it("shows an archived badge when the session is archived", () => {
    const html = renderSessionPage(baseSession({ archived: true }), [plainMessage]);
    expect(html).toMatch(/archived/i);
  });

  it("renders no pagination controls for a single-page transcript", () => {
    const html = renderSessionPage(baseSession(), [plainMessage], { page: 1, totalPages: 1 });
    expect(html).not.toMatch(/rel="prev"/);
    expect(html).not.toMatch(/rel="next"/);
  });

  it("shows a next link but no prev link on the first of several pages", () => {
    const html = renderSessionPage(baseSession(), [plainMessage], { page: 1, totalPages: 3 });
    expect(html).not.toMatch(/rel="prev"/);
    expect(html).toMatch(/rel="next"/);
    expect(html).toContain("page=2");
  });

  it("shows both prev and next links on a middle page", () => {
    const html = renderSessionPage(baseSession(), [plainMessage], { page: 2, totalPages: 3 });
    expect(html).toMatch(/rel="prev"/);
    expect(html).toMatch(/rel="next"/);
    expect(html).toContain("page=1");
    expect(html).toContain("page=3");
  });

  it("shows a prev link but no next link on the last page", () => {
    const html = renderSessionPage(baseSession(), [plainMessage], { page: 3, totalPages: 3 });
    expect(html).toMatch(/rel="prev"/);
    expect(html).not.toMatch(/rel="next"/);
  });

  it("displays the current page and total page count", () => {
    const html = renderSessionPage(baseSession(), [plainMessage], { page: 2, totalPages: 5 });
    expect(html).toMatch(/page 2 of 5/i);
  });
});

describe("source-aware resume", () => {
  it("renders the codex resume command for codex sessions", () => {
    const html = renderSessionPage(baseSession({ source: "codex" } as any), [plainMessage]);
    expect(html).toContain("codex resume sess-1");
    expect(html).not.toContain("claude --resume sess-1");
  });
});
