import { describe, expect, it, vi } from "vitest";
import {
  RouterUpdater,
  compareVersions,
  diagnose,
  installDirFromBin,
  installDirFromCommand,
  isDaemonCommand,
  prefixFromInstallDir,
  type ExecResult,
  type ProcessInfo,
} from "./routerUpdate";

const LOCAL = "/Users/u/.local/lib/node_modules/9router";
const BREW = "/opt/homebrew/lib/node_modules/9router";

describe("path helpers", () => {
  it("maps a bin symlink target to its package dir and prefix", () => {
    expect(installDirFromBin(`${LOCAL}/cli.js`)).toBe(LOCAL);
    expect(installDirFromBin("/usr/local/bin/9router")).toBeNull();
    expect(prefixFromInstallDir(LOCAL, "darwin")).toBe("/Users/u/.local");
    expect(prefixFromInstallDir(BREW, "linux")).toBe("/opt/homebrew");
    expect(prefixFromInstallDir("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\9router".replace(/\\/g, "/"), "win32")).toBe("C:/Users/u/AppData/Roaming/npm");
  });

  it("recognises daemon command lines only", () => {
    expect(isDaemonCommand(`/opt/homebrew/bin/node ${LOCAL}/cli.js --tray --skip-update`)).toBe(true);
    expect(isDaemonCommand("grep -i 9router")).toBe(false);
    expect(isDaemonCommand("/Applications/Code.app/Contents/MacOS/Electron /repo/9router-notes.md")).toBe(false);
    expect(installDirFromCommand(`node ${LOCAL}/cli.js --tray`)).toBe(LOCAL);
    expect(installDirFromCommand("node server.js")).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("0.5.75", "0.5.55")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.5.55", "0.5.75")).toBe(-1);
  });
});

describe("diagnose", () => {
  const local = { dir: LOCAL, version: "0.5.55", prefix: "/Users/u/.local", onPath: true, pathRank: 0, npmDefault: false };
  const brew = { dir: BREW, version: "0.5.75", prefix: "/opt/homebrew", onPath: false, pathRank: null, npmDefault: true };

  it("explains a shadowed npm prefix and a stale copy on PATH", () => {
    const out = diagnose({ runningVersion: "0.5.55", runningPid: 1, runningDir: LOCAL, latestVersion: "0.5.75", npmPrefix: "/opt/homebrew", installs: [local, brew] });
    expect(out.join("\n")).toContain("npm's global prefix is /opt/homebrew");
    expect(out.join("\n")).toContain("behind the registry");
  });

  it("explains a daemon that never restarted", () => {
    const out = diagnose({ runningVersion: "0.5.55", runningPid: 1, runningDir: BREW, latestVersion: "0.5.75", npmPrefix: "/opt/homebrew", installs: [{ ...brew, onPath: true, pathRank: 0 }] });
    expect(out.join("\n")).toContain("needs a restart");
  });

  it("says up to date when nothing is wrong", () => {
    const out = diagnose({ runningVersion: "0.5.75", runningPid: 1, runningDir: BREW, latestVersion: "0.5.75", npmPrefix: "/opt/homebrew", installs: [{ ...brew, onPath: true, pathRank: 0 }] });
    expect(out).toEqual([`The daemon reports 0.5.75 and runs from ${BREW}.`, "Up to date."]);
  });

  it("reports a missing install", () => {
    expect(diagnose({ runningVersion: null, runningPid: null, runningDir: null, latestVersion: "0.5.75", npmPrefix: "/opt/homebrew", installs: [] })[0]).toMatch(/not installed/);
  });
});

interface World {
  versions: Record<string, string | null>;
  running: string | null;
  procs: ProcessInfo[];
  portOpen: boolean;
  npmFails?: string[];
}

