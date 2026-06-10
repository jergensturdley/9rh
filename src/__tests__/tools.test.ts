import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { mkdtemp, rm, stat, symlink, writeFile } from "fs/promises";
import { TOOL_DEFINITIONS, executeTool } from "../tools.js";
import { DirectExecutor } from "../sandbox/index.js";
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
      { command: "echo hi", timeout_ms: 60_000 },
      "/workdir",
      { executor },
    );

    const [, opts] = (executor.exec as ReturnType<typeof jest.fn>).mock.calls[0] as [
      string,
      { timeoutMs: number },
    ];
    expect(opts.timeoutMs).toBe(60_000);
  });

  it("rejects run_bash with timeout_ms above the maximum (F-04)", async () => {
    const result = await executeTool(
      "run_bash",
      { command: "ls", timeout_ms: 999_999_999 },
      "/workdir",
      { executor: makeMockExecutor() },
    );
    expect(result.error).toMatch(/timeout_ms must be <= 120000/);
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

describe("executeTool run_bash with explicit DirectExecutor (F-14)", () => {
  // F-14: executor is now required. Tests that want direct execution
  // pass a DirectExecutor explicitly.
  it("routes through DirectExecutor when given one", async () => {
    const executor = new DirectExecutor(process.cwd());
    const result = await executeTool(
      "run_bash",
      { command: "echo direct" },
      process.cwd(),
      { executor },
    );
    expect(result.output).toContain("direct");
    expect(result.error).toBeUndefined();
  });
});

describe("executeTool non-bash tools", () => {
  it("read_file does not invoke executor", async () => {
    const executor = makeMockExecutor();
    const result = await executeTool(
      "read_file",
      { path: "nonexistent_xyz.txt" },
      process.cwd(),
      { executor },
    );
    expect(result.error).toBeDefined();
    expect(executor.exec).not.toHaveBeenCalled();
  });

  it("returns unknown tool error for unrecognised names", async () => {
    const result = await executeTool(
      "unknown_tool",
      {},
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
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
    const exec = new DirectExecutor(process.cwd());
    await expect(executeTool("codegraph_search", {}, process.cwd(), { executor: exec }))
      .resolves.toMatchObject({ output: "", error: expect.stringMatching(/query/) });
    await expect(executeTool("codegraph_context", {}, process.cwd(), { executor: exec }))
      .resolves.toMatchObject({ output: "", error: expect.stringMatching(/task/) });
    await expect(executeTool("codegraph_affected", { files: [] }, process.cwd(), { executor: exec }))
      .resolves.toMatchObject({ output: "", error: expect.stringMatching(/files must have at least 1 item/) });
  });

  it("refuses to read through a symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "9rh-tools-"));
    try {
      await writeFile(join(dir, "target.txt"), "secret", "utf-8");
      await symlink(join(dir, "target.txt"), join(dir, "link.txt"));

      const result = await executeTool(
        "read_file",
        { path: "link.txt" },
        dir,
        { executor: new DirectExecutor(dir) },
      );

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

      const result = await executeTool(
        "write_file",
        { path: "link.txt", content: "after" },
        dir,
        { executor: new DirectExecutor(dir) },
      );

      expect(result.error).toContain("Cannot write through symlink");
      expect(result.output).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("executeTool arg validation (F-04)", () => {
  it("rejects unknown tool names with Unknown tool error", async () => {
    const result = await executeTool(
      "delete_everything",
      {},
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/Unknown tool/);
  });

  it("rejects read_file with non-string path", async () => {
    const result = await executeTool(
      "read_file",
      { path: ["/etc/passwd"] },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/path must be a string/);
  });

  it("rejects read_file with path > 4096 chars", async () => {
    const result = await executeTool(
      "read_file",
      { path: "a".repeat(5000) },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/path exceeds max length/);
  });

  it("rejects run_bash with empty command", async () => {
    const result = await executeTool(
      "run_bash",
      { command: "" },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/command must not be empty/);
  });

  it("rejects run_bash with negative timeout_ms", async () => {
    const result = await executeTool(
      "run_bash",
      { command: "ls", timeout_ms: -5 },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/timeout_ms/);
  });

  it("rejects codegraph_search with non-enum kind", async () => {
    const result = await executeTool(
      "codegraph_search",
      { query: "foo", kind: "../../etc/passwd" },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/kind must be one of/);
  });

  it("rejects codegraph_context with non-enum format", async () => {
    const result = await executeTool(
      "codegraph_context",
      { task: "x", format: "--inject-flag" },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/format must be one of/);
  });

  it("rejects codegraph_affected with non-string-array files", async () => {
    const result = await executeTool(
      "codegraph_affected",
      { files: "not-an-array" },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/files must be an array/);
  });

  it("rejects search_files with control chars in pattern", async () => {
    const result = await executeTool(
      "search_files",
      { pattern: "foo\x00bar" },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toMatch(/forbidden control characters/);
  });
});

describe("executeTool install_skill default-deny policy", () => {
  // These tests cover the agent-level policy that install_skill
  // is blocked by default. Even with valid args, the tool
  // returns a clear error and does NOT touch the filesystem.
  const VALID_ARGS = {
    url: "https://example.com/skill.md",
    name: "test-blocked-skill",
  };

  it("returns a tool error when allowSkillInstall is not set", async () => {
    const result = await executeTool(
      "install_skill",
      VALID_ARGS,
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.output).toBe("");
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/install_skill is disabled by default/);
    expect(result.error).toMatch(/--allow-skill-install/);
  });

  it("returns a tool error when allowSkillInstall is explicitly false", async () => {
    const result = await executeTool(
      "install_skill",
      VALID_ARGS,
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()), allowSkillInstall: false },
    );
    expect(result.error).toMatch(/install_skill is disabled by default/);
  });

  it("does NOT call the network or write a file when blocked", async () => {
    // Use a name that would be visually obvious in the skills dir
    // if anything slipped through. The test passes if and only if
    // nothing is created.
    const result = await executeTool(
      "install_skill",
      { url: "https://example.invalid/never-resolves", name: "policy-test-should-not-write" },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()) },
    );
    expect(result.error).toBeDefined();
    // Defensive: if some future refactor accidentally lets the
    // install through, the test still fails clearly.
    const skillPath = join(homedir(), ".9rh", "skills", "policy-test-should-not-write", "SKILL.md");
    const exists = await stat(skillPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("bypasses the guard when allowSkillInstall is true (proceeds to network)", async () => {
    // We don't actually want the network call to succeed in a unit
    // test — we just want to confirm the guard does NOT fire and
    // execution proceeds to the tool body. Using a deliberately
    // unreachable host means the call will fail with a network
    // error, NOT with "install_skill is disabled by default".
    const result = await executeTool(
      "install_skill",
      { url: "https://example.invalid/never-resolves", name: "policy-test-allow-on" },
      process.cwd(),
      { executor: new DirectExecutor(process.cwd()), allowSkillInstall: true },
    );
    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/install_skill is disabled by default/);
    // Cleanup: the call will have failed, but be paranoid.
    const skillDir = join(homedir(), ".9rh", "skills", "policy-test-allow-on");
    await rm(skillDir, { recursive: true, force: true }).catch(() => {});
  });
});
