import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { configPath, readUserConfig, resolveConfiguredModel, updateUserConfig } from "../config.js";

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