function setup(world: World, opts: { shutdownThrows?: boolean; startError?: string } = {}) {
  const calls: string[][] = [];
  const killed: Array<[number, string]> = [];
  const exec = vi.fn(async (cmd: string, args: string[], o?: { onLine?: (l: string) => void }): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    if (cmd === "npm" && args[0] === "i") {
      const prefix = args[args.indexOf("--prefix") + 1];
      o?.onLine?.(`installing into ${prefix}`);
      if (world.npmFails?.includes(prefix)) return { code: 1, stdout: "", stderr: "EACCES" };
      const dir = `${prefix}/lib/node_modules/9router`;
      world.versions[dir] = "0.5.75";
      return { code: 0, stdout: "changed 1 package", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const client = {
    version: vi.fn(async () => {
      if (!world.running) throw new Error("unreachable");
      return { currentVersion: world.running, latestVersion: "0.5.75", hasUpdate: world.running !== "0.5.75" };
    }),
    shutdown: vi.fn(async () => {
      if (opts.shutdownThrows) throw new Error("connection reset");
      // A cooperative daemon exits on shutdown.
      world.procs = world.procs.filter((p) => !p.command.includes("cooperative"));
      world.portOpen = world.procs.length > 0;
      world.running = null;
    }),
  };
  const proc = {
    start: vi.fn(async () => {
      if (opts.startError) return { reachable: false, started: false, baseURL: "http://127.0.0.1:20128/v1", error: opts.startError };
      // Starting runs whatever PATH resolves first.
      world.running = world.versions[LOCAL] ?? world.versions[BREW] ?? null;
      world.portOpen = true;
      return { reachable: true, started: true, baseURL: "http://127.0.0.1:20128/v1" };
    }),
  };
  const updater = new RouterUpdater({
    client,
    process: proc,
    exec,
    which: async () => (world.versions[LOCAL] !== undefined ? ["/Users/u/.local/bin/9router", "/opt/homebrew/bin/9router"] : []),
    realpath: async (p) => (p.startsWith("/Users/u/.local") ? `${LOCAL}/cli.js` : `${BREW}/cli.js`),
    readVersion: async (dir) => world.versions[dir] ?? null,
    listProcesses: async () => world.procs,
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      if (signal === "SIGKILL" || !world.procs.find((p) => p.pid === pid)?.command.includes("stubborn")) {
        world.procs = world.procs.filter((p) => p.pid !== pid);
        world.portOpen = world.procs.length > 0;
      }
    },
    fetchLatest: async () => "0.5.75",
    npmPrefix: async () => "/opt/homebrew",
    isPortOpen: async () => world.portOpen,
    sleep: async () => undefined,
    platform: "darwin",
    selfPid: 999,
  });
  return { updater, calls, killed, client, proc, world };
}

describe("RouterUpdater.inspect", () => {
  it("lists installs in PATH order, marks the npm default, and finds the daemon", async () => {
    const { updater } = setup({
      versions: { [LOCAL]: "0.5.55", [BREW]: "0.5.75" },
      running: "0.5.55",
      procs: [{ pid: 999, command: "Electron 9rh" }, { pid: 47180, command: `node ${LOCAL}/cli.js --tray --skip-update` }],
      portOpen: true,
    });
    const info = await updater.inspect();
    expect(info.installs.map((i) => [i.dir, i.version, i.pathRank, i.npmDefault])).toEqual([
      [LOCAL, "0.5.55", 0, false],
      [BREW, "0.5.75", 1, true],
    ]);
    expect(info.runningPid).toBe(47180);
    expect(info.runningDir).toBe(LOCAL);
    expect(info.latestVersion).toBe("0.5.75");
    expect(info.diagnosis.join("\n")).toContain("npm's global prefix");
    expect(info.canUpdate).toBe(true);
  });
});

describe("RouterUpdater.update", () => {
  it("updates the PATH install, restarts, and verifies the reported version", async () => {
    const world: World = {
      versions: { [LOCAL]: "0.5.55", [BREW]: "0.5.75" },
      running: "0.5.55",
      procs: [{ pid: 1, command: `node ${LOCAL}/cli.js --tray cooperative` }],
      portOpen: true,
    };
    const { updater, calls, killed, proc } = setup(world);
    const phases: string[] = [];
    const result = await updater.update({}, (p) => phases.push(p.phase));

    expect(calls.filter((c) => c[0] === "npm" && c[1] === "i")).toEqual([
      ["npm", "i", "-g", "9router@latest", "--prefer-online", "--prefix", "/Users/u/.local"],
    ]);
    expect(killed).toEqual([]);
    expect(proc.start).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.before).toBe("0.5.55");
    expect(result.after).toBe("0.5.75");
    expect(result.updatedInstalls).toEqual([LOCAL]);
    expect(phases).toContain("install");
    expect(phases.at(-1)).toBe("done");
  });

  it("force mode updates every install and kills processes that ignore shutdown", async () => {
    const world: World = {
      versions: { [LOCAL]: "0.5.55", [BREW]: "0.5.70" },
      running: "0.5.55",
      procs: [
        { pid: 10, command: `node ${LOCAL}/cli.js --tray stubborn` },
        { pid: 11, command: `node ${BREW}/cli.js --tray` },
      ],
      portOpen: true,
    };
    const { updater, calls, killed } = setup(world, { shutdownThrows: true });
    const result = await updater.update({ force: true });

    const npm = calls.filter((c) => c[0] === "npm" && c[1] === "i");
    expect(npm).toHaveLength(2);
    expect(npm[0]).toContain("--force");
    expect(npm.map((c) => c[c.indexOf("--prefix") + 1])).toEqual(["/Users/u/.local", "/opt/homebrew"]);
    // Both got SIGTERM; only the stubborn one needed SIGKILL.
    expect(killed).toEqual([
      [10, "SIGTERM"],
      [11, "SIGTERM"],
      [10, "SIGKILL"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.after).toBe("0.5.75");
    expect(result.updatedInstalls).toEqual([LOCAL, BREW]);
  });

  it("stops at the first npm failure in normal mode but continues in force mode", async () => {
    const base: World = { versions: { [LOCAL]: "0.5.55", [BREW]: "0.5.70" }, running: "0.5.55", procs: [], portOpen: false, npmFails: ["/Users/u/.local"] };
    const normal = setup({ ...base, versions: { ...base.versions } });
    const r1 = await normal.updater.update({});
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/npm exited with 1/);
    expect(normal.proc.start).not.toHaveBeenCalled();

    const forced = setup({ ...base, versions: { ...base.versions } });
    const r2 = await forced.updater.update({ force: true });
    expect(r2.updatedInstalls).toEqual([BREW]);
    // PATH still resolves the stale ~/.local copy, so this is not a success
    // even though the daemon and that copy agree on 0.5.55.
    expect(r2.ok).toBe(false);
    expect(r2.after).toBe("0.5.55");
    expect(r2.error).toMatch(/npm failed for \/Users\/u\/\.local/);
  });

  it("reports a daemon that will not stop in normal mode", async () => {
    const world: World = {
      versions: { [LOCAL]: "0.5.55" },
      running: "0.5.55",
      procs: [{ pid: 5, command: `node ${LOCAL}/cli.js stubborn` }],
      portOpen: true,
    };
    const { updater, proc } = setup(world, { shutdownThrows: true });
    const result = await updater.update({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not stop within 10s; try a forced update/);
    expect(proc.start).not.toHaveBeenCalled();
  });

  it("installs fresh into the npm prefix when nothing is installed", async () => {
    const world: World = { versions: {}, running: null, procs: [], portOpen: false };
    const { updater, calls } = setup(world);
    const result = await updater.update({});
    expect(calls.filter((c) => c[0] === "npm" && c[1] === "i")[0]).toContain("/opt/homebrew");
    expect(result.updatedInstalls).toEqual([BREW]);
    expect(result.after).toBe("0.5.75");
  });

  it("refuses to run twice at once", async () => {
    const world: World = { versions: { [LOCAL]: "0.5.55" }, running: "0.5.55", procs: [], portOpen: false };
    const { updater } = setup(world);
    const first = updater.update({});
    await expect(updater.update({})).rejects.toThrow(/already running/);
    await first;
  });
});
