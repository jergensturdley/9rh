import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { configPath, readUserConfig, resolveConfiguredModel, updateUserConfig, writeUserConfig } from "../config.js";

const originalEnv = { ...process.env };

async function withConfigDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "9rh-config-"));
  process.env.NINE_RH_CONFIG_DIR = dir;
  try {
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("user config", () => {
  it("persists default model and provider", async () => {
    await withConfigDir(async () => {
      const saved = await updateUserConfig({ defaultModel: "sonnet", defaultProvider: "kr" });

      expect(saved).toEqual({ defaultModel: "sonnet", defaultProvider: "kr" });
      await expect(readUserConfig()).resolves.toEqual({ defaultModel: "sonnet", defaultProvider: "kr" });
      expect(configPath()).toContain("config.json");
    });
  });

  it("persists sandbox backend and image", async () => {
    await withConfigDir(async () => {
      await writeUserConfig({ sandboxBackend: "docker", sandboxImage: "node:22-bookworm-slim" });

      await expect(readUserConfig()).resolves.toEqual({ sandboxBackend: "docker", sandboxImage: "node:22-bookworm-slim" });
    });
  });

  it("drops invalid sandbox backend but keeps valid sandbox image", async () => {
    await withConfigDir(async () => {
      await writeFile(configPath(), JSON.stringify({ sandboxBackend: "bad", sandboxImage: " ubuntu:24.04 " }), "utf-8");

      await expect(readUserConfig()).resolves.toEqual({ sandboxImage: "ubuntu:24.04" });
    });
  });

  it("uses provider as prefix only for unqualified persisted model names", () => {
    delete process.env.NINE_ROUTER_MODEL;
    expect(resolveConfiguredModel(undefined, { defaultModel: "sonnet", defaultProvider: "kr" })).toBe("kr/sonnet");
    expect(resolveConfiguredModel(undefined, { defaultModel: "openrouter/qwen", defaultProvider: "kr" })).toBe("openrouter/qwen");
  });

  it("lets explicit CLI and env models override persisted defaults", () => {
    delete process.env.NINE_ROUTER_MODEL;
    expect(resolveConfiguredModel("cli/model", { defaultModel: "kr/saved" })).toBe("cli/model");

    process.env.NINE_ROUTER_MODEL = "env/model";
    expect(resolveConfiguredModel("cli/model", { defaultModel: "kr/saved" })).toBe("env/model");
  });
});
