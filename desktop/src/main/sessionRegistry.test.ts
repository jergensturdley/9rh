import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, DetectResult } from "9rh";
import type { SessionCreateInput, SessionSnapshot } from "@shared/ipc";
import { SessionRegistry, type SessionRegistryDeps } from "./sessionRegistry";

// Derived from the registry's own contract so this test never loads sessionHost.ts.
type Host = ReturnType<NonNullable<SessionRegistryDeps["createHost"]>>;
type HostDeps = Parameters<NonNullable<SessionRegistryDeps["createHost"]>>[3];

interface FakeHost {
  id: string;
  input: SessionCreateInput;
  model: string;
  hostDeps: HostDeps;
  disposed: boolean;
  hostWarnings: string[];
  snapshot(): SessionSnapshot;
  dispose(): void;
}

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

const WORK_DIR = tmpdir();

function setup(over: Partial<SessionRegistryDeps> & { detect?: Partial<DetectResult> } = {}) {
  const hosts: FakeHost[] = [];
  const changed: SessionSnapshot[] = [];
  const removed: string[] = [];
  const { detect, ...depsOver } = over;
  const deps: SessionRegistryDeps = {
    emit: () => {},
    onChanged: (s) => changed.push(s),
    onRemoved: (id) => removed.push(id),
    resolveBackend: async () => ({ backend: fakeBackend(), warnings: [], ambiguous: false, ...detect }),
    createHost: (id, input, model, hostDeps) => {
      const host: FakeHost = {
        id,
        input,
        model,
        hostDeps,
        disposed: false,
        hostWarnings: [],
        snapshot: () =>
          ({ id, workDir: input.workDir, model, warnings: host.hostWarnings }) as unknown as SessionSnapshot,
        dispose: () => {
          host.disposed = true;
        },
      };
      hosts.push(host);
      return host as unknown as Host;
    },
    readUserConfig: async () => ({}),
    now: () => 1_000_000,
    ...depsOver,
  };
  return { registry: new SessionRegistry(deps), hosts, changed, removed };
}

beforeEach(() => vi.stubEnv("NINE_ROUTER_MODEL", ""));
afterEach(() => vi.unstubAllEnvs());

describe("SessionRegistry.create", () => {
  it("rejects a missing or non-directory workDir", async () => {
    const { registry, hosts } = setup();
    await expect(registry.create({ workDir: "/definitely/not/here" })).rejects.toThrow(/not a directory/);
    await expect(registry.create({ workDir: fileURLToPath(import.meta.url) })).rejects.toThrow(/not a directory/);
    expect(hosts).toHaveLength(0);
  });

  it("uses the requested model when given", async () => {
    const { registry } = setup();
    const snap = await registry.create({ workDir: WORK_DIR, model: "m1" });
    expect(snap.model).toBe("m1");
  });

  it("defaults a router session from user config with provider prefixing", async () => {
    const { registry } = setup({
      readUserConfig: async () => ({ defaultModel: "sonnet", defaultProvider: "kr" }),
    });
    expect((await registry.create({ workDir: WORK_DIR })).model).toBe("kr/sonnet");
  });

  it("defaults a router session to the engine default when nothing is configured", async () => {
    const { registry } = setup();
    expect((await registry.create({ workDir: WORK_DIR })).model).toBe("kr/claude-sonnet-4.5");
  });

  it("defaults a direct session to the first listed model", async () => {
    const backend = fakeBackend({ name: "direct", listModels: async () => [{ id: "gpt-x" }, { id: "gpt-y" }] });
    const { registry } = setup({ detect: { backend } });
    expect((await registry.create({ workDir: WORK_DIR })).model).toBe("gpt-x");
  });

  it("defaults a direct session to gpt-4o when the endpoint lists nothing", async () => {
    const { registry } = setup({ detect: { backend: fakeBackend({ name: "direct" }) } });
    expect((await registry.create({ workDir: WORK_DIR })).model).toBe("gpt-4o");
  });

  it("prefers user config over the endpoint for a direct session", async () => {
    const backend = fakeBackend({ name: "direct", listModels: async () => [{ id: "gpt-x" }] });
    const { registry } = setup({ detect: { backend }, readUserConfig: async () => ({ defaultModel: "o3" }) });
    expect((await registry.create({ workDir: WORK_DIR })).model).toBe("o3");
  });

  it("mints unique ids even with a frozen clock", async () => {
    const { registry } = setup();
    const a = await registry.create({ workDir: WORK_DIR });
    const b = await registry.create({ workDir: WORK_DIR });
    expect(a.id).toMatch(/^s-[0-9a-z]+-1$/);
    expect(b.id).toMatch(/^s-[0-9a-z]+-2$/);
    expect(a.id).not.toBe(b.id);
  });

  it("passes backend, emit, and now through to the host", async () => {
    const backend = fakeBackend();
    const emit = () => {};
    const now = () => 42;
    const { registry, hosts } = setup({ detect: { backend }, emit, now });
    const snap = await registry.create({ workDir: WORK_DIR, model: "m" });
    expect(hosts[0].id).toBe(snap.id);
    expect(hosts[0].hostDeps.backend).toBe(backend);
    expect(hosts[0].hostDeps.emit).toBe(emit);
    expect(hosts[0].hostDeps.now).toBe(now);
  });
});

