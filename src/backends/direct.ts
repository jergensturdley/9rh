import type {
  Backend,
  HealthSnapshot,
  KeyInfo,
  ModelInfo,
  ProviderInfo,
} from "./backend.js";

/**
 * Talk directly to an OpenAI-compatible endpoint, no 9router in the loop.
 *
 * Works against:
 *   - OpenAI: `https://api.openai.com/v1` + `OPENAI_API_KEY`
 *   - OpenRouter: `https://openrouter.ai/api/v1` + `OPENROUTER_API_KEY`
 *   - LiteLLM proxy, vLLM, Ollama's OpenAI-compat mode, etc.
 *
 * The endpoint must speak the OpenAI `/v1/models` and `/v1/chat/completions`
 * shape. If it doesn't, listModels returns [] and the chat call will fail
 * with whatever the upstream returns — the Backend stays hands-off.
 */
export class DirectBackend implements Backend {
  readonly name = "direct" as const;
  readonly hasNativeRouter = false;

  constructor(
    public readonly baseURL: string,
    public readonly apiKey: string,
    private readonly source: "cli" | "env" | "default" = "cli",
  ) {}

  describe(): string {
    return `direct (${this.source}) → ${this.baseURL}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: unknown };
      if (!Array.isArray(json?.data)) return [];
      return json.data.filter(isModelInfo);
    } catch {
      return [];
    }
  }

  async health(): Promise<HealthSnapshot> {
    try {
      const res = await fetch(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      return {
        reachable: res.ok,
        url: this.baseURL,
        detail: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        reachable: false,
        url: this.baseURL,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Direct backends don't have providers / combos / keys views — the methods
  // are intentionally absent from the returned object so callers can check
  // `backend.listProviders?.()` and get a clean "not supported" path.
}

function isModelInfo(value: unknown): value is ModelInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

// ProviderInfo/KeyInfo types are re-exported here so consumers can import
// from a single path; the direct backend simply doesn't implement them.
export type { ProviderInfo, KeyInfo, ModelInfo, HealthSnapshot };
