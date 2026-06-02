import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import { DirectBackend } from "../backends/direct.js";
import { detectBackend } from "../backends/detect.js";
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  listProviderPresetIds,
} from "../backends/presets.js";

// Mocked fetch helper. Each test installs its own implementation via
// `globalThis.fetch = jest.fn(...)` and the afterEach restores the original.
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

describe("DirectBackend", () => {
  const backend = new DirectBackend("https://api.example.com/v1", "sk-test-1234", "cli");

  it("describes itself with the configured URL", () => {
    expect(backend.describe()).toContain("https://api.example.com/v1");
    expect(backend.describe()).toContain("direct");
  });

  it("has name=direct and hasNativeRouter=false", () => {
    expect(backend.name).toBe("direct");
    expect(backend.hasNativeRouter).toBe(false);
  });

  it("listModels() parses OpenAI-format /v1/models response", async () => {
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://api.example.com/v1/models");
      return new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4o-mini", owned_by: "openai" },
            { id: "gpt-4o", owned_by: "openai" },
            // garbage entry — should be filtered out
            { owned_by: "openai" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("listModels() returns [] on non-200 responses", async () => {
    globalThis.fetch = jest.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const models = await backend.listModels();
    expect(models).toEqual([]);
  });

  it("listModels() returns [] on network errors", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const models = await backend.listModels();
    expect(models).toEqual([]);
  });

  it("listModels() returns [] on malformed payloads", async () => {
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ wrong: "shape" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const models = await backend.listModels();
    expect(models).toEqual([]);
  });

  it("health() reports reachable on 200", async () => {
    globalThis.fetch = jest.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const h = await backend.health();
    expect(h.reachable).toBe(true);
    expect(h.url).toBe("https://api.example.com/v1");
  });

  it("health() reports unreachable on 401 with detail", async () => {
    globalThis.fetch = jest.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const h = await backend.health();
    expect(h.reachable).toBe(false);
    expect(h.detail).toContain("401");
  });

  it("health() reports unreachable on thrown errors", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("DNS failure");
    }) as unknown as typeof fetch;
    const h = await backend.health();
    expect(h.reachable).toBe(false);
    expect(h.detail).toContain("DNS failure");
  });
});

describe("detectBackend — precedence and routing", () => {
  beforeEach(() => {
    // Make sure no env vars leak between tests.
    delete process.env.NINE_ROUTER_BACKEND;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NINE_ROUTER_URL;
    delete process.env.OPENAI_BASE_URL;
    // Pretend ~/.9rh/config.json doesn't exist by setting a non-existent dir.
    process.env.NINE_RH_CONFIG_DIR = `/tmp/9rh-test-${Date.now()}-${Math.random()}`;
  });

  it("--backend=direct returns DirectBackend even when no env key is set", async () => {
    const r = await detectBackend({
      cliBackend: "direct",
      directBaseURL: "https://api.openai.com/v1",
      directApiKey: "sk-test",
      skipReachabilityProbe: true,
    });
    expect(r.backend.name).toBe("direct");
    expect(r.backend.baseURL).toBe("https://api.openai.com/v1");
    expect(r.backend.apiKey).toBe("sk-test");
  });

  it("--backend=router with explicit URL/key returns RouterBackend", async () => {
    // ensureRouter is called and may try to start 9router; use skipReachabilityProbe=false
    // but accept whatever it returns as long as name=router.
    const r = await detectBackend({
      cliBackend: "router",
      routerBaseURL: "http://127.0.0.1:20128/v1",
      routerApiKey: "9router",
    });
    expect(r.backend.name).toBe("router");
    expect(r.backend.hasNativeRouter).toBe(true);
  });

  it("NINE_ROUTER_BACKEND env var overrides persisted config", async () => {
    process.env.NINE_ROUTER_BACKEND = "direct";
    const r = await detectBackend({
      directBaseURL: "https://api.example.com/v1",
      directApiKey: "sk-from-env",
      skipReachabilityProbe: true,
    });
    expect(r.backend.name).toBe("direct");
  });

  it("OPENAI_API_KEY alone (no router URL) → DirectBackend", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const r = await detectBackend({ skipReachabilityProbe: true });
    expect(r.backend.name).toBe("direct");
    expect(r.backend.apiKey).toBe("sk-openai-test");
  });

  it("CLI flag wins over env var", async () => {
    process.env.NINE_ROUTER_BACKEND = "direct";
    process.env.OPENAI_API_KEY = "sk-env";
    const r = await detectBackend({
      cliBackend: "direct",
      directBaseURL: "https://api.example.com/v1",
      directApiKey: "sk-cli",
      skipReachabilityProbe: true,
    });
    expect(r.backend.apiKey).toBe("sk-cli");
  });

  it("accepts alias 'openai' as direct backend name", async () => {
    const r = await detectBackend({
      cliBackend: "openai",
      directBaseURL: "https://api.openai.com/v1",
      directApiKey: "sk-test",
      skipReachabilityProbe: true,
    });
    expect(r.backend.name).toBe("direct");
  });

  it("direct backend with no key still returns a backend (with warning)", async () => {
    const r = await detectBackend({
      cliBackend: "direct",
      directBaseURL: "https://api.example.com/v1",
      skipReachabilityProbe: true,
    });
    expect(r.backend.name).toBe("direct");
    expect(r.backend.apiKey).toBe("");
    // The warning is informational — at least one warning should be present.
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("embedded backend name is recognized but currently falls back to router", async () => {
    const r = await detectBackend({
      cliBackend: "embedded",
      routerBaseURL: "http://127.0.0.1:20128/v1",
      routerApiKey: "9router",
    });
    // Falls back to router since embedded isn't implemented yet.
    expect(r.backend.name).toBe("router");
    expect(r.warnings.some((w) => w.toLowerCase().includes("embedded"))).toBe(true);
  });
});

describe("provider presets", () => {
  it("ships openrouter, openai, ollama, and lmstudio presets", () => {
    const ids = listProviderPresetIds();
    expect(ids).toContain("openrouter");
    expect(ids).toContain("openai");
    expect(ids).toContain("ollama");
    expect(ids).toContain("lmstudio");
  });

  it("getProviderPreset returns a known preset by id (case-insensitive)", () => {
    expect(getProviderPreset("openrouter")?.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(getProviderPreset("OPENROUTER")?.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(getProviderPreset("  OpenRouter  ")?.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("getProviderPreset returns undefined for unknown ids", () => {
    expect(getProviderPreset("nope")).toBeUndefined();
    expect(getProviderPreset("")).toBeUndefined();
    expect(getProviderPreset(undefined)).toBeUndefined();
  });

  it("openrouter preset points at openrouter.ai and reads OPENROUTER_API_KEY", () => {
    const p = getProviderPreset("openrouter");
    expect(p?.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(p?.envKey).toBe("OPENROUTER_API_KEY");
  });

  it("local presets (ollama, lmstudio) have empty envKey (no auth required)", () => {
    expect(getProviderPreset("ollama")?.envKey).toBe("");
    expect(getProviderPreset("lmstudio")?.envKey).toBe("");
  });

  it("every preset has a modelHint (helps --help output)", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.modelHint).toBeTruthy();
    }
  });
});
