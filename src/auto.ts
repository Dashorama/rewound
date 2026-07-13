import { spawnSync } from "node:child_process";

// Pure crontab-text manipulation for `rewound auto` — kept side-effect-free so
// the scheduling logic is testable without touching a real crontab.
export const AUTO_MARKER = "# managed-by-rewound-auto";

export function buildAutoLine(schedule: string, haveSyncDir: boolean): string {
  const cmd = haveSyncDir ? "rewound index && rewound sync" : "rewound index";
  return `${schedule} ${cmd} ${AUTO_MARKER}`;
}

export function listAutoLines(crontab: string): string[] {
  return crontab.split("\n").filter((l) => l.includes(AUTO_MARKER));
}

export function removeAutoLines(crontab: string): string {
  const kept = crontab.split("\n").filter((l) => !l.includes(AUTO_MARKER));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.length ? kept.join("\n") + "\n" : "";
}

export function upsertAutoLines(crontab: string, line: string): string {
  const base = removeAutoLines(crontab);
  return base + line + "\n";
}

// Thin wrappers around the crontab binary. Return undefined when crontab is
// unavailable (e.g. Windows, minimal containers) so the CLI can fall back to
// printing the line for manual setup.
export function readCrontab(): string | undefined {
  const res = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (res.error) return undefined;
  // `crontab -l` exits 1 with "no crontab for <user>" when empty — treat as "".
  if (res.status !== 0) return "";
  return res.stdout ?? "";
}

export function writeCrontab(contents: string): boolean {
  const res = spawnSync("crontab", ["-"], { input: contents, encoding: "utf8" });
  return !res.error && res.status === 0;
}
