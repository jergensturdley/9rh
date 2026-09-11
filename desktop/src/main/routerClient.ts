/**
 * Thin fetch wrapper over 9router's native `/api/*` REST API.
 *
 * This is the only module that knows 9router URLs. Every method returns the
 * plain value (or throws); the IPC layer wraps results in `IpcResult`.
 * Auth is the CLI token header the 9rh CLI already uses, with a bearer key
 * fallback when no token can be derived.
 */

import { getCliToken, readFirstApiKey } from "9rh";
import type { RouterStatusBundle } from "@shared/ipc";
import type {
  RouterApiKey,
  RouterAuthStatus,
  RouterCombo,
  RouterComboInput,
  RouterHealth,
  RouterModel,
  RouterModelAvailability,
  RouterProvider,
  RouterSettingsSummary,
  RouterTunnelStatus,
  RouterUsageChartPoint,
  RouterUsageStats,
  RouterVersion,
} from "@shared/routerTypes";

export interface RouterClientOptions {
  nativeBase?: string;
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
  getBearer?: () => Promise<string>;
}

const DEFAULT_BASE = "http://127.0.0.1:20128";
const GET_TIMEOUT_MS = 5_000;
const MUTATION_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 15_000;
/** Tag on errors thrown when the request never got an HTTP response. */
const UNREACHABLE = "ERR_ROUTER_UNREACHABLE";

function normalizeBase(raw: string): string {
  return raw.replace(/\/v1\/?$/, "").replace(/\/$/, "").replace("localhost", "127.0.0.1");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return "timed out";
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return err.message;
}

async function errorMessage(res: Response): Promise<string> {
  const fallback = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    if (!text) return fallback;
    const body: unknown = JSON.parse(text);
    const err = isObj(body) ? body.error : undefined;
    if (typeof err === "string" && err) return err;
    if (isObj(err) && typeof err.message === "string") return err.message;
  } catch {
    // non-JSON body: fall through
  }
  return fallback;
}

/** `{ key: [...] }` or a bare array; anything else is an empty list. */
function pickArray<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (isObj(body) && Array.isArray(body[key])) return body[key] as T[];
  return [];
}

/** Create/update responses come back as `{combo:{...}}`, `{key:{...}}`, or the bare record. */
function unwrapRecord<T>(body: unknown): T {
  if (isObj(body)) {
    if ("id" in body) return body as T;
    for (const v of Object.values(body)) if (isObj(v) && "id" in v) return v as T;
  }
  return body as T;
}

