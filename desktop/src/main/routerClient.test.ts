import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterClient } from "./routerClient";

const BASE = "http://router.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeClient(fetchImpl: typeof fetch, opts: { token?: string; bearer?: string } = {}): RouterClient {
  return new RouterClient({
    nativeBase: BASE,
    fetchImpl,
    getToken: async () => opts.token ?? "tok-123",
    getBearer: async () => opts.bearer ?? "sk-fallback",
  });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("RouterClient base URL", () => {
  it("defaults from NINE_ROUTER_URL with /v1 stripped and localhost rewritten", () => {
    vi.stubEnv("NINE_ROUTER_URL", "http://localhost:20128/v1");
    const client = new RouterClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(client.base).toBe("http://127.0.0.1:20128");
    expect(client.dashboardUrl()).toBe("http://127.0.0.1:20128/dashboard");
  });

  it("falls back to 127.0.0.1:20128", () => {
    vi.stubEnv("NINE_ROUTER_URL", "");
    const client = new RouterClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(client.base).toBe("http://127.0.0.1:20128");
  });
});

describe("RouterClient requests", () => {
  it("GET providers: url, method, token header, timeout signal, unwraps connections", async () => {
    const fetchMock = vi.fn(async () => json({ connections: [{ id: "p1", provider: "openai", isActive: true }] }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const providers = await client.providers();
    expect(providers).toEqual([{ id: "p1", provider: "openai", isActive: true }]);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/api/providers`);
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-9r-cli-token"]).toBe("tok-123");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });

  it("falls back to a bearer key when the CLI token is empty", async () => {
    const fetchMock = vi.fn(async () => json({ keys: [] }));
    const client = makeClient(fetchMock as unknown as typeof fetch, { token: "", bearer: "sk-1" });
    await client.keys();
    const headers = lastCall(fetchMock).init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-1");
    expect(headers["x-9r-cli-token"]).toBeUndefined();
  });

  it("POST createCombo: JSON body with kind defaulted to null, unwraps {combo}", async () => {
    const fetchMock = vi.fn(async () => json({ combo: { id: "c1", name: "fast", kind: null, models: ["a/b"] } }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const combo = await client.createCombo({ name: "fast", models: ["a/b"] });
    expect(combo).toEqual({ id: "c1", name: "fast", kind: null, models: ["a/b"] });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/api/combos`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ name: "fast", models: ["a/b"], kind: null });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("createKey returns a bare record as-is", async () => {
    const fetchMock = vi.fn(async () => json({ id: "k1", key: "sk-x", name: "n", isActive: true }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const key = await client.createKey("n");
    expect(key.id).toBe("k1");
    expect(JSON.parse(lastCall(fetchMock).init.body as string)).toEqual({ name: "n" });
  });

  it("PUT setProviderActive and DELETE deleteKey", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await client.setProviderActive("p 1", false);
    let call = lastCall(fetchMock);
    expect(call.url).toBe(`${BASE}/api/providers/p%201`);
    expect(call.init.method).toBe("PUT");
    expect(JSON.parse(call.init.body as string)).toEqual({ isActive: false });

    await client.deleteKey("k1");
    call = lastCall(fetchMock);
    expect(call.url).toBe(`${BASE}/api/keys/k1`);
    expect(call.init.method).toBe("DELETE");
  });

  it("usageLogs passes limit and accepts a bare array", async () => {
    const fetchMock = vi.fn(async () => json(["06-09-2026 18:20:35 | m | P | 1 | 10 | 2 | ok"]));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const logs = await client.usageLogs(7);
    expect(logs).toHaveLength(1);
    expect(lastCall(fetchMock).url).toBe(`${BASE}/api/usage/request-logs?limit=7`);
    expect(await client.usageLogs()).toHaveLength(1);
    expect(lastCall(fetchMock).url).toBe(`${BASE}/api/usage/request-logs?limit=50`);
  });
});

describe("RouterClient errors", () => {
  it("maps {error: string}", async () => {
    const client = makeClient((async () => json({ error: "nope" }, 400)) as unknown as typeof fetch);
    await expect(client.version()).rejects.toThrow("nope");
  });

  it("maps {error: {message}}", async () => {
    const client = makeClient((async () => json({ error: { message: "deeper" } }, 422)) as unknown as typeof fetch);
    await expect(client.combos()).rejects.toThrow("deeper");
  });

  it("falls back to HTTP <status> with no body", async () => {
    const client = makeClient((async () => new Response(null, { status: 500 })) as unknown as typeof fetch);
    await expect(client.settings()).rejects.toThrow("HTTP 500");
  });

  it("wraps network failures with the base url", async () => {
    const client = makeClient((async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    }) as unknown as typeof fetch);
    await expect(client.models()).rejects.toThrow("9router unreachable at http://router.test: ECONNREFUSED");
  });

  it("health never throws", async () => {
    const down = makeClient((async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch);
    expect(await down.health()).toEqual({ reachable: false, url: BASE, detail: "9router unreachable at http://router.test: boom" });
    const up = makeClient((async () => json({ ok: true })) as unknown as typeof fetch);
    expect(await up.health()).toEqual({ reachable: true, url: BASE });
  });

  it("statusBundle nulls failed parts", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/version")) return json({ error: "x" }, 500);
      if (url.endsWith("/api/health")) return json({ ok: true });
      return json({ requireLogin: false, authMode: "none", tunnel: { enabled: false, running: false } });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const bundle = await client.statusBundle();
    expect(bundle.health.reachable).toBe(true);
    expect(bundle.version).toBeNull();
    expect(bundle.auth).not.toBeNull();
    expect(bundle.tunnel).not.toBeNull();
  });

  it("shutdown swallows connection drops but not HTTP errors", async () => {
    const dropped = makeClient((async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch);
    await expect(dropped.shutdown()).resolves.toBeUndefined();
    const denied = makeClient((async () => json({ error: "unauthorized" }, 401)) as unknown as typeof fetch);
    await expect(denied.shutdown()).rejects.toThrow("unauthorized");
  });
});

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  });
}

describe("RouterClient usageStream", () => {
  it("parses data: lines and resolves once aborted", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(sseBody(['data: {"totalRequests":1}\n', 'event: ping\ndata: {"totalRequests":2}\n\n']), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const ac = new AbortController();
    const seen: number[] = [];
    await client.usageStream((s) => {
      seen.push(s.totalRequests);
      if (seen.length === 2) ac.abort();
    }, ac.signal);
    expect(seen).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = lastCall(fetchMock).init.headers as Record<string, string>;
    expect(headers["x-9r-cli-token"]).toBe("tok-123");
    expect(headers.Accept).toBe("text/event-stream");
  });

  it("reconnects with backoff after the stream ends", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(sseBody([]), { status: 200 }))
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(new Response(sseBody(['data: {"totalRequests":9}\n']), { status: 200 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const ac = new AbortController();
    const seen: number[] = [];
    const done = client.usageStream((s) => {
      seen.push(s.totalRequests);
      ac.abort();
    }, ac.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await done;
    expect(seen).toEqual([9]);
  });
});
