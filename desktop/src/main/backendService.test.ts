import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend, DetectOptions, DetectResult } from "9rh";
import { listPresets, mapChoice, resolveBackend, summarizeBackend } from "./backendService";

function fakeBackend(over: Partial<Backend> = {}): Backend {
  return {
    name: "router",
    baseURL: "http://127.0.0.1:20128/v1",
    apiKey: "k",
    hasNativeRouter: true,
    describe: () => "router (fake)",
    listModels: async () => [],
    health: async () => ({ reachable: true, url: "http://127.0.0.1:20128/v1" }),
    ...over,
  };
}

function fakeDetect(result: Partial<DetectResult> = {}) {
  const calls: DetectOptions[] = [];
  const detect = async (opts: DetectOptions = {}): Promise<DetectResult> => {
    calls.push(opts);
    return { backend: fakeBackend(), warnings: [], ambiguous: false, ...result };
  };
  return { detect, calls };
}

afterEach(() => vi.unstubAllEnvs());

describe("mapChoice", () => {
  it("auto and undefined map to no overrides", () => {
    expect(mapChoice()).toEqual({});
    expect(mapChoice({ mode: "auto" })).toEqual({});
  });

  it("router passes url and key through", () => {
    expect(mapChoice({ mode: "router", routerUrl: "http://r/v1", routerKey: "rk" })).toEqual({
      cliBackend: "router",
      routerBaseURL: "http://r/v1",
      routerApiKey: "rk",
    });
    expect(mapChoice({ mode: "router" })).toEqual({ cliBackend: "router" });
  });

  it("direct fills url and key from the preset", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or");
    expect(mapChoice({ mode: "direct", preset: "openrouter" })).toEqual({
      cliBackend: "direct",
      directBaseURL: "https://openrouter.ai/api/v1",
      directApiKey: "sk-or",
    });
  });

  it("direct explicit url and key win over the preset", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    expect(
      mapChoice({ mode: "direct", preset: "openai", directUrl: "http://x/v1", directKey: "sk-mine" }),
    ).toEqual({ cliBackend: "direct", directBaseURL: "http://x/v1", directApiKey: "sk-mine" });
  });

  it("direct with a keyless preset leaves the key undefined", () => {
    expect(mapChoice({ mode: "direct", preset: "ollama" })).toEqual({
      cliBackend: "direct",
      directBaseURL: "http://127.0.0.1:11434/v1",
    });
  });

  it("direct with an unknown preset leaves both undefined", () => {
    expect(mapChoice({ mode: "direct", preset: "nope" })).toEqual({ cliBackend: "direct" });
  });
});

describe("resolveBackend", () => {
  it("passes mapped options to detect and returns its result", async () => {
    const { detect, calls } = fakeDetect({ warnings: ["w"], ambiguous: true });
    const res = await resolveBackend({ mode: "router", routerUrl: "http://r/v1" }, { detect });
    expect(calls).toEqual([{ cliBackend: "router", routerBaseURL: "http://r/v1" }]);
    expect(res.warnings).toEqual(["w"]);
    expect(res.ambiguous).toBe(true);
    expect(res.backend.name).toBe("router");
  });
});

describe("summarizeBackend", () => {
  it("shapes backend fields and health into a summary", async () => {
    const backend = fakeBackend({
      name: "direct",
      baseURL: "http://x/v1",
      hasNativeRouter: false,
      describe: () => "direct (cli) → http://x/v1",
      health: async () => ({ reachable: false, url: "http://x/v1", detail: "HTTP 500" }),
    });
    const { detect } = fakeDetect({ backend, warnings: ["no key"], ambiguous: false });
    expect(await summarizeBackend({ mode: "direct" }, { detect })).toEqual({
      name: "direct",
      description: "direct (cli) → http://x/v1",
      baseURL: "http://x/v1",
      hasNativeRouter: false,
      reachable: false,
      healthDetail: "HTTP 500",
      warnings: ["no key"],
      ambiguous: false,
    });
  });
});

describe("listPresets", () => {
  it("returns the engine presets", () => {
    expect(listPresets().map((p) => p.id)).toContain("openai");
  });
});
