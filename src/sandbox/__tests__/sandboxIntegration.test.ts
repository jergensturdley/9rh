import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("sandboxPath path-escape protection", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await makeTempDir("9rh-sandbox-test-");
  });

  afterEach(async () => {
    try { await rm(workDir, { recursive: true, force: true }); } catch {}
  });

  it("rejects path with .. that escapes workDir", async () => {
    const { Sandbox } = await import("../sandboxer.js");
    const sb = new Sandbox({ workDir });
    let threw = false;
    try {
      await sb.validatePath("../file.txt");
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain("escapes workDir");
    }
    expect(threw).toBe(true);
  });

  it("rejects absolute path outside workDir", async () => {
    const { Sandbox } = await import("../sandboxer.js");
    const sb = new Sandbox({ workDir });
    let threw = false;
    try {
      await sb.validatePath("/etc/passwd");
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain("escapes workDir");
    }
    expect(threw).toBe(true);
  });

  it("rejects symlink pointing outside workDir", async () => {
    const { Sandbox } = await import("../sandboxer.js");
    const outside = await makeTempDir("9rh-outside-");
    await writeFile(join(outside, "secret.txt"), "forbidden");
    await symlink(join(outside, "secret.txt"), join(workDir, "evil_link"));
    const sb = new Sandbox({ workDir });
    let threw = false;
    try {
      await sb.validatePath("evil_link");
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain("escapes workDir");
    }
    try { await rm(outside, { recursive: true, force: true }); } catch {}
    expect(threw).toBe(true);
  });
});

describe("Sandbox exec basic behavior", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await makeTempDir("9rh-exec-test-");
  });

  afterEach(async () => {
    try { await rm(workDir, { recursive: true, force: true }); } catch {}
  });

  it("executes a simple command and returns output", async () => {
    const { Sandbox, isSandboxAvailable } = await import("../sandboxer.js");
    const sb = new Sandbox({ workDir, legacySandbox: true });
    const result = await sb.exec("echo hello");
    if (!isSandboxAvailable()) {
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("sandbox execution is unavailable");
      return;
    }
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exit code on failure", async () => {
    const { Sandbox, isSandboxAvailable } = await import("../sandboxer.js");
    const sb = new Sandbox({ workDir, legacySandbox: true });
    const result = await sb.exec("exit 1");
    if (!isSandboxAvailable()) {
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("sandbox execution is unavailable");
      return;
    }
    expect(result.exitCode).toBe(1);
  });
});
