import { execFile } from "child_process";
import { promisify } from "util";
import type { ExecutionResult, SandboxProvider } from "./executor.js";

const execFileAsync = promisify(execFile);

export type ContainerProvider = "apple-container" | "docker" | "podman";

export interface ContainerSessionConfig {
  provider: ContainerProvider;
  image: string;
  hostWorkDir: string;
  containerWorkDir?: string;
  networkEnabled?: boolean;
  timeoutMs?: number;
}

export interface ContainerStatus {
  backend: ContainerProvider;
  image: string;
  containerName: string;
  hostWorkDir: string;
  containerWorkDir: string;
  networkEnabled: boolean;
  running: boolean;
}

export type ContainerAction =
  | {
      action: "start";
      name: string;
      image: string;
      hostWorkDir: string;
      containerWorkDir: string;
      networkEnabled: boolean;
    }
  | { action: "exec"; name: string; command: string }
  | { action: "stop"; name: string };

export interface ContainerRunnerResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
}

export type ContainerRunner = (
  bin: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<ContainerRunnerResult>;

const providerBins: Record<ContainerProvider, string> = {
  "apple-container": "container",
  docker: "docker",
  podman: "podman",
};

export function buildDockerArgs(action: ContainerAction): string[] {
  if (action.action === "exec") return ["exec", action.name, "sh", "-lc", action.command];
  if (action.action === "stop") return ["rm", "-f", action.name];

  return [
    "run",
    "-d",
    "--name",
    action.name,
    "--network",
    action.networkEnabled ? "bridge" : "none",
    "-v",
    `${action.hostWorkDir}:${action.containerWorkDir}`,
    "-w",
    action.containerWorkDir,
    action.image,
    "tail",
    "-f",
    "/dev/null",
  ];
}

export function buildPodmanArgs(action: ContainerAction): string[] {
  return buildDockerArgs(action);
}

export function buildAppleContainerArgs(action: ContainerAction): string[] {
  if (action.action !== "start") return buildDockerArgs(action);

  return [
    "run",
    "--detach",
    "--name",
    action.name,
    "--volume",
    `${action.hostWorkDir}:${action.containerWorkDir}`,
    "--workdir",
    action.containerWorkDir,
    action.networkEnabled ? "--network" : "--no-network",
    action.image,
    "tail",
    "-f",
    "/dev/null",
  ];
}

export class ContainerSessionExecutor implements SandboxProvider {
  private readonly config: Required<ContainerSessionConfig>;
  private readonly runner: ContainerRunner;
  private readonly containerName: string;
  private readonly pathValidationCache = new Map<string, string>();
  private running = false;

  constructor(config: ContainerSessionConfig, runner: ContainerRunner = runProvider, containerName = `9rh-${process.pid}`) {
    this.config = {
      containerWorkDir: "/workspace",
      networkEnabled: false,
      timeoutMs: 60_000,
      ...config,
    };
    this.runner = runner;
    this.containerName = containerName;
  }

  async exec(command: string, options?: { timeoutMs?: number }): Promise<ExecutionResult> {
    const startMs = Date.now();
    const timeout = Math.min(options?.timeoutMs ?? this.config.timeoutMs, 120_000);

    if (!this.running) {
      const started = await this.run({ action: "start", name: this.containerName, ...this.config }, timeout);
      if (started.exitCode !== 0) return this.toExecutionResult(started, startMs);
      this.running = true;
    }

    const result = await this.run({ action: "exec", name: this.containerName, command }, timeout);
    return this.toExecutionResult(result, startMs);
  }

  async validatePath(filePath: string): Promise<string> {
    const cached = this.pathValidationCache.get(filePath);
    if (cached) return cached;
    this.pathValidationCache.set(filePath, filePath);
    return filePath;
  }

  async stopSession(): Promise<void> {
    if (!this.running) return;
    await this.run({ action: "stop", name: this.containerName }, this.config.timeoutMs);
    this.running = false;
  }

  describeStatus(): ContainerStatus {
    return {
      backend: this.config.provider,
      image: this.config.image,
      containerName: this.containerName,
      hostWorkDir: this.config.hostWorkDir,
      containerWorkDir: this.config.containerWorkDir,
      networkEnabled: this.config.networkEnabled,
      running: this.running,
    };
  }

  private async run(action: ContainerAction, timeout: number): Promise<ContainerRunnerResult> {
    const bin = providerBins[this.config.provider];
    const args = this.buildArgs(action);
    try {
      return await this.runner(bin, args, { timeout });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number; killed?: boolean };
      return {
        stdout: e.stdout,
        stderr: [e.stderr, e.message].filter(Boolean).join("\n"),
        exitCode: e.code ?? -1,
        timedOut: e.killed ?? false,
      };
    }
  }

  private buildArgs(action: ContainerAction): string[] {
    if (this.config.provider === "podman") return buildPodmanArgs(action);
    if (this.config.provider === "apple-container") return buildAppleContainerArgs(action);
    return buildDockerArgs(action);
  }

  private toExecutionResult(result: ContainerRunnerResult, startMs: number): ExecutionResult {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exitCode = result.exitCode ?? 0;
    return {
      output: output || "(no output)",
      error: exitCode === 0 ? undefined : "exit non-zero",
      exitCode,
      timedOut: result.timedOut ?? false,
      durationMs: Date.now() - startMs,
      sandboxUsed: true,
    };
  }
}

async function runProvider(bin: string, args: string[], options?: { timeout?: number }): Promise<ContainerRunnerResult> {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: options?.timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  return { stdout, stderr, exitCode: 0 };
}
