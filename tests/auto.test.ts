import { describe, it, expect } from "vitest";
import { buildAutoLine, upsertAutoLines, removeAutoLines, listAutoLines, AUTO_MARKER } from "../src/auto.js";

describe("rewound auto crontab logic", () => {
  it("builds an index+sync line when a sync dir is configured, index-only otherwise", () => {
    expect(buildAutoLine("@hourly", true)).toBe(`@hourly rewound index && rewound sync ${AUTO_MARKER}`);
    expect(buildAutoLine("@hourly", false)).toBe(`@hourly rewound index ${AUTO_MARKER}`);
  });

  it("upserts idempotently — never a second marker line", () => {
    const line = buildAutoLine("@hourly", true);
    const once = upsertAutoLines("0 3 * * * backup.sh\n", line);
    const twice = upsertAutoLines(once, line);
    expect(twice).toBe(once);
    expect(twice.split("\n").filter((l) => l.includes(AUTO_MARKER)).length).toBe(1);
    expect(twice).toContain("backup.sh");
  });

  it("replaces an existing managed line when the schedule changes", () => {
    const hourly = upsertAutoLines("", buildAutoLine("@hourly", true));
    const daily = upsertAutoLines(hourly, buildAutoLine("@daily", true));
    expect(daily).not.toContain("@hourly");
    expect(daily.split("\n").filter((l) => l.includes(AUTO_MARKER)).length).toBe(1);
  });

  it("removes only managed lines", () => {
    const tab = upsertAutoLines("0 3 * * * backup.sh\n", buildAutoLine("@hourly", true));
    const cleaned = removeAutoLines(tab);
    expect(cleaned).toContain("backup.sh");
    expect(cleaned).not.toContain(AUTO_MARKER);
  });

  it("lists managed lines for status display", () => {
    const tab = upsertAutoLines("", buildAutoLine("@hourly", false));
    expect(listAutoLines(tab)).toEqual([`@hourly rewound index ${AUTO_MARKER}`]);
    expect(listAutoLines("0 3 * * * backup.sh\n")).toEqual([]);
  });
});
