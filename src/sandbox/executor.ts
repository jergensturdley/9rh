import { execFile } from "child_process";
import { promisify } from "util";
import type { SandboxConfig } from "./sandboxer.js";
import { Sandbox, isSandboxAvailable, getSandboxStatus, getDefaultSandboxConfig } from "./sandboxer.js";

const execFileAsync = promisify(execFile);

export interface ExecutionResult {
  output: string;
  error?: string;
  /**
   * Process exit code. `null` iff the process was killed by an OS signal
   * (see the `signal` field); for normal exits and timed-out processes
   * this holds the numeric code.
   */
  exitCode: number | null;
  /**
   * The OS signal that killed the process, if any. `null` for normal exits,
   * timeouts, and command-not-found style failures. Surfaced via Node's
   * `ChildProcess.execFile` rejection path so observers can distinguish
   * SIGKILL/SIGTERM from non-signal exits.
   */
  signal: NodeJS.Signals | null;
  /** True iff the process was killed by an OS signal (not a timeout). */
  killed: boolean;
  timedOut: boolean;
  durationMs: number;
  sandboxUsed: boolean;
  /** The timeoutMs the caller requested (or the default if none). */
  requestedTimeoutMs: number;
  /** The actual timeoutMs applied after the executor's cap. */
  effectiveTimeoutMs: number;
  /** True iff effectiveTimeoutMs < requestedTimeoutMs (cap was hit). */
  clampedTimeout: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
}

/** DirectExecutor-specific options. */
export interface DirectExecOptions extends ExecOptions {
  /**
   * Default cap (10 min). Pass `Infinity` to disable the cap entirely.
   * The `effectiveTimeoutMs` field on the result reflects what was used.
   */
  maxTimeoutMs?: number;
}

export interface SandboxProvider {
  exec(command: string, options?: ExecOptions): Promise<ExecutionResult>;
  validatePath(filePath: string): Promise<string>;
}

export class SandboxExecutor implements SandboxProvider {
  private sandbox: Sandbox;
  private config: Required<SandboxConfig>;
  private pathValidationCache = new Map<string, string>();

  constructor(workDir: string, sandboxConfig?: Partial<SandboxConfig>) {
    const cfg = getDefaultSandboxConfig(workDir);
    if (sandboxConfig) Object.assign(cfg, sandboxConfig);
    this.config = cfg as Required<SandboxConfig>;
    this.sandbox = new Sandbox(cfg);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecutionResult> {
    const requestedTimeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const result = await this.sandbox.exec(command, { timeoutMs: requestedTimeoutMs });
    const effectiveTimeoutMs = result.effectiveTimeoutMs ?? requestedTimeoutMs;
    const clampedTimeout = effectiveTimeoutMs < requestedTimeoutMs;
    return {
      output: result.stdout,
      error: result.exitCode !== 0 ? `exit ${result.exitCode}` : undefined,
      exitCode: result.exitCode,
      signal: result.signal,
      killed: result.killed,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      sandboxUsed: true,
      requestedTimeoutMs,
      effectiveTimeoutMs,
      clampedTimeout,
    };
  }

  async validatePath(filePath: string): Promise<string> {
    const cached = this.pathValidationCache.get(filePath);
    if (cached) return cached;
    const validated = await this.sandbox.validatePath(filePath);
    this.pathValidationCache.set(filePath, validated);
    return validated;
  }

  getProfile(): string {
    return this.sandbox.getProfile();
  }
}

export class DirectExecutor implements SandboxProvider {
  private workDir: string;
  private pathValidationCache = new Map<string, string>();

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  async exec(command: string, options?: DirectExecOptions): Promise<ExecutionResult> {
    const startMs = Date.now();
    const requestedTimeoutMs = options?.timeoutMs ?? 60_000;
    const maxTimeoutMs = options?.maxTimeoutMs ?? 600_000;
    const effectiveTimeoutMs = Math.min(requestedTimeoutMs, maxTimeoutMs);
    const clampedTimeout = effectiveTimeoutMs < requestedTimeoutMs;
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        cwd: this.workDir,
        timeout: effectiveTimeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
      return {
        output: out || "(no output)",
        exitCode: 0,
        signal: null,
        killed: false,
        timedOut: false,
        durationMs: Date.now() - startMs,
        sandboxUsed: false,
        requestedTimeoutMs,
        effectiveTimeoutMs,
        clampedTimeout,
      };
    } catch (err: unknown) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number;
        signal?: NodeJS.Signals;
      };
      const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      const sig = (e.signal ?? null) as NodeJS.Signals | null;
      const killed = sig !== null;
      return {
        output: combined || "(command failed)",
        error: killed ? `killed by signal ${sig}` : "exit non-zero",
        exitCode: killed ? null : (e.code ?? -1),
        signal: sig,
        killed,
        timedOut: false,
        durationMs: Date.now() - startMs,
        sandboxUsed: false,
        requestedTimeoutMs,
        effectiveTimeoutMs,
        clampedTimeout,
      };
    }
  }

  async validatePath(filePath: string): Promise<string> {
    const cached = this.pathValidationCache.get(filePath);
    if (cached) return cached;
    const { isAbsolute, resolve, relative } = await import("node:path");
    const { realpath } = await import("node:fs/promises");
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(this.workDir, filePath);
    // realpath follows symlinks. If the file doesn't exist yet, fall back
    // to the lexical path so write_file of a new file still validates.
    let realAbs: string;
    try {
      realAbs = await realpath(abs);
    } catch {
      realAbs = abs;
    }
    let realRoot: string;
    try {
      realRoot = await realpath(this.workDir);
    } catch {
      realRoot = resolve(this.workDir);
    }
    const rel = relative(realRoot, realAbs);
    const escapes = rel.startsWith("..") || isAbsolute(rel);
    if (escapes) {
      throw new Error(
        `path escapes sandbox workDir: ${filePath} (resolved ${realAbs})`,
      );
    }
    this.pathValidationCache.set(filePath, realAbs);
    return realAbs;
  }

  getProfile(): string {
    return "# no sandbox profile (direct execution)";
  }
}

