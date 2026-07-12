import { describe, it, expect } from "vitest";
import { renderTimelinePage } from "../../../src/web/pages/timeline.js";

describe("renderTimelinePage", () => {
  it("lists project links when no project is selected", () => {
    const html = renderTimelinePage({
      projects: ["/home/dev/myapp", "/home/dev/rewound"],
      selectedProject: undefined,
      sessions: [],
    });
    expect(html).toContain('href="/timeline?project=%2Fhome%2Fdev%2Fmyapp"');
    expect(html).toContain("/home/dev/myapp");
  });

  it("escapes a malicious project name in the project list (XSS safety)", () => {
    const html = renderTimelinePage({
      projects: ["<script>alert(1)</script>"],
      selectedProject: undefined,
      sessions: [],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("shows a message when the selected project has no sessions", () => {
    const html = renderTimelinePage({
      projects: ["/home/dev/myapp"],
      selectedProject: "/home/dev/myapp",
      sessions: [],
    });
    expect(html).toMatch(/no sessions/i);
  });

  it("groups sessions by day with one heading per date", () => {
    const html = renderTimelinePage({
      projects: ["/home/dev/myapp"],
      selectedProject: "/home/dev/myapp",
      sessions: [
        { id: "sess-1", title: "First", startedAt: "2026-07-01T10:00:00.000Z", estCostUsd: 0.1, messageCount: 3 },
        { id: "sess-2", title: "Second", startedAt: "2026-07-01T14:00:00.000Z", estCostUsd: 0.2, messageCount: 5 },
        { id: "sess-3", title: "Third", startedAt: "2026-06-30T09:00:00.000Z", estCostUsd: 0.3, messageCount: 1 },
      ],
    });
    expect(html.match(/<h2 class="day-header">2026-07-01<\/h2>/g)?.length).toBe(1);
    expect(html.match(/<h2 class="day-header">2026-06-30<\/h2>/g)?.length).toBe(1);
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html).toContain("Third");
  });

  it("renders compact session cards showing message count and cost", () => {
    const html = renderTimelinePage({
      projects: ["/home/dev/myapp"],
      selectedProject: "/home/dev/myapp",
      sessions: [
        { id: "sess-1", title: "First", startedAt: "2026-07-01T10:00:00.000Z", estCostUsd: 0.1, messageCount: 3 },
      ],
    });
    expect(html).toContain('class="card session-row"');
    expect(html).toMatch(/3\s*msgs?/i);
    expect(html).toContain("$0.1000");
  });

  it("annotates the compact cost figure as API list price via tooltip", () => {
    const html = renderTimelinePage({
      projects: ["/home/dev/myapp"],
      selectedProject: "/home/dev/myapp",
      sessions: [
        { id: "sess-1", title: "First", startedAt: "2026-07-01T10:00:00.000Z", estCostUsd: 0.1, messageCount: 3 },
      ],
    });
    expect(html).toMatch(/<span class="cost"[^>]*title="[^"]*API list price[^"]*"/i);
  });

  it("links each session to its detail page", () => {
    const html = renderTimelinePage({
      projects: ["/home/dev/myapp"],
      selectedProject: "/home/dev/myapp",
      sessions: [
        { id: "sess-1", title: "First", startedAt: "2026-07-01T10:00:00.000Z", estCostUsd: 0.1, messageCount: 3 },
      ],
    });
    expect(html).toContain('href="/session/sess-1"');
  });

  it("escapes a malicious session title (XSS safety)", () => {
    const html = renderTimelinePage({
      projects: ["/home/dev/myapp"],
      selectedProject: "/home/dev/myapp",
      sessions: [
        {
          id: "sess-1",
          title: "<script>alert(1)</script>",
          startedAt: "2026-07-01T10:00:00.000Z",
          estCostUsd: 0,
          messageCount: 1,
        },
      ],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