function parseSseLine(line: string): RouterUsageStats | null {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.startsWith("data:")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(5).trim());
    return isObj(parsed) ? (parsed as RouterUsageStats) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class RouterClient {
  readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getToken: () => Promise<string>;
  private readonly getBearer: () => Promise<string>;

  constructor(options: RouterClientOptions = {}) {
    this.base = normalizeBase(options.nativeBase ?? (process.env.NINE_ROUTER_URL || DEFAULT_BASE));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getToken = options.getToken ?? getCliToken;
    this.getBearer = options.getBearer ?? (async () => (await readFirstApiKey()) ?? "9router");
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Never throws: the console renders the unreachable state inline. */
  async health(): Promise<RouterHealth> {
    try {
      const body = await this.request<{ ok?: boolean }>("GET", "/api/health");
      return body?.ok === true
        ? { reachable: true, url: this.base }
        : { reachable: false, url: this.base, detail: "unexpected health response" };
    } catch (err) {
      return { reachable: false, url: this.base, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  version(): Promise<RouterVersion> {
    return this.request("GET", "/api/version");
  }

  authStatus(): Promise<RouterAuthStatus> {
    return this.request("GET", "/api/auth/status");
  }

  tunnelStatus(): Promise<RouterTunnelStatus> {
    return this.request("GET", "/api/tunnel/status");
  }

  async statusBundle(): Promise<RouterStatusBundle> {
    const [health, version, auth, tunnel] = await Promise.allSettled([
      this.health(),
      this.version(),
      this.authStatus(),
      this.tunnelStatus(),
    ]);
    const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
    return {
      health: settled(health) ?? { reachable: false, url: this.base },
      version: settled(version),
      auth: settled(auth),
      tunnel: settled(tunnel),
    };
  }

  settings(): Promise<RouterSettingsSummary> {
    return this.request("GET", "/api/settings");
  }

  // -------------------------------------------------------------------------
  // Providers
  // -------------------------------------------------------------------------

  async providers(): Promise<RouterProvider[]> {
    return pickArray(await this.request("GET", "/api/providers"), "connections");
  }

  testProvider(id: string): Promise<unknown> {
    return this.request("POST", `/api/providers/${encodeURIComponent(id)}/test`);
  }

  async setProviderActive(id: string, isActive: boolean): Promise<void> {
    await this.request("PUT", `/api/providers/${encodeURIComponent(id)}`, { isActive });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.request("DELETE", `/api/providers/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // Combos
  // -------------------------------------------------------------------------

  async combos(): Promise<RouterCombo[]> {
    return pickArray(await this.request("GET", "/api/combos"), "combos");
  }

  async createCombo(input: RouterComboInput): Promise<RouterCombo> {
    return unwrapRecord(await this.request("POST", "/api/combos", comboBody(input)));
  }

  async updateCombo(id: string, input: RouterComboInput): Promise<RouterCombo> {
    return unwrapRecord(await this.request("PUT", `/api/combos/${encodeURIComponent(id)}`, comboBody(input)));
  }

  async deleteCombo(id: string): Promise<void> {
    await this.request("DELETE", `/api/combos/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------

  async keys(): Promise<RouterApiKey[]> {
    return pickArray(await this.request("GET", "/api/keys"), "keys");
  }

  async createKey(name: string): Promise<RouterApiKey> {
    return unwrapRecord(await this.request("POST", "/api/keys", { name }));
  }

  async deleteKey(id: string): Promise<void> {
    await this.request("DELETE", `/api/keys/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // Models and usage
  // -------------------------------------------------------------------------

  async models(): Promise<RouterModel[]> {
    return pickArray(await this.request("GET", "/api/models"), "models");
  }

  async availability(): Promise<RouterModelAvailability[]> {
    return pickArray(await this.request("GET", "/api/models/availability"), "models");
  }

  usageStats(): Promise<RouterUsageStats> {
    return this.request("GET", "/api/usage/stats");
  }

  async usageChart(): Promise<RouterUsageChartPoint[]> {
    return pickArray(await this.request("GET", "/api/usage/chart"), "chart");
  }

  async usageLogs(limit = 50): Promise<string[]> {
    return pickArray(await this.request("GET", `/api/usage/request-logs?limit=${limit}`), "logs");
  }

  // -------------------------------------------------------------------------
  // Process and dashboard
  // -------------------------------------------------------------------------

  /** The server exits mid-response, so a dropped connection counts as success. */
  async shutdown(): Promise<void> {
    try {
      await this.request("POST", "/api/shutdown");
    } catch (err) {
      if ((err as { code?: string }).code !== UNREACHABLE) throw err;
    }
  }

  dashboardUrl(): string {
    return `${this.base}/dashboard`;
  }

  /**
   * Follow `GET /api/usage/stream` (server-sent events, one `data: <json>`
   * line per message) until `signal` aborts, reconnecting with backoff.
   */
  async usageStream(onStats: (s: RouterUsageStats) => void, signal: AbortSignal): Promise<void> {
    let delay = BACKOFF_START_MS;
    while (!signal.aborted) {
      let gotData = false;
      try {
        gotData = await this.readSse(onStats, signal);
      } catch {
        // dropped or refused: fall through to the backoff wait
      }
      if (signal.aborted) return;
      if (gotData) delay = BACKOFF_START_MS;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, BACKOFF_CAP_MS);
    }
  }

  private async readSse(onStats: (s: RouterUsageStats) => void, signal: AbortSignal): Promise<boolean> {
    const headers = await this.authHeaders();
    headers.Accept = "text/event-stream";
    const res = await this.fetchImpl(`${this.base}/api/usage/stream`, { method: "GET", headers, signal });
    if (!res.ok) throw new Error(await errorMessage(res));
    if (!res.body) return false;
    // ponytail: single-line `data:` frames only; multi-line data and `event:`
    // names are not needed for 9router's stream. Add an SSE frame parser if
    // a future 9router emits them.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let gotData = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const stats = parseSseLine(line);
        if (stats) {
          gotData = true;
          onStats(stats);
        }
      }
    }
    return gotData;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (token) return { "x-9r-cli-token": token };
    return { Authorization: `Bearer ${await this.getBearer()}` };
  }

  private async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const headers = await this.authHeaders();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS),
      });
    } catch (err) {
      const wrapped = new Error(`9router unreachable at ${this.base}: ${describeCause(err)}`);
      (wrapped as { code?: string }).code = UNREACHABLE;
      throw wrapped;
    }
    if (!res.ok) throw new Error(await errorMessage(res));
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`9router returned non-JSON for ${method} ${path}`);
    }
  }
}

function comboBody(input: RouterComboInput): { name: string; models: string[]; kind: string | null } {
  return { name: input.name, models: input.models, kind: input.kind ?? null };
}
