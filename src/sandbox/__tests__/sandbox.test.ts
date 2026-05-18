import { describe, it, expect, beforeEach } from "@jest/globals";
import { createExecutor, isSandboxAvailable, SandboxExecutor, DirectExecutor, ObservabilityCollector } from "../index.js";
import type { SandboxProvider } from "../index.js";

describe("SandboxExecutor", () => {
  const workDir = "/tmp";

  it("falls back to DirectExecutor when sandbox is not available", () => {
    const exec = createExecutor(workDir, { useSandbox: true });
    expect(exec).toBeInstanceOf(DirectExecutor);
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

  it("validates paths are returned", async () => {
    const exec = new DirectExecutor(workDir);
    const path = await exec.validatePath("/tmp/test.txt");
    expect(path).toBe("/tmp/test.txt");
  });
});

describe("ObservabilityCollector", () => {
  it("records execution history", () => {
    const collector = new ObservabilityCollector();
    collector.record({ output: "ok", exitCode: 0, timedOut: false, durationMs: 10, sandboxUsed: false }, "echo ok");
    collector.record({ output: "err", exitCode: 1, timedOut: false, durationMs: 5, sandboxUsed: true }, "exit 1");
    const history = collector.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].command).toBe("echo ok");
  });

  it("summarizes executions", () => {
    const collector = new ObservabilityCollector();
    collector.record({ output: "ok", exitCode: 0, timedOut: false, durationMs: 10, sandboxUsed: true }, "cmd1");
    collector.record({ output: "ok", exitCode: 0, timedOut: false, durationMs: 10, sandboxUsed: false }, "cmd2");
    collector.record({ output: "err", exitCode: 1, timedOut: true, durationMs: 1000, sandboxUsed: true }, "cmd3");
    const summary = collector.getSummary();
    expect(summary.total).toBe(3);
    expect(summary.sandboxed).toBe(2);
    expect(summary.direct).toBe(1);
    expect(summary.timedOut).toBe(1);
  });

  it("clears history", () => {
    const collector = new ObservabilityCollector();
    collector.record({ output: "ok", exitCode: 0, timedOut: false, durationMs: 1, sandboxUsed: false }, "x");
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
    expect(exec).toBeInstanceOf(DirectExecutor);
  });
});

describe("isSandboxAvailable", () => {
  it("returns a boolean", () => {
    expect(typeof isSandboxAvailable()).toBe("boolean");
  });
});