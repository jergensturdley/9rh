import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises";
import os from "os";
import child_process from "child_process";
import { join } from "path";
import { clearRouterConfigCache, executeSlashCommand, fetchModels, filterModels, formatModelsList, getSlashCommands, toArray, type ModelInfo, type SessionState } from "../commands.js";
import * as initModule from "../init.js";
import { SandboxExecutor, isSandboxAvailable } from "../sandbox/index.js";

function state(apiKey = "session-key"): SessionState {
  return {
    baseURL: "http://127.0.0.1:20128/v1",
    apiKey,
    model: "kr/test-model",
    workDir: "/tmp",
    useColor: false,
    queue: [],
    _runStartMs: undefined,
    _toolCallCount: {},
    allowSkillInstall: false,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": "application/json" },
  });
}

async function withConfigDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.env.NINE_RH_CONFIG_DIR;
  const dir = await mkdtemp(join(os.tmpdir(), "9rh-commands-"));
  process.env.NINE_RH_CONFIG_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.NINE_RH_CONFIG_DIR;
    else process.env.NINE_RH_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("executeSlashCommand native API auth", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses 9router CLI-token auth for /keys instead of Bearer API-key auth", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      if (!headers["x-9r-cli-token"] || "Authorization" in headers) {
        return jsonResponse({ error: "unauthorized" }, { status: 401, statusText: "Unauthorized" });
      }
      return jsonResponse({ keys: [{ id: "key_1", name: "Live key" }] });
    });

    const output = await executeSlashCommand("/keys", state("live-session-key"));

    expect(output).toContain("Live key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses 9router CLI-token auth for /combos", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      return headers["x-9r-cli-token"] && !("Authorization" in headers)
        ? jsonResponse({ combos: [{ name: "fallback combo", kind: "fallback", models: ["a", "b"] }] })
        : jsonResponse({ error: "unauthorized" }, { status: 401, statusText: "Unauthorized" });
    });

    const output = await executeSlashCommand("/combos", state("bad-session-key"));

    expect(output).toContain("fallback combo");
    expect(output).not.toContain("Command failed");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:20128/api/combos",
      expect.objectContaining({ headers: expect.objectContaining({ "x-9r-cli-token": expect.any(String) }) }),
    );
  });

  it.each([
    ["/providers", { connections: [{ name: "OpenRouter", provider: "openrouter", isActive: true }] }, "OpenRouter"],
    ["/status", { ok: true }, "9router is running"],
  ])("uses CLI-token auth for %s", async (command, body, expected) => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url, requestInit) => {
      const headers = (requestInit as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      if (!headers["x-9r-cli-token"] || "Authorization" in headers) {
        return jsonResponse({ error: "unauthorized" }, { status: 401, statusText: "Unauthorized" });
      }
      if (String(url).endsWith("/api/version")) {
        return jsonResponse({ currentVersion: "1.0.0", hasUpdate: false });
      }
      return jsonResponse(body);
    });

    const output = await executeSlashCommand(command, state());

    expect(output).toContain(expected);
    expect(output).not.toContain("Command failed");
  });

  it("does not report catalog models as usable when keys and providers are missing", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).replace("http://127.0.0.1:20128", "");
      if (path === "/api/health") return jsonResponse({ ok: true });
      if (path === "/api/version") return jsonResponse({ currentVersion: "1.0.0", hasUpdate: false });
      if (path === "/api/keys") return jsonResponse({ keys: [] });
      if (path === "/api/providers") return jsonResponse({ connections: [] });
      if (path === "/v1/models") return jsonResponse({ data: [{ id: "catalog/model-a" }] });
      return jsonResponse({ error: "not found" }, { status: 404 });
    });

    const output = await executeSlashCommand("/doctor", state());

    expect(output).toContain("API keys");
    expect(output).toContain("no keys found");
    expect(output).toContain("providers");
    expect(output).toContain("no providers");
    expect(output).toContain("catalog model(s) visible");
    expect(output).not.toContain("1 models available");
  });
});

