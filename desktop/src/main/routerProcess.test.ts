import { describe, expect, it, vi } from "vitest";
import { RouterProcess } from "./routerProcess";
import type { RouterClient } from "./routerClient";

const running = { baseURL: "http://127.0.0.1:20128/v1", apiKey: "k", wasStarted: false };

function setup(over: { ensure?: () => Promise<typeof running & { error?: string }>; ports?: boolean[]; shutdown?: () => Promise<void> } = {}) {
  const order: string[] = [];
  const ports = over.ports ?? [false];
  const client = {
    shutdown: vi.fn(async () => {
      order.push("shutdown");
      await (over.shutdown ?? (async () => undefined))();
    }),
  } as unknown as RouterClient;
  const ensureRouter = vi.fn(async () => {
    order.push("ensure");
    return (over.ensure ?? (async () => running))();
  });
  const isPortOpen = vi.fn(async () => {
    order.push("port");
    return ports.length > 1 ? (ports.shift() as boolean) : ports[0];
  });
  const sleep = vi.fn(async () => undefined);
  const proc = new RouterProcess(client, { ensureRouter, isPortOpen, sleep });
  return { proc, client, ensureRouter, isPortOpen, sleep, order };
}

describe("RouterProcess.start", () => {
  it("maps a started router", async () => {
    const { proc } = setup({ ensure: async () => ({ ...running, wasStarted: true }) });
    expect(await proc.start()).toEqual({ reachable: true, started: true, baseURL: running.baseURL });
  });

  it("maps a failure", async () => {
    const { proc } = setup({ ensure: async () => ({ ...running, error: "install failed" }) });
    expect(await proc.start()).toEqual({ reachable: false, started: false, baseURL: running.baseURL, error: "install failed" });
  });
});

describe("RouterProcess.stop", () => {
  it("shuts down then polls until the port closes", async () => {
    const { proc, client, isPortOpen, sleep } = setup({ ports: [true, true, false] });
    await proc.stop();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(isPortOpen).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("throws after 10 s of polling", async () => {
    const { proc, sleep } = setup({ ports: [true] });
    await expect(proc.stop()).rejects.toThrow("9router did not stop within 10s");
    expect(sleep).toHaveBeenCalledTimes(20);
  });
});

describe("RouterProcess.restart", () => {
  it("stops, confirms the port closed, then starts", async () => {
    const { proc, order } = setup({ ports: [false] });
    const result = await proc.restart();
    expect(order).toEqual(["shutdown", "port", "ensure"]);
    expect(result.reachable).toBe(true);
  });

  it("swallows a stop error when the port is already closed", async () => {
    const { proc, ensureRouter } = setup({ ports: [false], shutdown: async () => { throw new Error("boom"); } });
    await expect(proc.restart()).resolves.toMatchObject({ reachable: true });
    expect(ensureRouter).toHaveBeenCalledTimes(1);
  });

  it("rethrows a stop error while the port stays open", async () => {
    const { proc, ensureRouter } = setup({ ports: [true], shutdown: async () => { throw new Error("boom"); } });
    await expect(proc.restart()).rejects.toThrow("boom");
    expect(ensureRouter).not.toHaveBeenCalled();
  });
});
