/**
 * Update the local 9router install, including the ways its own updater
 * leaves a machine stuck on an old version:
 *
 *  - `npm i -g 9router@latest` writes into npm's global prefix, while the
 *    `9router` that PATH resolves (and therefore the daemon) lives in another
 *    prefix (for example ~/.local first on PATH, /opt/homebrew as npm's
 *    default). The update lands in the copy that never runs.
 *  - the daemon is relaunched from the same stale cli.js path it started from;
 *  - the daemon never restarts after the files change.
 *
 * Normal mode updates the install PATH resolves and restarts the daemon.
 * Force mode updates every install found, kills every 9router process, starts
 * from PATH, and both modes verify the version the daemon reports afterwards.
 *
 * Every OS interaction is injectable so the flow is unit-tested with fakes.
 * ponytail: Windows paths are handled but untested here (no machine to
 * verify `where` and npm.cmd quoting); process discovery is POSIX-only.
 */

import { spawn } from "child_process";
import { readFile, realpath as fsRealpath } from "fs/promises";
import { basename, dirname, join } from "path";
import type {
  RouterInstall,
  RouterUpdateInfo,
  RouterUpdateInput,
  RouterUpdateProgress,
  RouterUpdateResult,
} from "@shared/ipc";
import type { RouterClient } from "./routerClient";
import type { RouterProcess } from "./routerProcess";
import { NINE_ROUTER_PORT, isPortOpen as defaultIsPortOpen } from "./routerProcess";

export const PACKAGE = "9router";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`;
const NPM_TIMEOUT_MS = 180_000;
const LOG_CAP = 400;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; onLine?: (line: string) => void },
) => Promise<ExecResult>;

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface UpdaterDeps {
  client: Pick<RouterClient, "version" | "shutdown">;
  process: Pick<RouterProcess, "start">;
  exec?: Exec;
  /** Every match on PATH, in PATH order (`which -a` / `where`). */
  which?: (name: string) => Promise<string[]>;
  realpath?: (path: string) => Promise<string>;
  /** package.json version of an install dir, null when missing. */
  readVersion?: (dir: string) => Promise<string | null>;
  listProcesses?: () => Promise<ProcessInfo[]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  fetchLatest?: () => Promise<string | null>;
  npmPrefix?: () => Promise<string | null>;
  isPortOpen?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  selfPid?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** `<prefix>/lib/node_modules/9router/cli.js` (or a bin symlink target) to the package dir. */
export function installDirFromBin(binRealPath: string): string | null {
  const dir = dirname(binRealPath);
  if (basename(dir) === PACKAGE && basename(dirname(dir)) === "node_modules") return dir;
  return null;
}

/** The npm prefix that owns an install dir: `--prefix` for `npm i -g`. */
export function prefixFromInstallDir(dir: string, platform: NodeJS.Platform): string {
  const nodeModules = dirname(dir); // .../node_modules
  const above = dirname(nodeModules); // .../lib on POSIX, <prefix> on Windows
  if (platform === "win32") return above;
  return basename(above) === "lib" ? dirname(above) : above;
}

export function installDirForPrefix(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? join(prefix, "node_modules", PACKAGE) : join(prefix, "lib", "node_modules", PACKAGE);
}

/** A 9router daemon: node running its cli.js or its package dir (never grep, editors, or this app). */
export function isDaemonCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (!c.includes(PACKAGE)) return false;
  if (c.includes("grep ")) return false;
  return /9router[\\/]cli\.js/.test(c) || /node_modules[\\/]9router[\\/]/.test(c);
}

/** Package dir from a daemon command line, when it names cli.js. */
export function installDirFromCommand(command: string): string | null {
  const m = /(\S+[\\/]9router[\\/]cli\.js)/i.exec(command);
  return m ? dirname(m[1]) : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

export function diagnose(info: Omit<RouterUpdateInfo, "diagnosis" | "canUpdate">): string[] {
  const out: string[] = [];
  const first = info.installs.find((i) => i.pathRank === 0) ?? null;
  const def = info.installs.find((i) => i.npmDefault) ?? null;
  if (!first && !def) {
    out.push("9router is not installed in any npm prefix on this machine. Start installs it.");
    return out;
  }
  if (info.runningVersion) {
    out.push(`The daemon reports ${info.runningVersion}${info.runningDir ? ` and runs from ${info.runningDir}` : ""}.`);
  } else {
    out.push("No running daemon answered /api/version.");
  }
  if (first && def && first.dir !== def.dir) {
    out.push(
      `npm's global prefix is ${def.prefix} (${def.version ?? "unknown"}) but the 9router on PATH comes from ${first.prefix} (${first.version ?? "unknown"}). A plain "npm i -g 9router@latest" updates the copy the daemon never runs; this updater targets the PATH copy (force: every copy).`,
    );
  }
  const runningInstall = info.runningDir ? info.installs.find((i) => i.dir === info.runningDir) : undefined;
  if (runningInstall?.version && info.runningVersion && compareVersions(runningInstall.version, info.runningVersion) > 0) {
    out.push(`The files under ${runningInstall.dir} are already ${runningInstall.version}; the daemon started before that update and needs a restart.`);
  }
  if (first?.version && info.latestVersion && compareVersions(first.version, info.latestVersion) < 0) {
    out.push(`The copy on PATH (${first.version}) is behind the registry (${info.latestVersion}).`);
  }
  if (info.runningDir && first && info.runningDir !== first.dir) {
    out.push(`The daemon runs from ${info.runningDir}, which is not the copy PATH resolves (${first.dir}); a restart picks up the PATH copy.`);
  }
  if (out.length === 1 && info.runningVersion && info.latestVersion && compareVersions(info.runningVersion, info.latestVersion) >= 0) {
    out.push("Up to date.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default OS bindings
// ---------------------------------------------------------------------------

function defaultExec(platform: NodeJS.Platform): Exec {
  return (cmd, args, opts = {}) =>
    new Promise<ExecResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (code: number): void => {
        if (settled) return;
        settled = true;
        resolve({ code, stdout, stderr });
      };
      const feed = (chunk: Buffer, sink: "out" | "err"): void => {
        const text = chunk.toString();
        if (sink === "out") stdout += text;
        else stderr += text;
        if (opts.onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLine(line);
      };
      let child: ReturnType<typeof spawn>;
      try {
        // .cmd shims need a shell on Windows; our args never come from the renderer.
        child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: platform === "win32" });
      } catch (err) {
        stderr = err instanceof Error ? err.message : String(err);
        done(-1);
        return;
      }
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            stderr += `\n${cmd} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`;
            child.kill("SIGKILL");
            done(-1);
          }, opts.timeoutMs)
        : null;
      child.stdout?.on("data", (c: Buffer) => feed(c, "out"));
      child.stderr?.on("data", (c: Buffer) => feed(c, "err"));
      child.on("error", (err) => {
        stderr += err.message;
        if (timer) clearTimeout(timer);
        done(-1);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        done(code ?? -1);
      });
    });
}

