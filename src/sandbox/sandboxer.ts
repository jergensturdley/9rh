import { spawn, execFileSync } from "child_process";
import { unlinkSync, writeFileSync } from "fs";
import { readlink, writeFile, lstat, realpath } from "fs/promises";
import { resolve, normalize, dirname } from "path";

export interface SandboxConfig {
  workDir: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  networkEnabled?: boolean;
  timeoutMs?: number;
  /**
   * Fall back to the original (allow default) sandbox profile instead
   * of the restrictive allowlisted one. Useful for tests and for
   * users running commands that need operations the restrictive
   * profile doesn't enumerate (e.g. specific mach lookups).
   */
  legacySandbox?: boolean;
  /** Suppress the low-level restrictive-profile downgrade warning. */
  warnOnProfileFallback?: boolean;
  /**
   * Maximum allowed `effectiveTimeoutMs` for sandboxed exec calls.
   * Default 600_000 (10 min). The caller can request any `timeoutMs`
   * per-call, but it will be clamped to this value. Set `Infinity`
   * to disable the cap. Surfaced on `ExecutionResult.effectiveTimeoutMs`
   * and `clampedTimeout` so callers can detect when their request was
   * silently reduced.
   */
  maxTimeoutMs?: number;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  durationMs: number;
  effectiveTimeoutMs: number;
}

interface SandboxProfile {
  create(workDir: string, allowedPaths: string[], networkEnabled: boolean, legacy: boolean, blanketReads: boolean): string;
}

const SBMAXOUTPUT = 1024 * 1024 * 4;

async function realworkDir(workDir: string): Promise<string> {
  return normalize(await realpath(workDir).catch(async () => readlink(workDir).catch(() => workDir)));
}

async function sandboxPath(rawPath: string, workDir: string): Promise<string> {
  const realWorkDir = await realworkDir(workDir);
  const abs = resolve(realWorkDir, rawPath);
  let normalized = normalize(abs);
  try {
    const stat = await lstat(normalized);
    if (stat.isSymbolicLink()) {
      const linkTarget = await readlink(normalized);
      normalized = normalize(resolve(dirname(normalized), linkTarget));
    }
  } catch {}
  if (!normalized.startsWith(realWorkDir + "/") && normalized !== realWorkDir) {
    throw new Error(`Path escapes workDir: ${rawPath}`);
  }
  return normalized;
}

function clampTimeout(timeoutMs: number, maxTimeoutMs: number = 600_000): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    return Math.min(1000, maxTimeoutMs);
  }
  return Math.min(timeoutMs, maxTimeoutMs);
}

// One-shot stderr notice when the strictest profile is downgraded by the
// host's sandbox-exec (e.g. macOS 26 SIGABRTs on file-read* subpath rules).
let _profileFallbackWarned = false;

function warnFallbackOnce(warn: boolean, message: string): void {
  if (!warn || _profileFallbackWarned) return;
  _profileFallbackWarned = true;
  process.stderr.write(message);
}

