import { afterAll, afterEach, describe, expect, it, jest } from "@jest/globals";
import { createServer, type Server } from "net";
import {
  RouterBackend,
  nativeBase,
  isPortOpen,
  fetchRouterJSON,
} from "../backends/router.js";

function res(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const fetchSpy = jest.spyOn(globalThis, "fetch");
afterEach(() => {
  fetchSpy.mockReset();
});
afterAll(() => {
  fetchSpy.mockRestore();
});

function backend(wasStarted = false): RouterBackend {
  return new RouterBackend("http://router.test/v1", "key-123", "stored-key", wasStarted);
}

describe("nativeBase", () => {
  it("strips a trailing /v1 or /v1/", () => {
    expect(nativeBase("http://x/v1")).toBe("http://x");
    expect(nativeBase("http://x/v1/")).toBe("http://x");
  });
  it("leaves a URL without /v1 unchanged", () => {
    expect(nativeBase("http://x")).toBe("http://x");
  });
});

describe("fetchRouterJSON", () => {
  it("returns parsed JSON on a 2xx response", async () => {
    fetchSpy.mockResolvedValue(res(true, { hello: "world" }));
    await expect(fetchRouterJSON("http://x", "k")).resolves.toEqual({ hello: "world" });
  });
  it("returns null on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue(res(false, null));
    await expect(fetchRouterJSON("http://x", "k")).resolves.toBeNull();
  });
  it("returns null when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("boom"));
    await expect(fetchRouterJSON("http://x", "k")).resolves.toBeNull();
  });
});

describe("RouterBackend", () => {
  it("describe reflects auto-started vs connected origin", () => {
    expect(backend(true).describe()).toMatch(/auto-started/);
    expect(backend(false).describe()).toMatch(/connected/);
  });

  it("getStoredKey returns the discovered key", () => {
    expect(backend().getStoredKey()).toBe("stored-key");
  });

  it("listModels keeps only well-formed model entries", async () => {
    fetchSpy.mockResolvedValue(res(true, { data: [{ id: "m1" }, { nope: true }, 42] }));
    await expect(backend().listModels()).resolves.toEqual([{ id: "m1" }]);
  });

  it("listModels returns [] when data is not an array", async () => {
    fetchSpy.mockResolvedValue(res(true, { data: "oops" }));
    await expect(backend().listModels()).resolves.toEqual([]);
  });

  it("listModels returns [] on a failed fetch", async () => {
    fetchSpy.mockResolvedValue(res(false, null));
    await expect(backend().listModels()).resolves.toEqual([]);
  });

  it("health maps {ok:true} to reachable with the native URL", async () => {
    fetchSpy.mockResolvedValue(res(true, { ok: true }));
    await expect(backend().health()).resolves.toEqual({
      reachable: true,
      url: "http://router.test",
    });
  });

  it("health reports unreachable when the probe fails", async () => {
    fetchSpy.mockResolvedValue(res(false, null));
    await expect(backend().health()).resolves.toMatchObject({ reachable: false });
  });

  it.each([
    ["listProviders", "connections"],
    ["listCombos", "combos"],
    ["listKeys", "keys"],
  ] as const)("%s filters to objects and tolerates bad shapes", async (method, field) => {
    fetchSpy.mockResolvedValue(res(true, { [field]: [{ a: 1 }, "junk", null] }));
    await expect((backend() as unknown as Record<string, () => Promise<unknown[]>>)[method]())
      .resolves.toEqual([{ a: 1 }]);

    fetchSpy.mockResolvedValue(res(true, {}));
    await expect((backend() as unknown as Record<string, () => Promise<unknown[]>>)[method]())
      .resolves.toEqual([]);
  });
});

describe("isPortOpen", () => {
  it("resolves false for a closed port", async () => {
    await expect(isPortOpen(1)).resolves.toBe(false);
  });

  it("resolves true when something is listening", async () => {
    const server: Server = createServer();
    const port: number = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });
    try {
      await expect(isPortOpen(port)).resolves.toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
