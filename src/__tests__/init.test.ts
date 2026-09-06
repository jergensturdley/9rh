import { afterAll, afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ────────────────────────────────────────────────────────────────────
// Task 5 (perf/parallelism): async exec in router/init hot paths.
//
// readFirstApiKey / getCliToken become async and stop blocking the
// event loop with execFileSync / readFileSync:
//   - readFirstApiKey resolves the first key from stubbed sqlite stdout,
//     returns null when the DB file is missing, and returns null when
//     the sqlite3 exec fails (mirrors legacy null-on-miss behavior).
//   - getCliToken resolves a 16-char token and swallows a missing
//     machine-id probe source (legacy behavior: empty secret fallback).
// ────────────────────────────────────────────────────────────────────

interface ExecOpts {
  encoding?: string;
  timeout?: number;
}

// Behavior is a plain variable (not the jest.fn impl) because init.ts wraps
// execFile in util.promisify: the wrapper appends a callback argument and
// resolves from THAT callback, not from a returned promise. The jest.fn
// bridges both calling conventions; tests swap `behavior`.
let behavior: (
  file: string,
  args: readonly string[],
  opts: ExecOpts,
) => Promise<{ stdout: string; stderr: string }> = async () => ({ stdout: "", stderr: "" });

const execFileMock = jest.fn(
  (
    file: string,
    args: readonly string[],
    opts: ExecOpts = {},
    cb?: (err: unknown, val?: { stdout: string; stderr: string }) => void,
  ): Promise<{ stdout: string; stderr: string }> => {
    const p = behavior(file, args, opts);
    if (typeof cb === "function") {
      p.then((v) => cb(null, v), (e) => cb(e));
    }
    return p;
  },
);
let homeDir = tmpdir();

jest.unstable_mockModule("os", () => ({
  __esModule: true,
  default: {
    homedir: () => homeDir,
  },
  homedir: () => homeDir,
}));

jest.unstable_mockModule("child_process", () => ({
  __esModule: true,
  // execFile is the only child_process export the async implementation
  // consumes. Other exports throw on use so legacy sync paths fail loudly
  // if they ever run in this suite.
  execFile: execFileMock,
  execFileSync: () => {
    throw new Error("execFileSync must not be called by the async implementation");
  },
  spawn: () => {
    throw new Error("spawn not expected in this test");
  },
}));

const { readFirstApiKey, getCliToken } = await import("../init.js");

afterEach(() => {
  behavior = async () => ({ stdout: "", stderr: "" });
  execFileMock.mockClear();
});

afterAll(async () => {
  // restore mocked modules for other suites sharing this worker
  jest.dontMock("child_process");
  jest.dontMock("os");
});

describe("readFirstApiKey (async sqlite lookup)", () => {
  it("resolves the key from stubbed sqlite stdout", async () => {
    const dbDir = join(homeDir, ".9router", "db");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "data.sqlite"), "fake-db");
    behavior = async () => ({ stdout: "  sk-test-123  \n", stderr: "" });

    await expect(readFirstApiKey()).resolves.toBe("sk-test-123");
    expect(execFileMock).toHaveBeenCalledWith(
      "sqlite3",
      [expect.stringContaining("data.sqlite"), "SELECT key FROM apiKeys LIMIT 1"],
      expect.objectContaining({ encoding: "utf8" }),
      expect.any(Function), // appended by util.promisify
    );
  });

  it("returns null without exec when the DB file is missing", async () => {
    rmSync(join(homeDir, ".9router"), { recursive: true, force: true });
    behavior = async () => ({ stdout: "sk-x", stderr: "" });

    await expect(readFirstApiKey()).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns null when the sqlite exec fails (null-on-miss)", async () => {
    const dbDir = join(homeDir, ".9router", "db");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "data.sqlite"), "fake-db");
    behavior = async () => {
      throw new Error("sqlite3: not found");
    };

    await expect(readFirstApiKey()).resolves.toBeNull();
  });
});

describe("getCliToken (async fs/exec)", () => {
  it("resolves a 16-char token derived from the machine id", async () => {
    const idFile = join(homeDir, ".9router", "machine-id");
    mkdirSync(join(homeDir, ".9router"), { recursive: true });
    writeFileSync(idFile, "machine-id-abc\n");

    const token = await getCliToken();
    expect(token).toHaveLength(16);
    // stable across calls
    expect(await getCliToken()).toBe(token);
    // does not shell out when machine-id file exists
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("swallows a failing machine-id probe (no ioreg, no throw)", async () => {
    rmSync(join(homeDir, ".9router"), { recursive: true, force: true });
    behavior = async () => {
      throw new Error("ioreg: unavailable");
    };

    await expect(getCliToken()).resolves.toBe("");
  });
});