describe("model command helpers", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("fetches OpenAI-compatible models with the session API key", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/api/providers")) return jsonResponse({ connections: [] });
      return jsonResponse({ data: [{ id: "kr/model-a", owned_by: "9router" }, { id: 42 }] });
    });

    await expect(fetchModels(state("model-key"))).resolves.toEqual([{ id: "kr/model-a", owned_by: "9router" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:20128/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer model-key" } }),
    );
  });

  it("adds configured models for active provider connections missing from /v1/models", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) {
        return jsonResponse({ data: [{ id: "acct-a/model-a", owned_by: "acct-a" }] });
      }
      if (String(url).endsWith("/api/providers")) {
        return jsonResponse({
          connections: [
            { provider: "openai", isActive: true, providerSpecificData: { prefix: "acct-a", enabledModels: ["model-a"] } },
            { provider: "openai", isActive: true, providerSpecificData: { prefix: "acct-b", enabledModels: ["openai/model-b"] } },
            { provider: "openai", isActive: false, providerSpecificData: { prefix: "disabled", enabledModels: ["model-c"] } },
          ],
        });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    });

    await expect(fetchModels(state("model-key"))).resolves.toEqual([
      { id: "acct-a/model-a", owned_by: "acct-a" },
      { id: "acct-b/model-b", owned_by: "acct-b" },
    ]);
  });

  it("adds fallback catalog models for active providers without configured models", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [] });
      if (String(url).endsWith("/api/providers")) {
        return jsonResponse({ connections: [{ provider: "kilocode", isActive: true, providerSpecificData: {} }] });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    });

    const models = await fetchModels(state("model-key"));

    expect(models).toContainEqual({ id: "kc/anthropic/claude-sonnet-4-20250514", owned_by: "kc" });
    expect(models).toContainEqual({ id: "kc/openai/gpt-4.1", owned_by: "kc" });
  });

  it("rejects arbitrary model names in /switch", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "kr/claude-sonnet-4.5" }] });
      if (String(url).endsWith("/api/providers")) return jsonResponse({ connections: [] });
      return jsonResponse({ error: "not found" }, { status: 404 });
    });
    const current = state("model-key");

    const output = await executeSlashCommand("/switch made-up-model", current);

    expect(output).toContain("Unknown model");
    expect(current.model).toBe("kr/test-model");
  });

  it("/switch changes only the current REPL session model", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "kr/next" }] });
      if (String(url).endsWith("/api/providers")) return jsonResponse({ connections: [] });
      return jsonResponse({ error: "not found" }, { status: 404 });
    });
    const current = state("model-key");

    const output = await executeSlashCommand("/switch kr/next", current);

    expect(output).toContain("switched for this session");
    expect(current.model).toBe("kr/next");
  });

  it("/default-model persists the startup model and updates current session", async () => {
    await withConfigDir(async (dir) => {
      jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "kr/persisted" }] });
        if (String(url).endsWith("/api/providers")) return jsonResponse({ connections: [] });
        return jsonResponse({ error: "not found" }, { status: 404 });
      });
      const current = state("model-key");

      const output = await executeSlashCommand("/default-model kr/persisted", current);

      expect(output).toContain("startup model saved: kr/persisted");
      expect(current.model).toBe("kr/persisted");
      await expect(readFile(join(dir, "config.json"), "utf-8")).resolves.toContain('"defaultModel": "kr/persisted"');
    });
  });

  it("filters and formats models consistently for static fallback output", () => {
    const models: ModelInfo[] = [
      { id: "kr/claude-sonnet-4.5", owned_by: "9router" },
      { id: "openrouter/qwen" },
    ];
    const current = state();
    current.model = "openrouter/qwen";

    const filtered = filterModels(models, "qwen");
    const output = formatModelsList(filtered, current, "qwen");

    expect(filtered).toEqual([{ id: "openrouter/qwen" }]);
    expect(output).toContain('1 model(s) matching "qwen"');
    expect(output).toContain("▶ openrouter/qwen");
  });

  it("caches model and provider config for repeated slash menu lookups", async () => {
    const current = state("model-key");
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "kr/model-a", owned_by: "kr" }] });
      if (String(url).endsWith("/api/providers")) return jsonResponse({ connections: [{ provider: "kiro", name: "Kiro", isActive: true }] });
      return jsonResponse({ error: "not found" }, { status: 404 });
    });

    await expect(fetchModels(current)).resolves.toEqual([{ id: "kr/model-a", owned_by: "kr" }]);
    await expect(fetchModels(current)).resolves.toEqual([{ id: "kr/model-a", owned_by: "kr" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:20128/v1/models", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:20128/api/providers", expect.any(Object));
  });

  it("/router summarizes cached 9router configuration", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "kr/model-a", owned_by: "kr" }] });
      if (String(url).endsWith("/api/providers")) return jsonResponse({ connections: [{ provider: "kiro", name: "Kiro", isActive: true }] });
      if (String(url).endsWith("/api/combos")) return jsonResponse({ combos: [{ name: "fast", models: ["kr/model-a"] }] });
      if (String(url).endsWith("/api/keys")) return jsonResponse({ keys: [{ id: "key_1", name: "Default" }] });
      return jsonResponse({ error: "not found" }, { status: 404 });
    });

    const output = await executeSlashCommand("/router", state("model-key"));

    expect(output).toContain("9router: http://127.0.0.1:20128");
    expect(output).toContain("models: 1");
    expect(output).toContain("providers: 1 configured, 1 active");
    expect(output).toContain("combos: 1");
    expect(output).toContain("API keys: 1");
  });

  it("/refresh clears stale router config cache before refetching", async () => {
    const current = state("model-key");
    let modelId = "kr/old";
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: modelId, owned_by: "kr" }] });
      if (String(url).endsWith("/api/providers")) return jsonResponse({ connections: [{ provider: "kiro", isActive: true }] });
      return jsonResponse({ error: "not found" }, { status: 404 });
    });

    await expect(fetchModels(current)).resolves.toEqual([{ id: "kr/old", owned_by: "kr" }]);
    modelId = "kr/new";
    const output = await executeSlashCommand("/refresh", current);

    expect(output).toContain("refreshed 9router config: 1 models");
    await expect(fetchModels(current)).resolves.toEqual([{ id: "kr/new", owned_by: "kr" }]);
  });

  it("/sandbox reports command isolation status", async () => {
    const output = await executeSlashCommand("/sandbox", state("model-key"));

    expect(output).toContain("sandbox:");
    expect(output).toContain("backend:");
    expect(output).toContain("platform support:");
    expect(output).toContain("network policy:");
  });

  it("/sandbox reports direct fallback when the restrictive profile is rejected", async () => {
    if (!isSandboxAvailable()) return;
    const probe = new SandboxExecutor("/tmp");
    if (probe.getProfile() !== "(version 1)(allow default)") return;

    const output = await executeSlashCommand("/sandbox", state("model-key"));

    expect(output).toContain("sandbox: direct fallback");
    expect(output).toContain("backend: direct");
    expect(output).toContain("restrictive profile: rejected");
  });
});