export class ObservabilityCollector {
  private executions: ExecutionRecord[] = [];

  record(result: ExecutionResult, command: string): void {
    this.executions.push({
      timestamp: Date.now(),
      command,
      ...result,
    });
  }

  getHistory(): ExecutionRecord[] {
    return [...this.executions];
  }

  getSummary(): { total: number; sandboxed: number; direct: number; timedOut: number } {
    return this.executions.reduce(
      (acc, e) => ({
        total: acc.total + 1,
        sandboxed: acc.sandboxed + (e.sandboxUsed ? 1 : 0),
        direct: acc.direct + (e.sandboxUsed ? 0 : 1),
        timedOut: acc.timedOut + (e.timedOut ? 1 : 0),
      }),
      { total: 0, sandboxed: 0, direct: 0, timedOut: 0 },
    );
  }

  clear(): void {
    this.executions = [];
  }
}

interface ExecutionRecord extends ExecutionResult {
  timestamp: number;
  command: string;
}

export function createExecutor(
  workDir: string,
  opts: { useSandbox?: boolean; sandboxConfig?: Partial<SandboxConfig>; strict?: boolean } = {},
): SandboxProvider {
  if (opts.useSandbox) {
    if (isSandboxAvailable()) {
      const executor = new SandboxExecutor(workDir, {
        ...opts.sandboxConfig,
        warnOnProfileFallback: false,
      });
      if (executor.getProfile() !== "(version 1)(allow default)" || opts.sandboxConfig?.legacySandbox) {
        return executor;
      }
      if (opts.strict) {
        throw new Error(
          "Sandbox requested but restrictive macOS sandbox profile was rejected by sandbox-exec. " +
          "Refusing to fall back to direct execution in strict mode.",
        );
      }
      if (!createExecutor._warned) {
        process.stderr.write(
          `\n[9rh] WARNING: restrictive sandbox profile unavailable; falling back to DirectExecutor. ` +
          `run_bash will execute with full user permissions.\n\n`,
        );
        createExecutor._warned = true;
      }
      return new DirectExecutor(workDir);
    }
    // Sandbox was requested but isn't available. Two options:
    //   - strict=true  → throw, fail closed
    //   - strict=false (default) → warn + fall back to DirectExecutor
    if (opts.strict) {
      const status = getSandboxStatus();
      throw new Error(
        `Sandbox requested but unavailable: ${status.kind === "unavailable" ? status.reason : "unknown reason"}. ` +
        `Refusing to fall back to direct execution in strict mode.`,
      );
    }
    // Default: fall back with a one-time stderr warning. The agent
    // constructor also surfaces this via the sandbox_health event.
    if (!createExecutor._warned) {
      process.stderr.write(
        `\n[9rh] WARNING: sandbox unavailable; falling back to DirectExecutor. ` +
        `run_bash will execute with full user permissions. Set strict:true ` +
        `or run on macOS to enable isolation.\n\n`,
      );
      createExecutor._warned = true;
    }
  }
  return new DirectExecutor(workDir);
}
// Module-level flag to ensure the fallback warning only fires once.
createExecutor._warned = false;
