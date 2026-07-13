import fs from "node:fs";
import path from "node:path";

// Small persisted settings file living next to the database, so "rewound sync"
// can remember its folder after the first run instead of making the user
// retype it in every invocation and cron line on every machine.
export interface RewoundConfig {
  syncDir?: string;
}

function configPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), "config.json");
}

export function loadConfig(dbPath: string): RewoundConfig {
  try {
    const raw = fs.readFileSync(configPath(dbPath), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as RewoundConfig) : {};
  } catch {
    return {};
  }
}

export function saveConfig(dbPath: string, cfg: RewoundConfig): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(configPath(dbPath), JSON.stringify(cfg, null, 2) + "\n");
}
