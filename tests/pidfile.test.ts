import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pidFilePath,
  writeServeRecord,
  readServeRecord,
  removeServeRecord,
  isProcessAlive,
  looksLikeRewoundServe,
  stopServer,
  type ServeRecord,
} from "../src/pidfile.js";

let tmpDir: string;
let file: string;

const rec: ServeRecord = {
  pid: 4242,
  port: 4321,
  host: "127.0.0.1",
  startedAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-pid-"));
  file = path.join(tmpDir, "serve.pid");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const noSleep = async () => {};

describe("serve record round-trip", () => {
  it("lives next to the database", () => {
    expect(pidFilePath("/home/dev/.rewound/rewound.db")).toBe("/home/dev/.rewound/serve.pid");
  });

  it("writes and reads back a record, creating the directory if needed", () => {
    const nested = path.join(tmpDir, "db", "serve.pid");
    writeServeRecord(nested, rec);
    expect(readServeRecord(nested)).toEqual(rec);
  });

  it("returns null for a missing, corrupt, or pid-less record", () => {
    expect(readServeRecord(file)).toBeNull();
    fs.writeFileSync(file, "{ truncated");
    expect(readServeRecord(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ port: 4321 }));
    expect(readServeRecord(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ pid: -1 }));
    expect(readServeRecord(file)).toBeNull();
  });

  it("removes a record and tolerates removing one that is already gone", () => {
    writeServeRecord(file, rec);
    removeServeRecord(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeServeRecord(file)).not.toThrow();
  });
});

describe("isProcessAlive", () => {
  it("is true for this process and false for a pid that is gone", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(
      isProcessAlive(4242, () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      })
    ).toBe(false);
  });

  it("treats EPERM as alive — the pid exists, it just is not ours to signal", () => {
    expect(
      isProcessAlive(1, () => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      })
    ).toBe(true);
  });
});

describe("looksLikeRewoundServe (pid-reuse guard)", () => {
  it("accepts a rewound serve command line", () => {
    expect(looksLikeRewoundServe(1, () => "/usr/bin/node /path/rewound/dist/cli.js serve")).toBe(true);
  });

  it("rejects an unrelated process that inherited the pid", () => {
    expect(looksLikeRewoundServe(1, () => "/Applications/Safari.app/Contents/MacOS/Safari")).toBe(false);
    expect(looksLikeRewoundServe(1, () => "node /path/rewound/dist/cli.js index")).toBe(false);
  });

  it("allows the kill when the command line cannot be read at all", () => {
    expect(looksLikeRewoundServe(1, () => null)).toBe(true);
  });
});

describe("stopServer", () => {
  it("reports not-running when there is no record", async () => {
    expect(await stopServer(file, { sleep: noSleep })).toEqual({ status: "not-running" });
  });

  it("SIGTERMs a live server, waits for it to exit, and clears the record", async () => {
    writeServeRecord(file, rec);
    const signals: Array<NodeJS.Signals | 0> = [];
    let dead = false;
    const result = await stopServer(file, {
      sleep: noSleep,
      looksRight: () => true,
      alive: () => !dead,
      kill: (_pid, sig) => {
        signals.push(sig);
        if (sig === "SIGTERM") dead = true;
      },
    });
    expect(result).toEqual({ status: "stopped", pid: 4242, port: 4321, host: "127.0.0.1", forced: false });
    expect(signals).toEqual(["SIGTERM"]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    writeServeRecord(file, rec);
    const signals: Array<NodeJS.Signals | 0> = [];
    let dead = false;
    const result = await stopServer(file, {
      sleep: noSleep,
      graceMs: 300,
      forceMs: 300,
      looksRight: () => true,
      alive: () => !dead,
      kill: (_pid, sig) => {
        signals.push(sig);
        if (sig === "SIGKILL") dead = true;
      },
    });
    expect(result).toMatchObject({ status: "stopped", forced: true });
    expect(signals).toContain("SIGKILL");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reports a stale record without signalling anything when the process is gone", async () => {
    writeServeRecord(file, rec);
    const signals: Array<NodeJS.Signals | 0> = [];
    const result = await stopServer(file, {
      sleep: noSleep,
      alive: () => false,
      kill: (_pid, sig) => void signals.push(sig),
    });
    expect(result).toEqual({ status: "stale", pid: 4242 });
    expect(signals).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses to kill a recycled pid that is no longer a rewound serve", async () => {
    writeServeRecord(file, rec);
    const signals: Array<NodeJS.Signals | 0> = [];
    const result = await stopServer(file, {
      sleep: noSleep,
      alive: () => true,
      looksRight: () => false,
      kill: (_pid, sig) => void signals.push(sig),
    });
    expect(result).toEqual({ status: "stale", pid: 4242 });
    expect(signals).toEqual([]);
  });

  it("counts a process that exits between the check and the signal as stopped", async () => {
    writeServeRecord(file, rec);
    const result = await stopServer(file, {
      sleep: noSleep,
      alive: () => true,
      looksRight: () => true,
      kill: () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
    });
    expect(result).toMatchObject({ status: "stopped", forced: false });
  });

  it("reports failure when even SIGKILL does not land", async () => {
    writeServeRecord(file, rec);
    const result = await stopServer(file, {
      sleep: noSleep,
      graceMs: 200,
      forceMs: 200,
      alive: () => true,
      looksRight: () => true,
      kill: () => {},
    });
    expect(result).toMatchObject({ status: "failed", pid: 4242 });
    // The record survives a failure: the server really is still up.
    expect(fs.existsSync(file)).toBe(true);
  });
});