async function defaultWhich(exec: Exec, platform: NodeJS.Platform, name: string): Promise<string[]> {
  const r = platform === "win32" ? await exec("where", [name]) : await exec("which", ["-a", name]);
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

async function defaultReadVersion(dir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function defaultListProcesses(exec: Exec, platform: NodeJS.Platform): Promise<ProcessInfo[]> {
  if (platform === "win32") return []; // ponytail: rely on /api/shutdown on Windows
  const r = await exec("ps", ["-axo", "pid=,command="], { timeoutMs: 5_000 });
  if (r.code !== 0) return [];
  const out: ProcessInfo[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), command: m[2] });
  }
  return out;
}

async function defaultFetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_LATEST, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

async function defaultNpmPrefix(exec: Exec, npm: string): Promise<string | null> {
  const r = await exec(npm, ["prefix", "-g"], { timeoutMs: 15_000 });
  const p = r.stdout.trim().split(/\r?\n/).pop()?.trim();
  return r.code === 0 && p ? p : null;
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export class RouterUpdater {
  private readonly client: UpdaterDeps["client"];
  private readonly process: UpdaterDeps["process"];
  private readonly exec: Exec;
  private readonly which: (name: string) => Promise<string[]>;
  private readonly realpath: (path: string) => Promise<string>;
  private readonly readVersion: (dir: string) => Promise<string | null>;
  private readonly listProcesses: () => Promise<ProcessInfo[]>;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly fetchLatest: () => Promise<string | null>;
  private readonly npmPrefix: () => Promise<string | null>;
  private readonly isPortOpen: (port: number) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly selfPid: number;
  private readonly npm: string;
  private busy = false;

  constructor(deps: UpdaterDeps) {
    this.client = deps.client;
    this.process = deps.process;
    this.platform = deps.platform ?? process.platform;
    this.npm = this.platform === "win32" ? "npm.cmd" : "npm";
    this.exec = deps.exec ?? defaultExec(this.platform);
    this.which = deps.which ?? ((name) => defaultWhich(this.exec, this.platform, name));
    this.realpath = deps.realpath ?? fsRealpath;
    this.readVersion = deps.readVersion ?? defaultReadVersion;
    this.listProcesses = deps.listProcesses ?? (() => defaultListProcesses(this.exec, this.platform));
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.fetchLatest = deps.fetchLatest ?? defaultFetchLatest;
    this.npmPrefix = deps.npmPrefix ?? (() => defaultNpmPrefix(this.exec, this.npm));
    this.isPortOpen = deps.isPortOpen ?? defaultIsPortOpen;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.selfPid = deps.selfPid ?? process.pid;
  }

  async inspect(): Promise<RouterUpdateInfo> {
    const [bins, prefix, version, procs, registry] = await Promise.all([
      this.which(PACKAGE).catch(() => [] as string[]),
      this.npmPrefix().catch(() => null),
      this.client.version().catch(() => null),
      this.listProcesses().catch(() => [] as ProcessInfo[]),
      this.fetchLatest().catch(() => null),
    ]);

    const installs: RouterInstall[] = [];
    let rank = 0;
    for (const bin of bins) {
      let real: string;
      try {
        real = await this.realpath(bin);
      } catch {
        continue;
      }
      const dir = installDirFromBin(real);
      if (!dir) continue;
      if (installs.some((i) => i.dir === dir)) continue;
      installs.push({
        dir,
        version: await this.readVersion(dir),
        prefix: prefixFromInstallDir(dir, this.platform),
        onPath: true,
        pathRank: rank++,
        npmDefault: false,
      });
    }
    if (prefix) {
      const dir = installDirForPrefix(prefix, this.platform);
      const existing = installs.find((i) => i.dir === dir);
      if (existing) existing.npmDefault = true;
      else {
        const v = await this.readVersion(dir);
        if (v !== null) installs.push({ dir, version: v, prefix, onPath: false, pathRank: null, npmDefault: true });
      }
    }

    const daemon = procs.find((p) => p.pid !== this.selfPid && isDaemonCommand(p.command)) ?? null;
    const base = {
      runningVersion: version?.currentVersion ?? null,
      runningPid: daemon?.pid ?? null,
      runningDir: daemon ? installDirFromCommand(daemon.command) : null,
      latestVersion: registry ?? version?.latestVersion ?? null,
      npmPrefix: prefix,
      installs,
    };
    return { ...base, diagnosis: diagnose(base), canUpdate: installs.length > 0 || prefix !== null };
  }

  async update(input: RouterUpdateInput, onProgress?: (p: RouterUpdateProgress) => void): Promise<RouterUpdateResult> {
    if (this.busy) throw new Error("an update is already running");
    this.busy = true;
    try {
      return await this.run(input.force === true, onProgress);
    } finally {
      this.busy = false;
    }
  }

  private async run(force: boolean, onProgress?: (p: RouterUpdateProgress) => void): Promise<RouterUpdateResult> {
    const log: string[] = [];
    const say = (phase: RouterUpdateProgress["phase"], line: string): void => {
      log.push(line);
      if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
      onProgress?.({ phase, line });
    };
    const finish = (ok: boolean, partial: Partial<RouterUpdateResult>, error?: string): RouterUpdateResult => {
      if (error) say("done", error);
      say("done", ok ? "update complete" : "update did not complete");
      return {
        ok,
        before: null,
        after: null,
        latest: null,
        updatedInstalls: [],
        restarted: false,
        diagnosis: [],
        ...partial,
        log: [...log],
        ...(error ? { error } : {}),
      };
    };

    say("inspect", force ? "forced update: every install, every 9router process" : "updating the install on PATH");
    const before = await this.inspect();
    for (const d of before.diagnosis) say("inspect", d);
    const base = { before: before.runningVersion, latest: before.latestVersion };

    let targets: RouterInstall[] = force
      ? before.installs
      : [before.installs.find((i) => i.pathRank === 0) ?? before.installs.find((i) => i.npmDefault)].filter((i): i is RouterInstall => Boolean(i));
    if (targets.length === 0) {
      if (!before.npmPrefix) return finish(false, base, "no 9router install found and npm reported no global prefix; is npm on PATH?");
      say("install", `no install found; installing into ${before.npmPrefix}`);
      targets = [{ dir: installDirForPrefix(before.npmPrefix, this.platform), version: null, prefix: before.npmPrefix, onPath: false, pathRank: null, npmDefault: true }];
    }

    const updated: string[] = [];
    const failed: string[] = [];
    for (const t of targets) {
      const args = ["i", "-g", `${PACKAGE}@latest`, "--prefer-online", ...(force ? ["--force"] : []), "--prefix", t.prefix];
      say("install", `$ ${this.npm} ${args.join(" ")}`);
      const r = await this.exec(this.npm, args, { timeoutMs: NPM_TIMEOUT_MS, onLine: (l) => say("install", l) });
      if (r.code !== 0) {
        const tail = r.stderr.trim().split("\n").slice(-3).join(" ");
        const msg = `npm exited with ${r.code} for prefix ${t.prefix}${tail ? `: ${tail}` : ""}`;
        if (!force) return finish(false, base, msg);
        say("install", msg);
        failed.push(t.prefix);
        continue;
      }
      updated.push(t.dir);
      say("install", `${t.dir} is now ${(await this.readVersion(t.dir)) ?? "unknown"}`);
    }
    if (updated.length === 0) return finish(false, base, "no install could be updated");

    try {
      if (force) await this.forceStop(say);
      else await this.gracefulStop(say);
    } catch (err) {
      return finish(false, { ...base, updatedInstalls: updated }, err instanceof Error ? err.message : String(err));
    }

    say("start", "starting 9router from PATH");
    const started = await this.process.start();
    if (started.error) return finish(false, { ...base, updatedInstalls: updated }, started.error);
    if (!started.reachable) return finish(false, { ...base, updatedInstalls: updated }, `9router did not come up at ${started.baseURL}`);

    say("verify", "checking the version the daemon reports");
    const after = await this.inspect();
    const expected = (after.installs.find((i) => i.pathRank === 0) ?? after.installs.find((i) => updated.includes(i.dir)))?.version ?? null;
    let reported: string | null = after.runningVersion;
    for (let i = 0; i < 15 && expected && reported !== expected; i++) {
      await this.sleep(1_000);
      reported = (await this.client.version().catch(() => null))?.currentVersion ?? reported;
    }
    const result = { ...base, after: reported, latest: after.latestVersion ?? base.latest, updatedInstalls: updated, restarted: true, diagnosis: after.diagnosis };
    const latest = result.latest;
    if (expected === null) return finish(false, result, "could not read the installed version after the update");
    if (reported !== expected) {
      return finish(false, result, `the daemon reports ${reported ?? "nothing"} but the install on PATH is ${expected}${force ? "" : "; try a forced update"}`);
    }
    // The daemon matches the copy PATH resolves, but that copy can still be
    // stale when its own npm install failed (a forced run keeps going).
    if (failed.length > 0) {
      return finish(false, result, `npm failed for ${failed.join(", ")}; the daemon is running ${reported}`);
    }
    if (latest && compareVersions(reported, latest) < 0) {
      return finish(false, result, `the daemon is running ${reported} but ${latest} is published; the install on PATH did not move`);
    }
    say("verify", `daemon reports ${reported}`);
    return finish(true, result);
  }

  private async waitPortClosed(polls: number, say: (phase: RouterUpdateProgress["phase"], line: string) => void): Promise<boolean> {
    for (let i = 0; i < polls; i++) {
      if (!(await this.isPortOpen(NINE_ROUTER_PORT))) return true;
      await this.sleep(500);
    }
    say("stop", `port ${NINE_ROUTER_PORT} is still open`);
    return false;
  }

  private async gracefulStop(say: (phase: RouterUpdateProgress["phase"], line: string) => void): Promise<void> {
    say("stop", "asking the daemon to shut down");
    await this.client.shutdown().catch((err: unknown) => say("stop", `shutdown request failed: ${err instanceof Error ? err.message : String(err)}`));
    if (!(await this.waitPortClosed(20, say))) throw new Error("9router did not stop within 10s; try a forced update");
  }

  private async daemons(): Promise<ProcessInfo[]> {
    return (await this.listProcesses().catch(() => [] as ProcessInfo[])).filter((p) => p.pid !== this.selfPid && isDaemonCommand(p.command));
  }

  private async forceStop(say: (phase: RouterUpdateProgress["phase"], line: string) => void): Promise<void> {
    say("stop", "asking the daemon to shut down");
    await this.client.shutdown().catch(() => undefined);
    await this.waitPortClosed(10, say);
    let alive = await this.daemons();
    if (alive.length > 0) {
      say("stop", `terminating ${alive.map((p) => p.pid).join(", ")}`);
      for (const p of alive) this.tryKill(p.pid, "SIGTERM", say);
      for (let i = 0; i < 10 && alive.length > 0; i++) {
        await this.sleep(500);
        alive = await this.daemons();
      }
    }
    if (alive.length > 0) {
      say("stop", `killing ${alive.map((p) => p.pid).join(", ")}`);
      for (const p of alive) this.tryKill(p.pid, "SIGKILL", say);
      await this.sleep(1_000);
      alive = await this.daemons();
    }
    if (alive.length > 0) throw new Error(`9router processes survived SIGKILL: ${alive.map((p) => p.pid).join(", ")}`);
    if (await this.isPortOpen(NINE_ROUTER_PORT)) throw new Error(`port ${NINE_ROUTER_PORT} is still in use by another process`);
    say("stop", "no 9router process left");
  }

  private tryKill(pid: number, signal: NodeJS.Signals, say: (phase: RouterUpdateProgress["phase"], line: string) => void): void {
    try {
      this.kill(pid, signal);
    } catch (err) {
      say("stop", `kill ${pid} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