describe("debug-auth handler", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function withMockHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(os.tmpdir(), "9rh-mock-home-"));
    jest.spyOn(os, "homedir").mockReturnValue(dir);
    // Mock execFileSync to prevent it from finding real machine ID on Darwin/Linux
    jest.spyOn(child_process, "execFileSync").mockImplementation(() => {
      throw new Error("mocked error");
    });
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("uses token auth when CLI token present", async () => {
    await withMockHome(async (home) => {
      const nineRouterDir = join(home, ".9router");
      const authDir = join(nineRouterDir, "auth");
      await mkdir(authDir, { recursive: true });
      await writeFile(join(nineRouterDir, "machine-id"), "mock-machine-id");
      await writeFile(join(authDir, "cli-secret"), "mock-secret");

      const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const path = String(url).replace("http://127.0.0.1:20128", "");
        if (path === "/api/health") return jsonResponse({ ok: true });
        if (path === "/api/providers") return jsonResponse({ connections: [1, 2] });
        return jsonResponse({ error: "not found" }, { status: 404 });
      });

      const output = await executeSlashCommand("/debug-auth", state());
      expect(output).toContain("CLI token:");
      expect(output).not.toContain("CLI token: missing");
      expect(output).toContain("API Health: ok");
      expect(output).toContain("Providers API: 2 connections found");
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("falls back to API key when token missing", async () => {
    await withMockHome(async (_home) => {
      const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const path = String(url).replace("http://127.0.0.1:20128", "");
        if (path === "/api/health") return jsonResponse({ ok: false });
        if (path === "/api/providers") return jsonResponse({ error: "Service Unavailable" }, { status: 503, statusText: "Service Unavailable" });
        return jsonResponse({ error: "not found" }, { status: 404 });
      });

      const output = await executeSlashCommand("/debug-auth", state("keyABCDEF"));
      expect(output).not.toBeNull();
      expect(output).toContain("CLI token:");
      expect(output).toContain("Effective API key: keyABCDE…");
      expect(output).toContain("API Health: unhealthy");
      expect(output).toContain("Providers API: error 503 Service Unavailable");
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it("handles fetch exceptions gracefully", async () => {
    await withMockHome(async (_home) => {
      jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network fail"));

      const output = await executeSlashCommand("/debug-auth", state());
      expect(output).toContain("API Health check failed: network fail");
      expect(output).toContain("Providers API check failed: network fail");
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Pure helpers + static (router-free) slash-command handlers
// ────────────────────────────────────────────────────────────────────
describe("toArray", () => {
  it("returns the array when given an array", () => {
    expect(toArray([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("returns empty array for non-array input", () => {
    expect(toArray(undefined)).toEqual([]);
    expect(toArray(null)).toEqual([]);
    expect(toArray("nope")).toEqual([]);
    expect(toArray({ a: 1 })).toEqual([]);
  });
});

describe("getSlashCommands", () => {
  it("lists every registered command with name + description", () => {
    const cmds = getSlashCommands();
    expect(cmds.length).toBeGreaterThan(10);
    for (const c of cmds) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.description).toBe("string");
    }
    const names = cmds.map(c => c.name);
    for (const required of ["help", "models", "switch", "queue", "run", "sandbox", "doctor"]) {
      expect(names).toContain(required);
    }
  });
});

describe("filterModels", () => {
  const models: ModelInfo[] = [
    { id: "claude-sonnet-4.5" },
    { id: "claude-haiku-4.5" },
    { id: "glm-5" },
  ];
  it("returns the full list when filter is empty", () => {
    expect(filterModels(models, "")).toHaveLength(3);
  });
  it("sub-string case-insensitive match", () => {
    expect(filterModels(models, "CLAUDE")).toHaveLength(2);
    expect(filterModels(models, "GLM")).toHaveLength(1);
  });
  it("no match returns empty", () => {
    expect(filterModels(models, "zzz")).toEqual([]);
  });
});

describe("formatModelsList", () => {
  it("empty list reports no models, optional filter echoed", () => {
    expect(formatModelsList([], state(), "")).toContain("(no models)");
    expect(formatModelsList([], state(), "foo")).toContain('matching "foo"');
  });
  it("marks the active model and renders count + ids", () => {
    const s = state();
    const out = formatModelsList(
      [{ id: "kr/test-model" }, { id: "glm-5" }],
      s,
    );
    expect(out).toContain("2 model(s)");
    expect(out).toContain("kr/test-model");
    expect(out).toContain("▶");
  });
});

describe("clearRouterConfigCache", () => {
  it("resets routerCache to a fresh empty native map", () => {
    const s = state();
    s.routerCache = { models: { value: [], expiresAt: 0 }, native: new Map([["k", { value: 1, expiresAt: 0 }]]) };
    clearRouterConfigCache(s);
    expect(s.routerCache?.models).toBeUndefined();
    expect(s.routerCache?.native.size).toBe(0);
  });
});

describe("static slash-command handlers", () => {
  it("/help lists commands and groups them", async () => {
    const out = await executeSlashCommand("/help", state());
    expect(out).toContain("9rh slash commands");
    expect(out).toContain("/models");
    expect(out).toContain("/doctor");
  });

  it("/logs tail validates count and rejects non-positive", async () => {
    expect(await executeSlashCommand("/logs tail 5", state())).toContain("5 lines");
    expect(await executeSlashCommand("/logs tail -3", state())).toContain("Invalid line count");
    expect(await executeSlashCommand("/logs tail banana", state())).toContain("Invalid line count");
  });

  it("/logs clear simulates", async () => {
    expect(await executeSlashCommand("/logs clear", state())).toContain("cleared");
  });

  it("/history reports when empty", async () => {
    const out = await executeSlashCommand("/history", state());
    expect(out).toContain("No command history");
  });

  it("/history renders recent entries", async () => {
    const s = state();
    s.history = ["/models", "/status", "/help"];
    const out = await executeSlashCommand("/history 2", s);
    expect(out).toContain("2. /status");
    expect(out).toContain("3. /help");
    expect(out).not.toContain("/models");
  });

  it("/reload reports nothing to reload when cache empty", async () => {
    expect(await executeSlashCommand("/reload", state())).toContain("No router cache");
  });
  it("/reload clears when cache present", async () => {
    const s = state();
    s.routerCache = { native: new Map() };
    expect(await executeSlashCommand("/reload", s)).toContain("Reloaded router cache");
  });

  it("/queue reports empty", async () => {
    expect(await executeSlashCommand("/queue", state())).toContain("Queue is empty");
  });
  it("/queue lists queued messages and previews long ones", async () => {
    const s = state();
    s.queue = ["short", "x".repeat(120)];
    const out = await executeSlashCommand("/queue", s);
    expect(out).toContain("Queued 2");
    expect(out).toContain("1. short");
    expect(out).toContain("...");
  });
  it("/queue clear empties and reports count", async () => {
    const s = state();
    s.queue = ["a", "b"];
    const out = await executeSlashCommand("/queue clear", s);
    expect(out).toContain("Cleared 2");
    expect(s.queue).toEqual([]);
  });

  it("/run reports nothing queued", async () => {
    expect(await executeSlashCommand("/run", state())).toContain("No queued messages");
  });
  it("/run reports count when queued", async () => {
    const s = state();
    s.queue = ["a", "b", "c"];
    expect(await executeSlashCommand("/run", s)).toContain("3 message(s) queued");
  });

  it("/done hints at Ctrl+C", async () => {
    expect(await executeSlashCommand("/done", state())).toContain("Ctrl+C");
  });

  it("/clear emits ANSI clear screen", async () => {
    expect(await executeSlashCommand("/clear", state())).toBe("\x1b[2J\x1b[H");
  });

  it("/allow-skill-install status reports OFF by default", async () => {
    const out = await executeSlashCommand("/allow-skill-install", state());
    expect(out).toContain("OFF");
  });
  it("/allow-skill-install on/off toggles state", async () => {
    const s = state();
    expect(await executeSlashCommand("/allow-skill-install on", s)).toContain("ENABLED");
    expect(s.allowSkillInstall).toBe(true);
    expect(await executeSlashCommand("/allow-skill-install off", s)).toContain("DISABLED");
    expect(s.allowSkillInstall).toBe(false);
  });
  it("/allow-skill-install rejects unknown args", async () => {
    expect(await executeSlashCommand("/allow-skill-install maybe", state())).toContain("Unrecognised");
  });

  it("/report reports no report yet", async () => {
    expect(await executeSlashCommand("/report", state())).toContain("no report generated");
  });
  it("/report shows path when set", async () => {
    const s = state();
    s.lastReportPath = "/tmp/9rh-report.html";
    const out = await executeSlashCommand("/report", s);
    expect(out).toContain("/tmp/9rh-report.html");
    expect(out).toContain("/report open");
  });

  it("/dir shows current workDir", async () => {
    const out = await executeSlashCommand("/dir", state());
    expect(out).toContain("workDir:");
  });

  it("/skills reload not implemented", async () => {
    const out = await executeSlashCommand("/skills reload", state());
    expect(out).toContain("not yet implemented");
  });
  it("/skills unknown subcommand falls back to usage", async () => {
    const out = await executeSlashCommand("/skills frobnicate", state());
    expect(out).toContain("Usage:");
  });

  it("/index prune path delegates to pruneStaleRepos", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    const out = await executeSlashCommand("/index prune", state());
    expect(out).toContain("pruned");
    expect(out).toContain("stale entries");
    fetchMock.mockRestore();
  });
});

describe("router-dependent slash-command handlers", () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it("/status reports unhealthy when health.ok=false", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).replace("http://127.0.0.1:20128", "");
      if (path === "/api/health") return jsonResponse({ ok: false });
      if (path === "/api/version") return jsonResponse({ currentVersion: "1.0", hasUpdate: false });
      return jsonResponse({ error: "no" }, { status: 404 });
    });
    const out = await executeSlashCommand("/status", state());
    expect(out).toContain("unhealthy");
    expect(out).toContain("up to date");
  });

  it("/status reports unreachable when health rejects", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).replace("http://127.0.0.1:20128", "");
      if (path === "/api/health") throw new Error("conn refused");
      if (path === "/api/version") return jsonResponse({ currentVersion: "1.0" });
      return jsonResponse({ error: "no" }, { status: 404 });
    });
    const out = await executeSlashCommand("/status", state());
    expect(out).toContain("unreachable");
  });

  it("/providers handles empty connections", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).replace("http://127.0.0.1:20128", "");
      if (path === "/api/providers") return jsonResponse({ connections: [] });
      return jsonResponse({ error: "no" }, { status: 404 });
    });
    expect(await executeSlashCommand("/providers", state())).toContain("no providers configured");
  });

  it("/combos handles empty", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).replace("http://127.0.0.1:20128", "");
      if (path === "/api/combos") return jsonResponse({ combos: [] });
      return jsonResponse({ error: "no" }, { status: 404 });
    });
    expect(await executeSlashCommand("/combos", state())).toContain("no combos configured");
  });

  it("/keys handles empty", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).replace("http://127.0.0.1:20128", "");
      if (path === "/api/keys") return jsonResponse({ keys: [] });
      return jsonResponse({ error: "no" }, { status: 404 });
    });
    expect(await executeSlashCommand("/keys", state())).toContain("no API keys");
  });

  it("/models filter passes through to listing", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/models")) {
        return jsonResponse({
          data: [
            { id: "claude-sonnet-4.5" },
            { id: "glm-5" },
          ],
        });
      }
      // /api/providers — return empty so reconcile doesn't add models
      return jsonResponse({ connections: [] }, { status: 200 });
    });
    const out = await executeSlashCommand("/models claude", state());
    expect(out).toContain("claude-sonnet-4.5");
    expect(out).not.toContain("glm-5");
  });
});

