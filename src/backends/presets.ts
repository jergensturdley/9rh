/**
 * Built-in direct-mode provider presets.
 *
 * The `--provider` flag is a shortcut for the common case where the user
 * wants to talk to a known OpenAI-compatible service but doesn't want to
 * type the full baseURL every time. When `--provider=openrouter` is set
 * (and the user hasn't already passed `--direct-url` or `--direct-key`),
 * the preset fills in:
 *   - baseURL: the canonical API endpoint
 *   - apiKey:  read from the matching env var
 *
 * Add a preset by appending a row. Keep them sorted alphabetically for
 * stable --help output.
 */

export interface ProviderPreset {
  /** Stable id used in --provider= and --show-config. */
  id: string;
  /** Human label for --help and error messages. */
  label: string;
  /** Default OpenAI-compat base URL for this provider. */
  baseURL: string;
  /** Env var to read the API key from when --direct-key isn't set. Empty = no auth. */
  envKey: string;
  /** Hint shown in --help so users know which model name format to use. */
  modelHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseURL: "http://127.0.0.1:1234/v1",
    envKey: "",
    modelHint: "any served model name; LM Studio prints the id in its server panel",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseURL: "http://127.0.0.1:11434/v1",
    envKey: "",
    modelHint: "model name as in `ollama list`, e.g. `llama3.1:70b`",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    modelHint: "e.g. `gpt-4o`, `gpt-4o-mini`, `o3-mini`",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    modelHint: "namespaced as `provider/model`, e.g. `anthropic/claude-3.5-sonnet`, `openai/gpt-4o-mini`, `meta-llama/llama-3.1-70b-instruct:free`",
  },
];

const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p] as const));

/**
 * Resolve a provider preset by id. Returns undefined for unknown ids
 * (caller decides whether to warn or error).
 */
export function getProviderPreset(id: string | undefined): ProviderPreset | undefined {
  if (!id) return undefined;
  return PRESET_BY_ID.get(id.trim().toLowerCase());
}

/**
 * List provider ids for --help and --show-config. Sorted alphabetically
 * (PROVIDER_PRESETS is already sorted) so output is stable.
 */
export function listProviderPresetIds(): string[] {
  return PROVIDER_PRESETS.map((p) => p.id);
}
