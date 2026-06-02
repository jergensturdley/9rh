/**
 * Backend abstraction over the LLM provider.
 *
 * Picking a Backend is the first thing 9rh does on startup. The chosen
 * Backend's `baseURL` + `apiKey` flow into the Agent; its `listModels` powers
 * the `/models` and `/switch` slash commands; its `listProviders`/`listCombos`/
 * `listKeys` power the 9router-native slash commands (only when the backend
 * has `hasNativeRouter === true`).
 *
 * Public API:
 *   - detectBackend(opts) — auto-detect, with overrides from CLI/env/persisted
 *   - DirectBackend, RouterBackend — concrete impls (EmbeddedBackend: TODO)
 *   - The Backend interface and supporting types
 */

export type {
  Backend,
  BackendName,
  ModelInfo,
  ProviderInfo,
  ComboInfo,
  KeyInfo,
  HealthSnapshot,
} from "./backend.js";
export { DirectBackend } from "./direct.js";
export { RouterBackend, NINE_ROUTER_OPENAI } from "./router.js";
export { detectBackend, type DetectOptions, type DetectResult } from "./detect.js";
export {
  PROVIDER_PRESETS,
  getProviderPreset,
  listProviderPresetIds,
  type ProviderPreset,
} from "./presets.js";