describe("SessionRegistry warnings", () => {
  it("merges resolve warnings ahead of host warnings in get, list, and onChanged", async () => {
    const { registry, hosts, changed } = setup({ detect: { warnings: ["ambiguous config"] } });
    const snap = await registry.create({ workDir: WORK_DIR, model: "m" });
    expect(snap.warnings).toEqual(["ambiguous config"]);
    hosts[0].hostWarnings = ["host says hi"];
    expect(registry.get(snap.id).warnings).toEqual(["ambiguous config", "host says hi"]);
    expect(registry.list()[0].warnings).toEqual(["ambiguous config", "host says hi"]);
    hosts[0].hostDeps.onChanged(hosts[0].snapshot());
    expect(changed[0].warnings).toEqual(["ambiguous config", "host says hi"]);
  });
});

describe("SessionRegistry lookup and removal", () => {
  it("lists in creation order", async () => {
    const { registry } = setup();
    const a = await registry.create({ workDir: WORK_DIR, model: "a" });
    const b = await registry.create({ workDir: WORK_DIR, model: "b" });
    expect(registry.list().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("throws for unknown ids", () => {
    const { registry } = setup();
    expect(() => registry.get("nope")).toThrow("unknown session nope");
    expect(() => registry.host("nope")).toThrow("unknown session nope");
    expect(() => registry.remove("nope")).toThrow("unknown session nope");
  });

  it("host returns the underlying host", async () => {
    const { registry, hosts } = setup();
    const snap = await registry.create({ workDir: WORK_DIR, model: "m" });
    expect(registry.host(snap.id)).toBe(hosts[0] as unknown as Host);
  });

  it("remove disposes the host, forgets it, and notifies", async () => {
    const { registry, hosts, removed } = setup();
    const snap = await registry.create({ workDir: WORK_DIR, model: "m" });
    registry.remove(snap.id);
    expect(hosts[0].disposed).toBe(true);
    expect(removed).toEqual([snap.id]);
    expect(registry.list()).toEqual([]);
    expect(() => registry.get(snap.id)).toThrow(/unknown session/);
  });

  it("disposeAll disposes every host without onRemoved pushes", async () => {
    const { registry, hosts, removed } = setup();
    await registry.create({ workDir: WORK_DIR, model: "m" });
    await registry.create({ workDir: WORK_DIR, model: "m" });
    registry.disposeAll();
    expect(hosts.every((h) => h.disposed)).toBe(true);
    expect(removed).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});
