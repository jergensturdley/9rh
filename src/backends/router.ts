import { existsSync, openSync, closeSync } from "fs";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createConnection } from "net";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { execFileSync } from "child_process";
import chalk from "chalk";
import type {
  Backend,
  ComboInfo,
  HealthSnapshot,
  KeyInfo,
  ModelInfo,
  ProviderInfo,
} from "./backend.js";

const execFileAsync = promisify(execFile);

const NINE_ROUTER_PORT = 20128;
const NINE_ROUTER_NATIVE = `http://127.0.0.1:${NINE_ROUTER_PORT}`;
const NINE_ROUTER_OPENAI = `${NINE_ROUTER_NATIVE}/v1`;
const NINE_ROUTER_DEFAULT_KEY = "9router";

function nativeBase(openAIURL: string): string {
  return openAIURL.replace(/\/v1\/?$/, "");
}

function isPortOpen(port: number): Promise<boolean> {
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

async function fetchJSON<T>(url: string, apiKey: string, timeoutMs = 3_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function readFirstApiKey(): string | null {
  try {
    const dbPath = `${homedir()}/.9router/db/data.sqlite`;
    if (!existsSync(dbPath)) return null;
    const key = execFileSync("sqlite3", [dbPath, "SELECT key FROM apiKeys LIMIT 1"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return key || null;
  } catch {
    return null;
  }
}

/**
 * The original 9router behavior, extracted into a Backend impl.
 *
 * This is a thin wrapper today — the heavy lifting (auto-starting 9router,
 * sqlite key lookup, health probes) is still in `init.ts` because commands.ts
 * and the legacy code paths call it directly. Future refactor: move
 * `ensureRouter` into this file as `RouterBackend.ensureReady()`.
 */
export class RouterBackend implements Backend {
  readonly name = "router" as const;
  readonly hasNativeRouter = true;

  constructor(
    public readonly baseURL: string,
    public readonly apiKey: string,
    private readonly storedKey: string | null,
    private readonly wasStarted: boolean,
  ) {}

  describe(): string {
    const origin = this.wasStarted ? "auto-started" : "connected";
    return `router (${origin}) → ${this.baseURL}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const json = await fetchJSON<{ data?: unknown }>(
      `${this.baseURL}/models`,
      this.apiKey,
      5_000,
    );
    if (!json || !Array.isArray(json.data)) return [];
    return json.data.filter(isModelInfo);
  }

  async health(): Promise<HealthSnapshot> {
    const ok = await fetchJSON<{ ok?: boolean }>(
      `${nativeBase(this.baseURL)}/api/health`,
      this.apiKey,
      3_000,
    );
    return {
      reachable: Boolean(ok?.ok),
      url: nativeBase(this.baseURL),
    };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const json = await fetchJSON<{ connections?: unknown }>(
      `${nativeBase(this.baseURL)}/api/providers`,
      this.apiKey,
    );
    if (!json || !Array.isArray(json.connections)) return [];
    return json.connections.filter(isObject);
  }

  async listCombos(): Promise<ComboInfo[]> {
    const json = await fetchJSON<{ combos?: unknown }>(
      `${nativeBase(this.baseURL)}/api/combos`,
      this.apiKey,
    );
    if (!json || !Array.isArray(json.combos)) return [];
    return json.combos.filter(isObject);
  }

  async listKeys(): Promise<KeyInfo[]> {
    const json = await fetchJSON<{ keys?: unknown }>(
      `${nativeBase(this.baseURL)}/api/keys`,
      this.apiKey,
    );
    if (!json || !Array.isArray(json.keys)) return [];
    return json.keys.filter(isObject);
  }

  /** Convenience for callers that want the discovered key (used by legacy code paths). */
  getStoredKey(): string | null {
    return this.storedKey;
  }
}

function isModelInfo(value: unknown): value is ModelInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Re-exports so callers can build a RouterBackend using the existing
// ensureRouter() helper without reaching into init.ts internals.
// ---------------------------------------------------------------------------

export {
  NINE_ROUTER_NATIVE,
  NINE_ROUTER_OPENAI,
  NINE_ROUTER_DEFAULT_KEY,
  isPortOpen,
  nativeBase,
  readFirstApiKey,
  fetchJSON as fetchRouterJSON,
};
