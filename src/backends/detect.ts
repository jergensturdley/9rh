import { readUserConfig } from "../config.js";
import { ensureRouter, type InitResult } from "../init.js";
import { DirectBackend } from "./direct.js";
import { RouterBackend, NINE_ROUTER_OPENAI } from "./router.js";
import type { Backend, BackendName } from "./backend.js";

export interface DetectOptions {
  /** Override from the CLI flag `--backend=`. Wins over everything else. */
  cliBackend?: string;
  /** Override from the env var `NINE_ROUTER_BACKEND`. */
  envBackend?: string;
  /** Override the router baseURL (CLI `-u` or env). */
  routerBaseURL?: string;
  /** Override the router API key (CLI `-k` or env). */
  routerApiKey?: string;
  /** Override the direct baseURL (CLI `--direct-url` or env). */
  directBaseURL?: string;
  /** Override the direct API key (CLI `--direct-key` or env). */
  directApiKey?: string;
  /** Skip probing for a running 9router. Used by tests. */
  skipReachabilityProbe?: boolean;
}

/**
 * Result of auto-detection. `backend` is the chosen Backend; `warnings`
 * holds non-fatal diagnostics the user should know about (e.g. ambiguous
 * config, fallback to a default).
 */
export interface DetectResult {
  backend: Backend;
  warnings: string[];
  /** True when the user was ambiguous and the resolver had to make a call. */
  ambiguous: boolean;
}

/**
 * Pick the right Backend for this run.
 *
 * Resolution order (first non-empty wins):
 *   1. `cliBackend` (--backend flag) — explicit, no detection
 *   2. `envBackend` (NINE_ROUTER_BACKEND)
 *   3. Persisted config (`~/.9rh/config.json` → `backend`)
 *   4. Env-var heuristics:
 *        - NINE_ROUTER_URL or 9router reachable on :20128 → router
 *        - OPENAI_API_KEY / ANTHROPIC_API_KEY (no router URL) → direct
 *   5. Reachable probe on :20128
 *   6. Last resort: try `ensureRouter` (auto-start 9router). If even that
 *      fails, return a DirectBackend with the user-supplied key so the user
 *      at least gets a working chat even if the router is unreachable.
 */
export async function detectBackend(opts: DetectOptions = {}): Promise<DetectResult> {
  const warnings: string[] = [];
  const explicit = pickExplicitName(opts);
  const userConfig = await readUserConfig();
  const persisted = pickBackendName(userConfig.backend);
  const env = opts.envBackend ?? process.env.NINE_ROUTER_BACKEND;
  const envName = pickBackendName(env);

  // Layer 1: explicit override always wins.
  if (explicit) {
    return build(explicit, opts, warnings, /* ambiguous */ false);
  }
  // Layer 2: env var.
  if (envName) {
    return build(envName, opts, warnings, /* ambiguous */ false);
  }
  // Layer 3: persisted config.
  if (persisted) {
    return build(persisted, opts, warnings, /* ambiguous */ false);
  }

  // Layer 4+5: heuristics. If BOTH a router URL and a direct key are present,
  // we have to guess — prefer router (the historic default) and warn.
  const routerUrl = opts.routerBaseURL ?? process.env.NINE_ROUTER_URL ?? NINE_ROUTER_OPENAI;
  const directKey =
    opts.directApiKey ??
    process.env.OPENAI_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.OPENROUTER_API_KEY;
  const directUrl =
    opts.directBaseURL ??
    process.env.OPENAI_BASE_URL ??
    process.env.ANTHROPIC_BASE_URL ??
    process.env.OPENROUTER_BASE_URL;

  const hasRouterHint = Boolean(process.env.NINE_ROUTER_URL) || routerUrl !== NINE_ROUTER_OPENAI;
  const hasDirectKey = Boolean(directKey);

  if (hasDirectKey && !hasRouterHint) {
    const url = directUrl ?? "https://api.openai.com/v1";
    return {
      backend: new DirectBackend(url, directKey!, "env"),
      warnings,
      ambiguous: false,
    };
  }

  // Default: router. Try a reachability probe first; if it fails, fall back
  // to ensureRouter() (which may auto-start 9router) — preserves the legacy
  // "just works" behavior for users who have 9router installed locally.
  if (!opts.skipReachabilityProbe) {
    const init = await ensureRouter(opts.routerBaseURL, opts.routerApiKey);
    return fromInit(init, warnings, /* ambiguous */ hasDirectKey);
  }

  // Tests: skip reachability, build from CLI/env hints.
  if (hasDirectKey) {
    const url = directUrl ?? "https://api.openai.com/v1";
    warnings.push("router probe skipped, falling back to direct mode");
    return {
      backend: new DirectBackend(url, directKey!, "env"),
      warnings,
      ambiguous: true,
    };
  }

  // No router, no direct key → router mode with default URL (will likely fail
  // at chat time, but the user gets the standard "9router not running" error).
  warnings.push("no API key found; defaulting to router mode");
  return {
    backend: new RouterBackend(routerUrl, opts.routerApiKey ?? "9router", null, false),
    warnings,
    ambiguous: true,
  };
}

function fromInit(init: InitResult, warnings: string[], ambiguous: boolean): DetectResult {
  if (init.error) warnings.push(init.error);
  return {
    backend: new RouterBackend(init.baseURL, init.apiKey, null, init.wasStarted),
    warnings,
    ambiguous,
  };
}

async function build(
  name: BackendName,
  opts: DetectOptions,
  warnings: string[],
  ambiguous: boolean,
): Promise<DetectResult> {
  if (name === "embedded") {
    warnings.push("embedded backend is not yet implemented; falling back to router");
    return build("router", opts, warnings, ambiguous);
  }
  if (name === "direct") {
    const key =
      opts.directApiKey ??
      process.env.OPENAI_API_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.OPENROUTER_API_KEY;
    const url =
      opts.directBaseURL ??
      process.env.OPENAI_BASE_URL ??
      process.env.ANTHROPIC_BASE_URL ??
      process.env.OPENROUTER_BASE_URL ??
      "https://api.openai.com/v1";
    if (!key) {
      warnings.push(
        "direct backend selected but no API key found (set OPENAI_API_KEY or --direct-key)",
      );
      // Return a backend that will fail at chat time — better than crashing the CLI.
    }
    return {
      backend: new DirectBackend(url, key ?? "", "cli"),
      warnings,
      ambiguous,
    };
  }
  // router
  const init = await ensureRouter(opts.routerBaseURL, opts.routerApiKey);
  return fromInit(init, warnings, ambiguous);
}

function pickExplicitName(opts: DetectOptions): BackendName | undefined {
  if (opts.cliBackend) return pickBackendName(opts.cliBackend);
  return undefined;
}

function pickBackendName(raw: unknown): BackendName | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "router" || v === "9router") return "router";
  if (v === "direct" || v === "openai" || v === "raw") return "direct";
  if (v === "embedded" || v === "managed") return "embedded";
  return undefined;
}
