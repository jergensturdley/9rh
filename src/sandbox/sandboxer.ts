import { spawn, execFileSync } from "child_process";
import { unlinkSync, writeFileSync } from "fs";
import { readlink, writeFile, lstat, realpath } from "fs/promises";
import { resolve, normalize, dirname } from "path";

export interface SandboxConfig {
  workDir: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  networkEnabled?: boolean;
  maxMemoryMB?: number;
  maxCPUMs?: number;
  timeoutMs?: number;
  user?: string;
  /**
   * Fall back to the original (allow default) sandbox profile instead
   * of the restrictive allowlisted one. Useful for tests and for
   * users running commands that need operations the restrictive
   * profile doesn't enumerate (e.g. specific mach lookups).
   */
  legacySandbox?: boolean;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

interface SandboxProfile {
  create(workDir: string, allowedPaths: string[], networkEnabled: boolean, legacy: boolean): string;
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

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) return 1000;
  if (timeoutMs > 120_000) return 120_000;
  return timeoutMs;
}

// One-shot stderr warning when the restrictive profile is rejected by the
// host's sandbox-exec (e.g. macOS 26 SIGABRTs on file-read* subpath rules).
let _legacyFallbackWarned = false;

function probeOrFallback(profile: string): string {
  const probePath = `/tmp/9rh-sb-probe-${process.pid}-${Date.now()}.sb`;
  try {
    writeFileSync(probePath, profile, "utf-8");
    execFileSync("/usr/bin/sandbox-exec", ["-f", probePath, "/usr/bin/true"], {
      timeout: 5000,
      stdio: "ignore",
    });
    return profile;
  } catch {
    if (!_legacyFallbackWarned) {
      process.stderr.write(
        "\n[9rh] WARNING: restrictive sandbox profile rejected by sandbox-exec on this host; " +
        "falling back to (allow default). run_bash will execute with full user permissions. " +
        "Set legacySandbox:true explicitly to suppress this probe.\n\n",
      );
      _legacyFallbackWarned = true;
    }
    return "(version 1)(allow default)";
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
   */
  create(workDir: string, allowedPaths: string[], networkEnabled: boolean, legacy: boolean): string {
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
    const readRoots = this._dedupePaths([
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
    ]);
    const subpath = (p: string) => `(subpath "${this._escapeForQuote(p)}")`;
    const writeSubpaths = writeRoots.map(subpath).join(" ");
    const readSubpaths = readRoots.map(subpath).join(" ");
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
  (allow file-read* ${readSubpaths})
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
      maxMemoryMB: config.maxMemoryMB ?? 512,
      maxCPUMs: config.maxCPUMs ?? 30_000,
      timeoutMs: config.timeoutMs ?? 60_000,
      user: config.user ?? "nobody",
      legacySandbox: config.legacySandbox ?? false,
    };
    this.platform = process.platform;
    const profileBuilder = new DarwinSandboxProfile();
    this.profile = profileBuilder.create(
      this.config.workDir,
      this.config.allowedPaths,
      this.config.networkEnabled,
      this.config.legacySandbox,
    );
    if (process.platform === "darwin" && this.profile !== "(version 1)(allow default)") {
      this.profile = probeOrFallback(this.profile);
    }
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
    const timeoutMs = clampTimeout(options?.timeoutMs ?? this.config.timeoutMs);
    const startMs = Date.now();
    let timedOut = false;

    if (!isSandboxAvailable()) {
      return {
        stdout: "",
        stderr: `sandbox execution is unavailable on ${this.platform}; use createExecutor() to fall back to direct execution explicitly`,
        exitCode: -1,
        timedOut: false,
        durationMs: Date.now() - startMs,
      };
    }

    const profilePath = `/tmp/9rh-sandbox-${Date.now()}.sb`;
    try {
      await writeFile(profilePath, this.profile, "utf-8");
    } catch {
      return { stdout: "", stderr: "failed to write sandbox profile", exitCode: -1, timedOut: false, durationMs: Date.now() - startMs };
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
      }, timeoutMs);

      proc.on("close", (code, signal) => {
        try { unlinkSync(profilePath); } catch {}
        clearTimeout(timer);
        if ((code ?? -1) !== 0 && process.env["9RH_SANDBOX_DEBUG"]) {
          process.stderr.write(`[9rh-sandbox-debug] exit=${code} signal=${signal} stderr=${truncateOutput(stderr)}\n`);
        }
        if (code === null && signal) {
          stderr = (stderr ? stderr + "\n" : "") + `sandbox-exec killed by signal=${signal}`;
        }
        resolve({
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          exitCode: code ?? -1,
          timedOut,
          durationMs: Date.now() - startMs,
        });
      });

      proc.on("error", (err) => {
        try { unlinkSync(profilePath); } catch {}
        clearTimeout(timer);
        resolve({
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr) + "\nsandbox-exec error: " + err.message,
          exitCode: -1,
          timedOut: false,
          durationMs: Date.now() - startMs,
        });
      });
    });
  }
}

export function isSandboxAvailable(): boolean {
  if (process.platform === "darwin") {
    try {
      execFileSync(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        { timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Richer sandbox status. Use this to give the user actionable feedback
 * when sandboxing is requested but not available.
 */
export type SandboxStatus =
  | { kind: "available"; backend: "darwin-sandbox-exec" }
  | { kind: "unavailable"; reason: string; platform: NodeJS.Platform };

export function getSandboxStatus(): SandboxStatus {
  const platform = process.platform as NodeJS.Platform;
  if (platform === "darwin") {
    try {
      execFileSync(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        { timeout: 5000 },
      );
      return { kind: "available", backend: "darwin-sandbox-exec" };
    } catch (e) {
      return {
        kind: "unavailable",
        reason: `sandbox-exec probe failed: ${(e as Error).message}`,
        platform,
      };
    }
  }
  return {
    kind: "unavailable",
    reason:
      `9rh relies on macOS sandbox-exec for command isolation, but you are ` +
      `running on ${platform}. Commands will run with full user permissions ` +
      `unless you run 9rh on macOS, or use a tool that provides OS-level ` +
      `isolation (Docker, firejail, bubblewrap).`,
    platform,
  };
}

export function getDefaultSandboxConfig(workDir: string): SandboxConfig {
  return {
    workDir,
    networkEnabled: false,
    maxMemoryMB: 512,
    maxCPUMs: 30_000,
    timeoutMs: 60_000,
  };
}
