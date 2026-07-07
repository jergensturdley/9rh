import { beforeAll, describe, expect, it } from "@jest/globals";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const run = promisify(execFile);
const ROOT = process.cwd();
const CLI = join(ROOT, "dist", "index.js");

// index.ts is a top-level script (runs program.parse() at import), so it
// can't be imported for unit tests. Smoke-test the real built entry point
// through a subprocess instead. --version/--help are handled by commander
// before any network/agent code runs, so these stay hermetic.
describe("CLI entry point (built)", () => {
  beforeAll(async () => {
    if (!existsSync(CLI)) {
      await run("npm", ["run", "build"], { cwd: ROOT });
    }
  }, 180_000);

  it("prints its version and exits 0", async () => {
    const { stdout } = await run("node", [CLI, "--version"]);
    expect(stdout.trim()).toBe("1.0.0");
  });

  it("prints usage for --help", async () => {
    const { stdout } = await run("node", [CLI, "--help"]);
    expect(stdout).toContain("Usage: 9rh");
    expect(stdout).toContain("--backend");
  });

  it("exits non-zero on an unknown option", async () => {
    await expect(run("node", [CLI, "--definitely-not-a-flag"])).rejects.toMatchObject({
      code: expect.any(Number),
    });
  });
});
