import { execFile } from "child_process";
import { promisify } from "util";
import type { SandboxConfig } from "./sandboxer.js";
import { Sandbox, isSandboxAvailable, getSandboxStatus, getDefaultSandboxConfig } from "./sandboxer.js";

const execFileAsync = promisify(execFile);

export interface ExecutionResult {
  output: string;
  error?: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  sandboxUsed: boolean;
}

export interface SandboxProvider {
  exec(command: string, options?: { timeoutMs?: number }): Promise<ExecutionResult>;
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

  async exec(command: string, options?: { timeoutMs?: number }): Promise<ExecutionResult> {
    const result = await this.sandbox.exec(command, { timeoutMs: options?.timeoutMs });
    return {
      output: result.stdout,
      error: result.exitCode !== 0 ? `exit ${result.exitCode}` : undefined,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      sandboxUsed: true,
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

  async exec(command: string, options?: { timeoutMs?: number }): Promise<ExecutionResult> {
    const startMs = Date.now();
    const timeoutMs = Math.min(options?.timeoutMs ?? 60_000, 120_000);
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        cwd: this.workDir,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
      return {
        output: out || "(no output)",
        exitCode: 0,
        timedOut: false,
        durationMs: Date.now() - startMs,
        sandboxUsed: false,
      };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      return {
        output: combined || "(command failed)",
        error: "exit non-zero",
        exitCode: e.code ?? -1,
        timedOut: false,
        durationMs: Date.now() - startMs,
        sandboxUsed: false,
      };
    }
  }

  async validatePath(_filePath: string): Promise<string> {
    const cached = this.pathValidationCache.get(_filePath);
    if (cached) return cached;
    this.pathValidationCache.set(_filePath, _filePath);
    return _filePath;
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
      return new SandboxExecutor(workDir, opts.sandboxConfig);
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