// Probe a candidate profile against the host's sandbox-exec. Returns true if
// the host accepts it. macOS 26 SIGABRTs (does not merely reject) on some
// constructs — notably `(allow file-read* (subpath ...))` — so we must
// actually run it rather than trust the profile is well-formed.
function probeProfile(profile: string): boolean {
  const probePath = `/tmp/9rh-sb-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`;
  try {
    writeFileSync(probePath, profile, "utf-8");
    execFileSync("/usr/bin/sandbox-exec", ["-f", probePath, "/usr/bin/true"], {
      timeout: 5000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(probePath); } catch {}
  }
}

function truncateOutput(s: string): string {
  if (s.length <= 1024 * 1024) return s;
  return s.slice(0, 1024 * 1024) + `\n...(truncated ${s.length - 1024 * 1024} chars)`;
}

class DarwinSandboxProfile implements SandboxProfile {
  /**
   * Build a restrictive macOS sandbox-exec profile.
   *
   * Defaults (matching `getDefaultSandboxConfig`):
   *   - network: DENIED (set `networkEnabled: true` to allow)
   *   - writes:  allowlisted to workDir, /tmp, /private/tmp
   *   - reads:   allowlisted to workDir, /usr, /bin, /sbin, /Library, /System, /dev, /etc
   *   - execution: sh, bash, node, and common tools under /usr/bin
   *
   * Returns `(allow default)` ONLY if the user explicitly set both
   * `networkEnabled: true` AND an empty `allowedPaths`. Otherwise the
   * profile is restrictive.
   *
   * `blanketReads`: emit `(allow file-read*)` (unrestricted reads) instead of
   * subpath-restricted reads. macOS 26's sandbox-exec SIGABRTs on
   * `(allow file-read* (subpath ...))`, so the Sandbox constructor retries
   * with this variant before giving up on isolation entirely. Writes stay
   * confined to the allowlist and network stays denied either way — the
   * containment that actually matters is preserved.
   */
  create(workDir: string, allowedPaths: string[], networkEnabled: boolean, legacy: boolean, blanketReads: boolean): string {
    // Fast path: caller opted out of the restrictive profile and wants
    // the original open behavior. Used by tests, and by users who set
    // `legacySandbox: true` to fall back to (allow default).
    if (legacy || (networkEnabled && (!allowedPaths || allowedPaths.length === 0))) {
      return `(version 1)(allow default)`;
    }
    const writeRoots = this._dedupePaths([
      workDir,
      "/tmp",
      "/private/tmp",
      "/private/var/folders",  // macOS per-user tmp
      "/dev",
      ...(allowedPaths ?? []),
    ]);
    const subpath = (p: string) => `(subpath "${this._escapeForQuote(p)}")`;
    const writeSubpaths = writeRoots.map(subpath).join(" ");
    const readClause = blanketReads
      ? "(allow file-read*)"
      : `(allow file-read* ${this._dedupePaths([
          workDir,
          "/usr",
          "/bin",
          "/sbin",
          "/Library",
          "/System",
          "/private/var",
          "/dev",
          "/etc",
          ...(allowedPaths ?? []),
        ]).map(subpath).join(" ")})`;
    const net = networkEnabled ? "" : `(deny network*)`;
    return `(version 1)
  (deny default)
  ${net}
  ; Allow process self-management (fork, exec, signal). Without
  ; process-exec the sandboxed shell cannot invoke any binary and
  ; every command returns no output. These permissions are needed
  ; even though we're not letting the process touch the network.
  (allow process-exec)
  (allow process-fork)
  (allow signal (target self))
  (allow sysctl-read)
  (allow mach-lookup)
  ${readClause}
  (allow file-write* ${writeSubpaths})`;
  }

  private _escapeForQuote(p: string): string {
    return p.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  private _dedupePaths(paths: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
      if (!p) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }
}

export class Sandbox {
  private config: Required<SandboxConfig>;
  private profile: string;
  private platform: string;

  constructor(config: SandboxConfig) {
    this.config = {
      workDir: config.workDir,
      allowedPaths: config.allowedPaths ?? [],
      deniedPaths: config.deniedPaths ?? [],
      networkEnabled: config.networkEnabled ?? false,
      timeoutMs: config.timeoutMs ?? 60_000,
      legacySandbox: config.legacySandbox ?? false,
      warnOnProfileFallback: config.warnOnProfileFallback ?? true,
      maxTimeoutMs: config.maxTimeoutMs ?? 600_000,
    };
    this.platform = process.platform;
    this.profile = this._resolveProfile();
  }

  /**
   * Pick the strongest profile the host actually accepts, degrading in steps:
   *   1. strict     — subpath-restricted reads AND writes, network denied
   *   2. blanketRead — unrestricted reads, subpath writes, network denied
   *                    (macOS 26 SIGABRTs on file-read* subpath rules)
   *   3. allow-all   — no isolation (only if even blanket reads are rejected)
   * Non-darwin and legacy/allow-default profiles skip probing.
   */
  private _resolveProfile(): string {
    const { workDir, allowedPaths, networkEnabled, legacySandbox, warnOnProfileFallback } = this.config;
    const builder = new DarwinSandboxProfile();
    const strict = builder.create(workDir, allowedPaths, networkEnabled, legacySandbox, false);
    if (process.platform !== "darwin" || strict === "(version 1)(allow default)") {
      return strict;
    }
    if (probeProfile(strict)) return strict;

    const blanketRead = builder.create(workDir, allowedPaths, networkEnabled, legacySandbox, true);
    if (probeProfile(blanketRead)) {
      warnFallbackOnce(
        warnOnProfileFallback,
        "\n[9rh] NOTICE: this host rejects file-read* subpath rules (e.g. macOS 26); " +
        "using a profile with unrestricted reads. Writes stay confined to the workDir " +
        "and network is denied — the containment that matters is preserved.\n\n",
      );
      return blanketRead;
    }

    warnFallbackOnce(
      warnOnProfileFallback,
      "\n[9rh] WARNING: no restrictive sandbox profile accepted by sandbox-exec on this host; " +
      "strict command isolation is unavailable. Set legacySandbox:true to silence this, " +
      "or use createExecutor({strict:true}) to fail closed instead of running unsandboxed.\n\n",
    );
    return "(version 1)(allow default)";
  }

  async validatePath(filePath: string): Promise<string> {
    return sandboxPath(filePath, this.config.workDir);
  }

  getProfile(): string {
    return this.profile;
  }

  async exec(command: string, options?: { timeoutMs?: number; env?: Record<string, string> }): Promise<SpawnResult> {
    return this.execInSandbox(command, options);
  }

  async execWithRetry(
    command: string,
    options?: { timeoutMs?: number; maxRetries?: number },
  ): Promise<SpawnResult> {
    const maxRetries = options?.maxRetries ?? 1;
    let lastResult: SpawnResult | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.exec(command, { timeoutMs: options?.timeoutMs });
      lastResult = result;

      if (result.exitCode === 0 && !result.timedOut) {
        return result;
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 500));
      }
    }

    return lastResult!;
  }

  private async execInSandbox(
    command: string,
    options?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<SpawnResult> {
    const requestedTimeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const effectiveTimeoutMs = clampTimeout(requestedTimeoutMs, this.config.maxTimeoutMs);
    const startMs = Date.now();
    let timedOut = false;

    if (!isSandboxAvailable()) {
      return {
        stdout: "",
        stderr: `sandbox execution is unavailable on ${this.platform}; use createExecutor() to fall back to direct execution explicitly`,
        exitCode: -1,
        signal: null,
        killed: false,
        timedOut: false,
        durationMs: Date.now() - startMs,
        effectiveTimeoutMs,
      };
    }

    const profilePath = `/tmp/9rh-sandbox-${Date.now()}.sb`;
    try {
      await writeFile(profilePath, this.profile, "utf-8");
    } catch {
      return {
        stdout: "",
        stderr: "failed to write sandbox profile",
        exitCode: -1,
        signal: null,
        killed: false,
        timedOut: false,
        durationMs: Date.now() - startMs,
        effectiveTimeoutMs,
      };
    }

    return new Promise((resolve) => {
      const proc = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, "sh", "-c", command], {
        cwd: this.config.workDir,
        env: { ...process.env, ...options?.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk) => {
        if (stdout.length < SBMAXOUTPUT) stdout += chunk.toString();
      });

      proc.stderr?.on("data", (chunk) => {
        if (stderr.length < SBMAXOUTPUT) stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, effectiveTimeoutMs);

      proc.on("close", (code, signal) => {
        try { unlinkSync(profilePath); } catch {}
        clearTimeout(timer);
        const sig = (signal ?? null) as NodeJS.Signals | null;
        const killed = sig !== null;
        if ((code ?? -1) !== 0 && process.env["9RH_SANDBOX_DEBUG"]) {
          process.stderr.write(`[9rh-sandbox-debug] exit=${code} signal=${signal} stderr=${truncateOutput(stderr)}\n`);
        }
        if (code === null && sig) {
          stderr = (stderr ? stderr + "\n" : "") + `sandbox-exec killed by signal=${sig}`;
        }
        resolve({
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          exitCode: code ?? -1,
          signal: sig,
          killed,
          timedOut,
          durationMs: Date.now() - startMs,
          effectiveTimeoutMs,
        });
      });

      proc.on("error", (err) => {
        try { unlinkSync(profilePath); } catch {}
        clearTimeout(timer);
        resolve({
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr) + "\nsandbox-exec error: " + err.message,
          exitCode: -1,
          signal: null,
          killed: false,
          timedOut: false,
          durationMs: Date.now() - startMs,
          effectiveTimeoutMs,
        });
      });
    });
  }
}

