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
 *   - DirectBackend, RouterBackend — concrete impls
 *   - The Backend interface and supporting types
 *
 * Note: `EmbeddedBackend` (9rh-spawned 9router supervisor) was a planned
 * third mode that was deprioritized — see docs/orchestrator-wiring-spec.md
 * (Path B). The `BackendName` type still includes "embedded" for forward
 * compatibility, but no implementation is shipped today; `detectBackend`
 * currently falls back to RouterBackend when "embedded" is selected.
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
