import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// `rewound serve` is a plain detached-able node process with no supervisor, so
// `rewound stop` needs a way to find it again. The record lives next to the
// database (like config.json) rather than in a global /var/run-style location:
// the DB path is what a given serve instance is bound to, so a second server on
// a second --db is independently stoppable.
export interface ServeRecord {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

export function pidFilePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), "serve.pid");
}

export function writeServeRecord(file: string, rec: ServeRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
}

export function readServeRecord(file: string): ServeRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // missing, unreadable, or truncated by a crash mid-write
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Partial<ServeRecord>;
  if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) return null;
  return {
    pid: rec.pid,
    port: typeof rec.port === "number" ? rec.port : 0,
    host: typeof rec.host === "string" ? rec.host : "127.0.0.1",
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt : "",
  };
}

export function removeServeRecord(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — nothing to clean up
  }
}

export type Killer = (pid: number, signal: NodeJS.Signals | 0) => void;

export function isProcessAlive(pid: number, kill: Killer = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else; only ESRCH proves
    // it is gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type CommandReader = (pid: number) => string | null;

const readCommand: CommandReader = (pid) => {
  if (process.platform === "win32") return null; // no ps; skip the guard
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

// Pids get recycled, and a stale serve.pid pointing at a since-reused pid would
// make `rewound stop` kill an innocent process. Only proceed when the command
// line still looks like a rewound server; an unreadable command line (no ps,
// permission denied) is inconclusive and allowed through.
export function looksLikeRewoundServe(pid: number, reader: CommandReader = readCommand): boolean {
  const cmd = reader(pid);
  if (cmd === null || cmd === "") return true;
  return /(rewound|\brw\b|cli\.js)/i.test(cmd) && /\bserve\b/.test(cmd);
}

export type StopResult =
  | { status: "stopped"; pid: number; port: number; host: string; forced: boolean }
  | { status: "not-running" }
  | { status: "stale"; pid: number }
  | { status: "failed"; pid: number; reason: string };

export interface StopDeps {
  kill?: Killer;
  alive?: (pid: number) => boolean;
  looksRight?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a graceful SIGTERM exit before escalating, in ms. */
  graceMs?: number;
  /** How long to wait after SIGKILL before giving up, in ms. */
  forceMs?: number;
}

const POLL_MS = 100;

/**
 * SIGTERM, wait for the process to actually exit, then SIGKILL as a fallback.
 * Reports what happened instead of throwing so the CLI can print one clear line.
 */
export async function stopServer(file: string, deps: StopDeps = {}): Promise<StopResult> {
  const kill = deps.kill ?? process.kill;
  const alive = deps.alive ?? ((pid: number) => isProcessAlive(pid, kill));
  const looksRight = deps.looksRight ?? ((pid: number) => looksLikeRewoundServe(pid));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = deps.graceMs ?? 5000;
  const forceMs = deps.forceMs ?? 2000;

  const rec = readServeRecord(file);
  if (!rec) {
    removeServeRecord(file); // drop a corrupt record so the next start is clean
    return { status: "not-running" };
  }

  if (!alive(rec.pid) || !looksRight(rec.pid)) {
    removeServeRecord(file);
    return { status: "stale", pid: rec.pid };
  }

  const signal = async (sig: NodeJS.Signals, waitMs: number): Promise<boolean> => {
    try {
      kill(rec.pid, sig);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true; // exited between the check and the signal
      throw err;
    }
    for (let waited = 0; waited < waitMs; waited += POLL_MS) {
      if (!alive(rec.pid)) return true;
      await sleep(POLL_MS);
    }
    return !alive(rec.pid);
  };

  try {
    if (await signal("SIGTERM", graceMs)) {
      removeServeRecord(file);
      return { status: "stopped", pid: rec.pid, port: rec.port, host: rec.host, forced: false };
    }
    if (await signal("SIGKILL", forceMs)) {
      removeServeRecord(file);
      return { status: "stopped", pid: rec.pid, port: rec.port, host: rec.host, forced: true };
    }
    return { status: "failed", pid: rec.pid, reason: "process did not exit after SIGTERM and SIGKILL" };
  } catch (err) {
    return { status: "failed", pid: rec.pid, reason: (err as Error).message };
  }
}
