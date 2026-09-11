/**
 * Start, stop, and restart the local 9router process. Starting delegates to
 * 9rh's `ensureRouter` (probe, install if missing, spawn detached, wait);
 * stopping asks the server to exit over its own API and waits for the port
 * to close.
 */

import { createConnection } from "net";
import { ensureRouter as ensureRouterDefault } from "9rh";
import type { RouterProcessResult } from "@shared/ipc";
import type { RouterClient } from "./routerClient";

export const NINE_ROUTER_PORT = 20128;
const STOP_POLL_MS = 500;
const STOP_POLLS = 20; // 10 s

export interface RouterProcessDeps {
  ensureRouter?: (url?: string, key?: string) => Promise<{ baseURL: string; apiKey: string; wasStarted: boolean; error?: string }>;
  isPortOpen?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/** Same probe `src/backends/router.ts` uses: TCP connect with a 3 s cap. */
export function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(port, "127.0.0.1");
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 3_000);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(false);
    });
  });
}

export class RouterProcess {
  private readonly ensureRouter: NonNullable<RouterProcessDeps["ensureRouter"]>;
  private readonly isPortOpen: NonNullable<RouterProcessDeps["isPortOpen"]>;
  private readonly sleep: NonNullable<RouterProcessDeps["sleep"]>;

  constructor(
    private readonly client: RouterClient,
    deps: RouterProcessDeps = {},
  ) {
    this.ensureRouter = deps.ensureRouter ?? ensureRouterDefault;
    this.isPortOpen = deps.isPortOpen ?? isPortOpen;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async start(): Promise<RouterProcessResult> {
    const r = await this.ensureRouter();
    const result: RouterProcessResult = { reachable: !r.error, started: r.wasStarted, baseURL: r.baseURL };
    if (r.error) result.error = r.error;
    return result;
  }

  async stop(): Promise<void> {
    await this.client.shutdown();
    for (let i = 0; i < STOP_POLLS; i++) {
      if (!(await this.isPortOpen(NINE_ROUTER_PORT))) return;
      await this.sleep(STOP_POLL_MS);
    }
    throw new Error("9router did not stop within 10s");
  }

  async restart(): Promise<RouterProcessResult> {
    try {
      await this.stop();
    } catch (err) {
      if (await this.isPortOpen(NINE_ROUTER_PORT)) throw err;
    }
    return this.start();
  }
}
