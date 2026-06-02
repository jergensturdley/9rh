/**
 * Backend abstraction over the LLM provider.
 *
 * A Backend is the thing that knows:
 *   - which baseURL to send chat requests to (OpenAI-compatible)
 *   - which apiKey to use as the bearer token
 *   - how to enumerate the available models
 *   - (optionally) how to expose 9router-native data: providers, combos, keys
 *
 * Three concrete backends ship with 9rh:
 *   - `RouterBackend`   — talks to a running 9router on :20128 (default)
 *   - `DirectBackend`   — talks straight to any OpenAI-compatible endpoint
 *                         (OpenAI, Anthropic-via-OpenRouter, LiteLLM, etc.)
 *   - `EmbeddedBackend` — 9rh spawns and supervises its own 9router (TODO)
 *
 * Choosing a backend is the first step in main(); everything else (Agent,
 * REPL slash commands, doctor) reads from it. Adding a new provider family
 * means adding a new Backend impl — no other module needs to change.
 */

export type BackendName = "router" | "direct" | "embedded";

export interface ModelInfo {
  id: string;
  /** When known, the provider that owns this model (e.g. "anthropic", "openai"). */
  owned_by?: string;
  [key: string]: unknown;
}

export interface ProviderInfo {
  id?: string;
  name?: string;
  provider?: string;
  isActive?: boolean;
  [key: string]: unknown;
}

export interface ComboInfo {
  name?: string;
  kind?: string;
  models?: string[];
  [key: string]: unknown;
}

export interface KeyInfo {
  id?: string;
  name?: string;
  preview?: string;
  [key: string]: unknown;
}

export interface HealthSnapshot {
  reachable: boolean;
  url: string;
  detail?: string;
}

/**
 * The Backend contract.
 *
 * `baseURL` and `apiKey` are what the OpenAI client (in `Agent`) needs to
 * issue a `/v1/chat/completions` request. The Backend is the authoritative
 * source for these — never read them from env vars after `detectBackend()`
 * has returned.
 */
export interface Backend {
  readonly name: BackendName;
  /** OpenAI-compatible endpoint, e.g. "http://127.0.0.1:20128/v1" or "https://api.openai.com/v1". */
  readonly baseURL: string;
  /** Bearer token for the chat endpoint. */
  readonly apiKey: string;
  /**
   * True when the backend exposes 9router's native `/api/*` endpoints
   * (providers, combos, keys, router config). Direct backends return false.
   * Slash commands guard on this to show "not available in direct mode".
   */
  readonly hasNativeRouter: boolean;
  /** Human-readable origin, used in startup banners and `/doctor`. */
  describe(): string;
  /** List available models. Returns an empty array on any error — never throws. */
  listModels(): Promise<ModelInfo[]>;
  /** Cheap health probe. Returns reachable=false on any error. */
  health(): Promise<HealthSnapshot>;
  /** 9router-only. Returns [] for backends without native router support. */
  listProviders?(): Promise<ProviderInfo[]>;
  /** 9router-only. Returns [] for backends without native router support. */
  listCombos?(): Promise<ComboInfo[]>;
  /** 9router-only. Returns [] for backends without native router support. */
  listKeys?(): Promise<KeyInfo[]>;
}
