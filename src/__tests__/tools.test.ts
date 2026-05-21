import { describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { TOOL_DEFINITIONS, executeTool } from "../tools.js";
import type { ExecutionResult, SandboxProvider } from "../sandbox/index.js";

function makeMockExecutor(overrides: Partial<ExecutionResult> = {}): SandboxProvider {
  const result: ExecutionResult = {
    output: overrides.output ?? "executor output",
    error: overrides.error,
    exitCode: overrides.exitCode ?? 0,
    timedOut: overrides.timedOut ?? false,
    durationMs: overrides.durationMs ?? 5,
    sandboxUsed: overrides.sandboxUsed ?? true,
  };
  return {
    exec: jest.fn<SandboxProvider["exec"]>().mockResolvedValue(result),
    validatePath: jest.fn<SandboxProvider["validatePath"]>().mockResolvedValue("/safe/path"),
  };
}

describe("executeTool run_bash with executor", () => {
  it("routes through executor.exec instead of spawning directly", async () => {
    const executor = makeMockExecutor({ output: "sandboxed" });
    const result = await executeTool("run_bash", { command: "echo hi" }, "/workdir", { executor });

    expect(executor.exec).toHaveBeenCalledWith("echo hi", { timeoutMs: expect.any(Number) });
    expect(result.output).toBe("sandboxed");
  });

  it("calls onBashResult with the ExecutionResult and command", async () => {
    const execResult: ExecutionResult = {
      output: "hello",
      exitCode: 0,
      timedOut: false,
      durationMs: 3,
      sandboxUsed: true,
    };
    const executor: SandboxProvider = {
      exec: jest.fn<SandboxProvider["exec"]>().mockResolvedValue(execResult),
      validatePath: jest.fn<SandboxProvider["validatePath"]>().mockResolvedValue("/safe/path"),
    };
    const onBashResult = jest.fn<(r: ExecutionResult, cmd: string) => void>();

    await executeTool("run_bash", { command: "echo hello" }, "/workdir", {
      executor,
      onBashResult,
    });

    expect(onBashResult).toHaveBeenCalledTimes(1);
    expect(onBashResult).toHaveBeenCalledWith(execResult, "echo hello");
  });

  it("propagates executor error field to ToolResult.error", async () => {
    const executor = makeMockExecutor({ output: "crash", error: "exit non-zero", exitCode: 1 });
    const result = await executeTool("run_bash", { command: "false" }, "/workdir", { executor });

    expect(result.error).toBe("exit non-zero");
    expect(result.output).toBe("crash");
  });

  it("clamps timeout_ms before passing to executor", async () => {
    const executor = makeMockExecutor();
    await executeTool(
      "run_bash",
      { command: "echo hi", timeout_ms: 999_999_999 },
      "/workdir",
      { executor },
    );

    const [, opts] = (executor.exec as ReturnType<typeof jest.fn>).mock.calls[0] as [
      string,
      { timeoutMs: number },
    ];
    expect(opts.timeoutMs).toBeLessThanOrEqual(120_000);
  });

  it("does not call onBashResult when executor throws", async () => {
    const executor: SandboxProvider = {
      exec: jest.fn<SandboxProvider["exec"]>().mockRejectedValue(new Error("sandbox crashed")),
      validatePath: jest.fn<SandboxProvider["validatePath"]>().mockResolvedValue("/safe/path"),
    };
    const onBashResult = jest.fn<(r: ExecutionResult, cmd: string) => void>();

    const result = await executeTool("run_bash", { command: "echo hi" }, "/workdir", {
      executor,
      onBashResult,
    });

    expect(result.error).toContain("sandbox crashed");
    expect(onBashResult).not.toHaveBeenCalled();
  });
});

describe("executeTool run_bash without executor", () => {
  it("falls back to direct shell execution", async () => {
    const result = await executeTool("run_bash", { command: "echo direct" }, process.cwd());
    expect(result.output).toContain("direct");
    expect(result.error).toBeUndefined();
  });

  it("does not call onBashResult when executor is absent", async () => {
    const onBashResult = jest.fn<(r: ExecutionResult, cmd: string) => void>();
    await executeTool("run_bash", { command: "echo hi" }, process.cwd(), { onBashResult });
    expect(onBashResult).not.toHaveBeenCalled();
  });
});

describe("executeTool non-bash tools", () => {
  it("read_file does not invoke executor", async () => {
    const executor = makeMockExecutor();
    const result = await executeTool("read_file", { path: "nonexistent_xyz.txt" }, process.cwd(), {
      executor,
    });
    expect(result.error).toBeDefined();
    expect(executor.exec).not.toHaveBeenCalled();
  });

  it("returns unknown tool error for unrecognised names", async () => {
    const result = await executeTool("unknown_tool", {}, process.cwd());
    expect(result.error).toBe("Unknown tool: unknown_tool");
  });

  it("exposes CodeGraph tools to the agent", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining([
      "codegraph_search",
      "codegraph_context",
      "codegraph_files",
      "codegraph_affected",
      "codegraph_status",
    ]));
  });

  it("validates required CodeGraph tool inputs before invoking codegraph", async () => {
    await expect(executeTool("codegraph_search", {}, process.cwd())).resolves.toMatchObject({
      output: "",
      error: "codegraph_search requires query",
    });
    await expect(executeTool("codegraph_context", {}, process.cwd())).resolves.toMatchObject({
      output: "",
      error: "codegraph_context requires task",
    });
    await expect(executeTool("codegraph_affected", { files: [] }, process.cwd())).resolves.toMatchObject({
      output: "",
      error: "codegraph_affected requires files",
    });
  });

  it("refuses to read through a symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "9rh-tools-"));
    try {
      await writeFile(join(dir, "target.txt"), "secret", "utf-8");
      await symlink(join(dir, "target.txt"), join(dir, "link.txt"));

      const result = await executeTool("read_file", { path: "link.txt" }, dir);

      expect(result.error).toContain("Cannot read through symlink");
      expect(result.output).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "9rh-tools-"));
    try {
      await writeFile(join(dir, "target.txt"), "before", "utf-8");
      await symlink(join(dir, "target.txt"), join(dir, "link.txt"));

      const result = await executeTool("write_file", { path: "link.txt", content: "after" }, dir);

      expect(result.error).toContain("Cannot write through symlink");
      expect(result.output).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
