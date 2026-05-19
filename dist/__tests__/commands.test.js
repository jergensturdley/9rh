import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { executeSlashCommand, fetchModels, filterModels, formatModelsList } from "../commands.js";
function state(apiKey = "session-key") {
    return {
        baseURL: "http://localhost:20128/v1",
        apiKey,
        model: "kr/test-model",
        workDir: "/tmp",
        useColor: false,
    };
}
function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        statusText: init.statusText,
        headers: { "content-type": "application/json" },
    });
}
describe("executeSlashCommand native API auth", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it("uses 9router CLI-token auth for /keys instead of Bearer API-key auth", async () => {
        const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
            const headers = init?.headers ?? {};
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
            const headers = init?.headers ?? {};
            return headers["x-9r-cli-token"] && !("Authorization" in headers)
                ? jsonResponse({ combos: [{ name: "fallback combo", kind: "fallback", models: ["a", "b"] }] })
                : jsonResponse({ error: "unauthorized" }, { status: 401, statusText: "Unauthorized" });
        });
        const output = await executeSlashCommand("/combos", state("bad-session-key"));
        expect(output).toContain("fallback combo");
        expect(output).not.toContain("Command failed");
        expect(fetchMock).toHaveBeenCalledWith("http://localhost:20128/api/combos", expect.objectContaining({ headers: expect.objectContaining({ "x-9r-cli-token": expect.any(String) }) }));
    });
    it.each([
        ["/providers", { connections: [{ name: "OpenRouter", provider: "openrouter", isActive: true }] }, "OpenRouter"],
        ["/status", { ok: true }, "9router is running"],
    ])("uses CLI-token auth for %s", async (command, body, expected) => {
        jest.spyOn(globalThis, "fetch").mockImplementation(async (url, requestInit) => {
            const headers = requestInit?.headers ?? {};
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
            const path = String(url).replace("http://localhost:20128", "");
            if (path === "/api/health")
                return jsonResponse({ ok: true });
            if (path === "/api/version")
                return jsonResponse({ currentVersion: "1.0.0", hasUpdate: false });
            if (path === "/api/keys")
                return jsonResponse({ keys: [] });
            if (path === "/api/providers")
                return jsonResponse({ connections: [] });
            if (path === "/v1/models")
                return jsonResponse({ data: [{ id: "catalog/model-a" }] });
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
            if (String(url).endsWith("/api/providers"))
                return jsonResponse({ connections: [] });
            return jsonResponse({ data: [{ id: "kr/model-a", owned_by: "9router" }, { id: 42 }] });
        });
        await expect(fetchModels(state("model-key"))).resolves.toEqual([{ id: "kr/model-a", owned_by: "9router" }]);
        expect(fetchMock).toHaveBeenCalledWith("http://localhost:20128/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer model-key" } }));
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
            if (String(url).endsWith("/v1/models"))
                return jsonResponse({ data: [] });
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
            if (String(url).endsWith("/v1/models"))
                return jsonResponse({ data: [{ id: "kr/claude-sonnet-4.5" }] });
            if (String(url).endsWith("/api/providers"))
                return jsonResponse({ connections: [] });
            return jsonResponse({ error: "not found" }, { status: 404 });
        });
        const current = state("model-key");
        const output = await executeSlashCommand("/switch made-up-model", current);
        expect(output).toContain("Unknown model");
        expect(current.model).toBe("kr/test-model");
    });
    it("filters and formats models consistently for static fallback output", () => {
        const models = [
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
});
//# sourceMappingURL=commands.test.js.map