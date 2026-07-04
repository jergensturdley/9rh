import { describe, it, expect, beforeEach } from "@jest/globals";
import { symlinkSync, unlinkSync, writeFileSync } from "fs";
import { realpathSync } from "fs";
import { createExecutor, isSandboxAvailable, SandboxExecutor, DirectExecutor, ObservabilityCollector } from "../index.js";
import type { SandboxProvider, ExecutionResult } from "../index.js";

describe("SandboxExecutor", () => {
  const workDir = "/tmp";

  it("selects the executor that matches platform sandbox availability", () => {
    const exec = createExecutor(workDir, { useSandbox: true });
    if (!isSandboxAvailable()) {
      expect(exec).toBeInstanceOf(DirectExecutor);
      return;
    }
    const probe = new SandboxExecutor(workDir);
    expect(exec).toBeInstanceOf(probe.getProfile() === "(version 1)(allow default)" ? DirectExecutor : SandboxExecutor);
  });

  it("executes through SandboxExecutor when sandbox-exec is available", async () => {
    if (!isSandboxAvailable()) return;
    const exec = new SandboxExecutor(workDir, { legacySandbox: true });
    const result = await exec.exec("echo sandbox-ok");
    expect(result.sandboxUsed).toBe(true);
    expect(result.output).toContain("sandbox-ok");
    expect(result.exitCode).toBe(0);
  });

  it("returns sandboxUsed false when not sandboxed", async () => {
    const exec = new DirectExecutor(workDir);
    const result = await exec.exec("echo hello");
    expect(result.sandboxUsed).toBe(false);
    expect(result.output).toContain("hello");
  });
});

describe("DirectExecutor", () => {
  const workDir = "/tmp";

  it("executes a simple command", async () => {
    const exec = new DirectExecutor(workDir);
    const result = await exec.exec("echo hello world");
    expect(result.output).toContain("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.sandboxUsed).toBe(false);
  });

  it("captures stderr from non-zero exit commands", async () => {
    const exec = new DirectExecutor(workDir);
    const result = await exec.exec("sh -c 'echo error >&2; exit 1'");
    expect(result.error).toBe("exit non-zero");
    expect(result.exitCode).toBe(1);
  });

  it("returns a timedOut boolean field", async () => {
    const exec = new DirectExecutor(workDir);
    const result = await exec.exec("echo hello");
    expect(typeof result.timedOut).toBe("boolean");
  });

  it("returns exit code on failure", async () => {
    const exec = new DirectExecutor(workDir);
    const result = await exec.exec("exit 42");
    expect(result.exitCode).toBe(42);
  });
});

describe("ObservabilityCollector", () => {
  it("records execution history", () => {
    const collector = new ObservabilityCollector();
    collector.record({ output: "ok", exitCode: 0, signal: null, killed: false, timedOut: false, durationMs: 10, sandboxUsed: false, requestedTimeoutMs: 60000, effectiveTimeoutMs: 60000, clampedTimeout: false }, "echo ok");
    collector.record({ output: "err", exitCode: 1, signal: null, killed: false, timedOut: false, durationMs: 5, sandboxUsed: true, requestedTimeoutMs: 60000, effectiveTimeoutMs: 60000, clampedTimeout: false }, "exit 1");
    const history = collector.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].command).toBe("echo ok");
  });

  it("summarizes executions", () => {
    const collector = new ObservabilityCollector();
    collector.record({ output: "ok", exitCode: 0, signal: null, killed: false, timedOut: false, durationMs: 10, sandboxUsed: true, requestedTimeoutMs: 60000, effectiveTimeoutMs: 60000, clampedTimeout: false }, "cmd1");
    collector.record({ output: "ok", exitCode: 0, signal: null, killed: false, timedOut: false, durationMs: 10, sandboxUsed: false, requestedTimeoutMs: 60000, effectiveTimeoutMs: 60000, clampedTimeout: false }, "cmd2");
    collector.record({ output: "err", exitCode: 1, signal: null, killed: false, timedOut: true, durationMs: 1000, sandboxUsed: true, requestedTimeoutMs: 60000, effectiveTimeoutMs: 60000, clampedTimeout: false }, "cmd3");
    const summary = collector.getSummary();
    expect(summary.total).toBe(3);
    expect(summary.sandboxed).toBe(2);
    expect(summary.direct).toBe(1);
    expect(summary.timedOut).toBe(1);
  });

  it("clears history", () => {
    const collector = new ObservabilityCollector();
    collector.record({ output: "ok", exitCode: 0, signal: null, killed: false, timedOut: false, durationMs: 1, sandboxUsed: false, requestedTimeoutMs: 60000, effectiveTimeoutMs: 60000, clampedTimeout: false }, "x");
    collector.clear();
    expect(collector.getHistory()).toHaveLength(0);
  });
});

