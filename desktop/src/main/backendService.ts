/**
 * Backend resolution for the desktop app.
 *
 * Translates the renderer's `BackendChoice` into 9rh's `DetectOptions` and
 * runs the engine's own six-layer `detectBackend`. No detection logic lives
 * here; this module only maps shapes and adds a health probe for the
 * new-session form.
 */

import { PROVIDER_PRESETS, detectBackend, getProviderPreset } from "9rh";
import type { DetectOptions, DetectResult, ProviderPreset } from "9rh";
import type { BackendChoice, BackendSummary } from "@shared/ipc";

export interface BackendServiceDeps {
  /** Injected in tests; defaults to 9rh's `detectBackend`. */
  detect?: typeof detectBackend;
}

/** Pure mapping from the UI's choice to engine detect options. */
export function mapChoice(choice?: BackendChoice): DetectOptions {
  if (!choice || choice.mode === "auto") return {};
  if (choice.mode === "router") {
    return {
      cliBackend: "router",
      routerBaseURL: choice.routerUrl,
      routerApiKey: choice.routerKey,
    };
  }
  const preset = getProviderPreset(choice.preset);
  return {
    cliBackend: "direct",
    directBaseURL: choice.directUrl ?? preset?.baseURL,
    directApiKey: choice.directKey ?? (preset?.envKey ? process.env[preset.envKey] : undefined),
  };
}

export function resolveBackend(
  choice?: BackendChoice,
  deps: BackendServiceDeps = {},
): Promise<DetectResult> {
  return (deps.detect ?? detectBackend)(mapChoice(choice));
}

/** Resolve plus one health probe, shaped for the new-session form. */
export async function summarizeBackend(
  choice?: BackendChoice,
  deps?: BackendServiceDeps,
): Promise<BackendSummary> {
  const { backend, warnings, ambiguous } = await resolveBackend(choice, deps);
  const health = await backend.health();
  return {
    name: backend.name,
    description: backend.describe(),
    baseURL: backend.baseURL,
    hasNativeRouter: backend.hasNativeRouter,
    reachable: health.reachable,
    healthDetail: health.detail,
    warnings,
    ambiguous,
  };
}

export function listPresets(): ProviderPreset[] {
  return PROVIDER_PRESETS;
}