describe("executeSlashCommand dispatch", () => {
  it("returns null for non-slash input", async () => {
    expect(await executeSlashCommand("hello", state())).toBeNull();
  });
  it("unknown command reports error", async () => {
    const out = await executeSlashCommand("/nope", state());
    expect(out).toContain("Unknown command");
    expect(out).toContain("/help");
  });
  it("case-insensitive command name", async () => {
    const out = await executeSlashCommand("/HELP", state());
    expect(out).toContain("9rh slash commands");
  });
});

// ────────────────────────────────────────────────────────────────────
// Additional branch coverage (merged from the parallel coverage PR):
// browser-opener, skills fs-listing, index refresh, usage/failure paths,
// and full doctor pass/fail — branches not already exercised above.
// ────────────────────────────────────────────────────────────────────
describe("commands.ts — extra branch coverage", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("formatModelsList marks the active model and owner with color enabled", () => {
    const colored = state();
    colored.useColor = true;
    colored.model = "kr/current";
    const output = formatModelsList([{ id: "kr/current", owned_by: "kr" }, { id: "kr/other" }], colored);
    expect(output).toContain("kr/current");
    expect(output).toContain("[kr]");
    expect(output).toContain("kr/other");
  });

  it("dispatch wraps a handler exception in Command failed", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const output = await executeSlashCommand("/models", state());
    expect(output).toContain("Command failed: connection refused");
  });

  it("dispatch surfaces an HTTP error status", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "nope" }, { status: 500, statusText: "Internal Server Error" }),
    );
    const output = await executeSlashCommand("/models", state());
    expect(output).toContain("Command failed: HTTP 500 Internal Server Error");
  });

  it("/report open launches the platform opener and survives spawn failure", async () => {
    const current = state();
    current.lastReportPath = "/tmp/run-report.html";

    const spawnMock = jest.spyOn(child_process, "spawn").mockReturnValue(
      { unref: () => undefined } as unknown as ReturnType<typeof child_process.spawn>,
    );
    const opened = await executeSlashCommand("/report open", current);
    expect(opened).toContain("opened: file:///tmp/run-report.html");
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["/tmp/run-report.html"]),
      expect.objectContaining({ detached: true }),
    );

    spawnMock.mockImplementation(() => {
      throw new Error("no gui");
    });
    const fallback = await executeSlashCommand("/report open", current);
    expect(fallback).toContain("could not launch a browser (no gui)");
    expect(fallback).toContain("path: file:///tmp/run-report.html");
  });

  it("/dir changes to a real directory and rejects bad targets", async () => {
    const current = state();
    const dir = await mkdtemp(join(os.tmpdir(), "9rh-dir-"));
    try {
      const changed = await executeSlashCommand(`/dir ${dir}`, current);
      expect(changed).toContain(`workDir → ${dir}`);
      expect(current.workDir).toBe(dir);

      await expect(executeSlashCommand("/dir /definitely/not/here", current)).resolves.toContain("Directory not found");

      const file = join(dir, "file.txt");
      await writeFile(file, "x");
      await expect(executeSlashCommand(`/dir ${file}`, current)).resolves.toContain("Not a directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/runonce refuses to run with an empty queue", async () => {
    await expect(executeSlashCommand("/runonce", state())).resolves.toContain("No queued messages to run");
  });

  it("/skills lists directories, reports empty, and fails gracefully when missing", async () => {
    const home = await mkdtemp(join(os.tmpdir(), "9rh-skills-home-"));
    jest.spyOn(os, "homedir").mockReturnValue(home);
    try {
      // missing skills dir → error path
      await expect(executeSlashCommand("/skills", state())).resolves.toContain("Failed to list skills");

      await mkdir(join(home, ".9rh", "skills"), { recursive: true });
      await expect(executeSlashCommand("/skills list", state())).resolves.toContain("No local skills found");

      await mkdir(join(home, ".9rh", "skills", "commit-helper"), { recursive: true });
      await writeFile(join(home, ".9rh", "skills", "not-a-skill.txt"), "ignored");
      const listed = await executeSlashCommand("/skills", state());
      expect(listed).toContain("- commit-helper");
      expect(listed).not.toContain("not-a-skill");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("/index refreshes and reports status against a temp workspace", async () => {
    const workDir = await mkdtemp(join(os.tmpdir(), "9rh-index-"));
    try {
      await mkdir(join(workDir, "repo-a", ".git"), { recursive: true });
      await writeFile(join(workDir, "repo-a", "package.json"), JSON.stringify({ name: "repo-a" }));
      const current = state();
      current.workDir = workDir;

      const refreshed = await executeSlashCommand("/index", current);
      expect(refreshed).toContain("index refreshed in");
      expect(refreshed).toContain("in index");

      const status = await executeSlashCommand("/index-status", current);
      expect(status).toContain("repo index:");
      expect(status).toContain("total size:");
      expect(status).toContain("oldest entry:");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("/switch and /default-model require a model argument", async () => {
    await expect(executeSlashCommand("/switch", state())).resolves.toContain("Usage: /switch <model>");
    await expect(executeSlashCommand("/default-model", state())).resolves.toContain("Usage: /default-model <model>");
  });

  it("/router degrades to zero counts when every endpoint is down", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const output = await executeSlashCommand("/router", state());
    expect(output).toContain("models: 0");
    expect(output).toContain("providers: 0 configured, 0 active");
    expect(output).toContain("combos: 0");
    expect(output).toContain("API keys: 0");
  });

  it("/refresh reports zero models when the router is down", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const output = await executeSlashCommand("/refresh", state());
    expect(output).toContain("refreshed 9router config: 0 models, 0/0 active providers");
  });

  it("fetchModels falls back to catalog models when provider reconciliation fails", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "kr/base" }] });
      return jsonResponse({ error: "boom" }, { status: 500, statusText: "Internal Server Error" });
    });
    await expect(fetchModels(state())).resolves.toEqual([{ id: "kr/base" }]);
  });

  it("fetchModels skips connections that expose no usable alias", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "kr/base" }] });
      if (String(url).endsWith("/api/providers")) {
        return jsonResponse({ connections: [{ isActive: true, providerSpecificData: {} }] });
      }
      return jsonResponse({ error: "not found" }, { status: 404 });
    });
    await expect(fetchModels(state())).resolves.toEqual([{ id: "kr/base" }]);
  });

  it("/doctor passes when keys, providers, and models are all healthy", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).replace("http://127.0.0.1:20128", "");
      if (path === "/api/health") return jsonResponse({ ok: true });
      if (path === "/api/version") return jsonResponse({ currentVersion: "1.2.3", hasUpdate: true });
      if (path === "/api/keys") return jsonResponse({ keys: [{ id: "key_1", name: "Default" }] });
      if (path === "/api/providers") return jsonResponse({ connections: [{ provider: "kiro", isActive: true }] });
      if (path === "/v1/models") return jsonResponse({ data: [{ id: "kr/model-a" }] });
      return jsonResponse({ error: "not found" }, { status: 404 });
    });

    const output = await executeSlashCommand("/doctor", state());
    expect(output).toContain("all checks passed");
    expect(output).toContain("1.2.3 (update available)");
    expect(output).toContain("1 key(s) configured");
    expect(output).toContain("1 connection(s), 1 active");
    expect(output).toContain("1 models available");
  });

  it("/doctor reports every check as failing when the router is down", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const output = await executeSlashCommand("/doctor", state());
    expect(output).toContain("issues found");
    expect(output).toContain("unreachable");
    expect(output).toContain("could not fetch");
    expect(output).toContain("no keys found");
    expect(output).toContain("no providers");
    expect(output).toContain("no models found");
    expect(output).toContain("dashboard to connect a provider");
  });
});