/**
 * Richer sandbox status. Use this to give the user actionable feedback
 * when sandboxing is requested but not available.
 */
export type SandboxStatus =
  | { kind: "available"; backend: "darwin-sandbox-exec" }
  | { kind: "unavailable"; reason: string; platform: NodeJS.Platform };

// Cached results so callers inside async/hot paths don't pay a
// synchronous execFileSync penalty on every invocation.
let _sandboxAvailableCache: boolean | null = null;
let _sandboxStatusCache: SandboxStatus | null = null;

export function isSandboxAvailable(): boolean {
  if (_sandboxAvailableCache !== null) return _sandboxAvailableCache;
  if (process.platform === "darwin") {
    try {
      execFileSync(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        { timeout: 5000 },
      );
      _sandboxAvailableCache = true;
      return true;
    } catch {
      _sandboxAvailableCache = false;
      return false;
    }
  }
  _sandboxAvailableCache = false;
  return false;
}

export function getSandboxStatus(): SandboxStatus {
  if (_sandboxStatusCache !== null) return _sandboxStatusCache;
  const platform = process.platform as NodeJS.Platform;
  if (platform === "darwin") {
    try {
      execFileSync(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        { timeout: 5000 },
      );
      _sandboxStatusCache = { kind: "available", backend: "darwin-sandbox-exec" };
      return _sandboxStatusCache;
    } catch (e) {
      _sandboxStatusCache = {
        kind: "unavailable",
        reason: `sandbox-exec probe failed: ${(e as Error).message}`,
        platform,
      };
      return _sandboxStatusCache;
    }
  }
  _sandboxStatusCache = {
    kind: "unavailable",
    reason:
      `9rh relies on macOS sandbox-exec for command isolation, but you are ` +
      `running on ${platform}. Commands will run with full user permissions ` +
      `unless you run 9rh on macOS, or use a tool that provides OS-level ` +
      `isolation (Docker, firejail, bubblewrap).`,
    platform,
  };
  return _sandboxStatusCache;
}

/**
 * Build the raw darwin sandbox-exec profile text without probing the host.
 * Exposed for deterministic testing of profile generation (the Sandbox
 * constructor's chosen profile is host-dependent).
 */
export function buildDarwinProfile(opts: {
  workDir: string;
  allowedPaths?: string[];
  networkEnabled?: boolean;
  legacySandbox?: boolean;
  blanketReads?: boolean;
}): string {
  return new DarwinSandboxProfile().create(
    opts.workDir,
    opts.allowedPaths ?? [],
    opts.networkEnabled ?? false,
    opts.legacySandbox ?? false,
    opts.blanketReads ?? false,
  );
}

export function getDefaultSandboxConfig(workDir: string): SandboxConfig {
  return {
    workDir,
    networkEnabled: false,
    timeoutMs: 60_000,
  };
}
