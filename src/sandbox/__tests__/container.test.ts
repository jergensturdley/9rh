import { describe, expect, it } from "@jest/globals";
import {
  buildAppleContainerArgs,
  buildDockerArgs,
  buildPodmanArgs,
  ContainerSessionExecutor,
} from "../index.js";

describe("container argument builders", () => {
  const startAction = {
    action: "start" as const,
    name: "9rh-test",
    image: "node:22-bookworm-slim",
    hostWorkDir: "/repo",
    containerWorkDir: "/workspace",
    networkEnabled: false,
  };

  it("builds Docker start and exec args", () => {
    expect(buildDockerArgs(startAction)).toEqual([
      "run",
      "-d",
      "--name",
      "9rh-test",
      "--network",
      "none",
      "-v",
      "/repo:/workspace",
      "-w",
      "/workspace",
      "node:22-bookworm-slim",
      "tail",
      "-f",
      "/dev/null",
    ]);
    expect(buildDockerArgs({ ...startAction, networkEnabled: true })).toEqual([
      "run",
      "-d",
      "--name",
      "9rh-test",
      "--network",
      "bridge",
      "-v",
      "/repo:/workspace",
      "-w",
      "/workspace",
      "node:22-bookworm-slim",
      "tail",
      "-f",
      "/dev/null",
    ]);
    expect(buildDockerArgs({ action: "exec", name: "9rh-test", command: "npm test" })).toEqual([
      "exec",
      "9rh-test",
      "sh",
      "-lc",
      "npm test",
    ]);
  });

  it("builds Podman start and exec args", () => {
    expect(buildPodmanArgs(startAction)).toEqual(buildDockerArgs(startAction));
    expect(buildPodmanArgs({ action: "exec", name: "9rh-test", command: "npm test" })).toEqual([
      "exec",
      "9rh-test",
      "sh",
      "-lc",
      "npm test",
    ]);
  });

  it("builds Apple container start and exec args", () => {
    expect(buildAppleContainerArgs(startAction)).toEqual([
      "run",
      "--detach",
      "--name",
      "9rh-test",
      "--volume",
      "/repo:/workspace",
      "--workdir",
      "/workspace",
      "--no-network",
      "node:22-bookworm-slim",
      "tail",
      "-f",
      "/dev/null",
    ]);
    expect(buildAppleContainerArgs({ ...startAction, networkEnabled: true })).toContain("--network");
    expect(buildAppleContainerArgs({ action: "exec", name: "9rh-test", command: "npm test" })).toEqual([
      "exec",
      "9rh-test",
      "sh",
      "-lc",
      "npm test",
    ]);
  });
});

describe("ContainerSessionExecutor", () => {
  it("lazy-starts before first exec and joins stderr", async () => {
    const calls: Array<{ bin: string; args: string[]; options?: { timeout?: number } }> = [];
    const executor = new ContainerSessionExecutor(
      {
        provider: "docker",
        image: "node:22-bookworm-slim",
        hostWorkDir: "/repo",
        containerWorkDir: "/workspace",
        networkEnabled: false,
        timeoutMs: 5000,
      },
      async (bin, args, options) => {
        calls.push({ bin, args, options });
        if (args[0] === "exec") return { stdout: "ok", stderr: "warn", exitCode: 7 };
        return { stdout: "started", exitCode: 0 };
      },
      "9rh-test",
    );

    const result = await executor.exec("npm test");

    expect(calls).toEqual([
      {
        bin: "docker",
        args: buildDockerArgs({
          action: "start",
          name: "9rh-test",
          image: "node:22-bookworm-slim",
          hostWorkDir: "/repo",
          containerWorkDir: "/workspace",
          networkEnabled: false,
        }),
        options: { timeout: 5000 },
      },
      {
        bin: "docker",
        args: ["exec", "9rh-test", "sh", "-lc", "npm test"],
        options: { timeout: 5000 },
      },
    ]);
    expect(result).toMatchObject({
      output: "ok\n--- stderr ---\nwarn",
      exitCode: 7,
      timedOut: false,
      sandboxUsed: true,
    });
    expect(executor.describeStatus()).toMatchObject({ running: true, containerName: "9rh-test" });
  });

  it("returns validated paths unchanged and stops a running session", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const executor = new ContainerSessionExecutor(
      {
        provider: "podman",
        image: "node:22-bookworm-slim",
        hostWorkDir: "/repo",
      },
      async (bin, args) => {
        calls.push({ bin, args });
        return { exitCode: 0 };
      },
      "9rh-test",
    );

    await expect(executor.validatePath("/repo/package.json")).resolves.toBe("/repo/package.json");
    await executor.exec("echo hi");
    await executor.stopSession();

    expect(calls.at(-1)).toEqual({
      bin: "podman",
      args: ["rm", "-f", "9rh-test"],
    });
    expect(executor.describeStatus().running).toBe(false);
  });

  it("marks provider timeouts", async () => {
    const executor = new ContainerSessionExecutor(
      {
        provider: "docker",
        image: "node:22-bookworm-slim",
        hostWorkDir: "/repo",
      },
      async () => {
        throw { stderr: "timed out", killed: true };
      },
      "9rh-test",
    );

    const result = await executor.exec("npm test", { timeoutMs: 1 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });
});
