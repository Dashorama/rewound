import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewound-cfg-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("config", () => {
  it("round-trips settings next to the db", () => {
    const dbPath = path.join(tmp, "rewound.db");
    saveConfig(dbPath, { syncDir: "/home/u/Drive/rewound" });
    expect(loadConfig(dbPath)).toEqual({ syncDir: "/home/u/Drive/rewound" });
    expect(fs.existsSync(path.join(tmp, "config.json"))).toBe(true);
  });

  it("returns an empty config when none exists or file is corrupt", () => {
    const dbPath = path.join(tmp, "rewound.db");
    expect(loadConfig(dbPath)).toEqual({});
    fs.writeFileSync(path.join(tmp, "config.json"), "{not json");
    expect(loadConfig(dbPath)).toEqual({});
  });
});