describe("createExecutor", () => {
  it("returns DirectExecutor when useSandbox is false", () => {
    const exec = createExecutor("/tmp", { useSandbox: false });
    expect(exec).toBeInstanceOf(DirectExecutor);
  });

  it("returns SandboxExecutor when sandbox is available", () => {
    const exec = createExecutor("/tmp", { useSandbox: true });
    if (!isSandboxAvailable()) {
      expect(exec).toBeInstanceOf(DirectExecutor);
      return;
    }
    const probe = new SandboxExecutor("/tmp");
    expect(exec).toBeInstanceOf(probe.getProfile() === "(version 1)(allow default)" ? DirectExecutor : SandboxExecutor);
  });

  it("falls back to direct execution when the restrictive profile is rejected", () => {
    if (!isSandboxAvailable()) return;
    const probe = new SandboxExecutor("/tmp");
    if (probe.getProfile() !== "(version 1)(allow default)") return;

    const exec = createExecutor("/tmp", { useSandbox: true });
    expect(exec).toBeInstanceOf(DirectExecutor);
  });
});

describe("isSandboxAvailable", () => {
  it("returns a boolean", () => {
    expect(typeof isSandboxAvailable()).toBe("boolean");
  });
});

// ────────────────────────────────────────────────────────────────────
// audit-fix A3 — signal handling in DirectExecutor
// ────────────────────────────────────────────────────────────────────
describe("DirectExecutor — signal handling (audit A3)", () => {
  it("does not flag benign 'Killed: …' output as a signal kill", async () => {
    const exec = new DirectExecutor("/tmp");
    const result = await exec.exec("echo 'Killed: 42 enemies defeated in battle'");
    expect(result.killed).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it("does not flag benign 'Terminated: …' output as a signal kill", async () => {
    const exec = new DirectExecutor("/tmp");
    const result = await exec.exec("echo 'Terminated: session timed out gracefully'");
    expect(result.killed).toBe(false);
    expect(result.signal).toBeNull();
  });

  it("captures a real OS-signal kill (SIGKILL via `kill -9 $$`)", async () => {
    const exec = new DirectExecutor("/tmp");
    // `kill -9 $$` sends SIGKILL to the shell itself; the execFileAsync
    // wrapper's rejection then exposes e.signal as 'SIGKILL'.
    const result = await exec.exec("kill -9 $$");
    expect(result.killed).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/killed by signal SIGKILL/);
  });
});

// ────────────────────────────────────────────────────────────────────
// audit-fix A2 — symlink-aware path validation in DirectExecutor
// ────────────────────────────────────────────────────────────────────
describe("DirectExecutor — symlink path validation (audit A2)", () => {
  it("rejects a symlink whose target escapes workDir", async () => {
    const linkPath = `/tmp/9rh-symlink-test-${process.pid}-${Date.now()}`;
    symlinkSync("/etc", linkPath);
    try {
      const exec = new DirectExecutor("/tmp");
      await expect(exec.validatePath(linkPath)).rejects.toThrow(/escapes sandbox/);
    } finally {
      try { unlinkSync(linkPath); } catch {}
    }
  });

  it("returns the realpath of a regular file inside workDir", async () => {
    const tmpFile = `/tmp/9rh-validate-${process.pid}-${Date.now()}.txt`;
    writeFileSync(tmpFile, "hi");
    try {
      const exec = new DirectExecutor("/tmp");
      const result = await exec.validatePath(tmpFile);
      expect(result).toBe(realpathSync(tmpFile));
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// audit-fix A1 — timeout clamp visibility on the sandbox path
// ────────────────────────────────────────────────────────────────────
describe("SandboxExecutor — timeout clamp visibility (audit A1)", () => {
  it("surfaces clampedTimeout=false when maxTimeoutMs allows the requested budget", async () => {
    const executor = new SandboxExecutor("/tmp", { maxTimeoutMs: 1_000_000 });
    const result = await executor.exec("echo hi", { timeoutMs: 10 * 60 * 1000 });
    expect(result.requestedTimeoutMs).toBe(10 * 60 * 1000);
    expect(result.clampedTimeout).toBe(false);
    expect(result.effectiveTimeoutMs).toBe(10 * 60 * 1000);
  });

  it("surfaces clampedTimeout=true when the default cap clamps a long request", async () => {
    const executor = new SandboxExecutor("/tmp"); // default cap is 600_000
    const result = await executor.exec("echo hi", { timeoutMs: 30 * 60 * 1000 });
    expect(result.requestedTimeoutMs).toBe(30 * 60 * 1000);
    expect(result.clampedTimeout).toBe(true);
    expect(result.effectiveTimeoutMs).toBeLessThanOrEqual(600_000);
  });
});
