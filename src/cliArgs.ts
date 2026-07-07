// Pure CLI argument mapping/validation, split out of index.ts so it can be
// unit-tested without executing the top-level program (index.ts runs
// program.parse() at import). Nothing here touches process.exit or module
// state — callers translate a `{ ok: false }` result into their own
// exit/stderr behavior.
import type { ContinuationPolicy } from "./agent.js";

export type IntResult =
  | { ok: true; value: number | undefined }
  | { ok: false; error: string };

/**
 * Parse an optional positive integer. Empty/undefined input is valid and
 * yields `value: undefined` (the caller supplies its own default); anything
 * that is not an integer >= 1 is an error.
 */
export function parsePositiveInt(raw: string | undefined, label: string): IntResult {
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: `${label} must be a positive integer, got: ${raw}` };
  }
  return { ok: true, value: n };
}

/** True if any of `names` appears in argv as `--name` or `--name=value`. */
export function hasOption(rawArgs: string[], names: string[]): boolean {
  return rawArgs.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

export type MaxIterResult = { ok: true; value: number } | { ok: false; error: string };

export function resolveMaxIter(rawMaxIter: string | undefined, defaultMax: number): MaxIterResult {
  const r = parsePositiveInt(rawMaxIter, "--max-iter");
  if (!r.ok) return r;
  return { ok: true, value: r.value ?? defaultMax };
}

export interface ContinuationOpts {
  continue?: boolean;
  continueModel?: string;
  continueMax?: string;
  continueIter?: string;
  continueSwitchAfter?: string;
}

export type PolicyResult =
  | { ok: true; policy: ContinuationPolicy | undefined }
  | { ok: false; error: string };

/**
 * Build the continuation policy from raw CLI options. Returns
 * `policy: undefined` when continuation is disabled (`--no-continue`) or no
 * continuation flags were supplied. Preserves the original defaults:
 * maxContinuations and switchAfter default to 1 when omitted.
 */
export function buildContinuationPolicy(opts: ContinuationOpts): PolicyResult {
  if (opts.continue === false) return { ok: true, policy: undefined };
  const hasContinuationConfig = Boolean(
    opts.continueModel || opts.continueMax || opts.continueIter || opts.continueSwitchAfter,
  );
  if (!hasContinuationConfig) return { ok: true, policy: undefined };

  const maxR = parsePositiveInt(opts.continueMax, "--continue-max");
  if (!maxR.ok) return maxR;
  const maxContinuations = maxR.value ?? 1;

  const iterR = parsePositiveInt(opts.continueIter, "--continue-iter");
  if (!iterR.ok) return iterR;
  const iterationsPerContinuation = iterR.value;

  const switchR = parsePositiveInt(opts.continueSwitchAfter, "--continue-switch-after");
  if (!switchR.ok) return switchR;
  const switchAfter = switchR.value ?? 1;

  const policy: ContinuationPolicy = { maxContinuations };
  if (iterationsPerContinuation !== undefined) policy.iterationsPerContinuation = iterationsPerContinuation;
  if (opts.continueModel) {
    policy.modelSwitch = { toModel: opts.continueModel, afterContinuations: switchAfter };
  }
  return { ok: true, policy };
}

export type InitAction = "update" | "update-router" | "install" | "ready" | "unknown";

export interface InitCommand {
  action: InitAction;
  quiet: boolean;
}

/**
 * Classify a `9rh init ...` invocation. `rawArgs` is process.argv.slice(2)
 * with rawArgs[0] === "init". Flag precedence matches the original branch
 * order: update > update-router > install > ready(no positional) > unknown.
 */
export function classifyInitCommand(rawArgs: string[]): InitCommand {
  const rest = rawArgs.slice(1);
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const flags = rest.filter((a) => a.startsWith("-"));
  const quiet = flags.includes("--quiet") || flags.includes("-q");
  if (flags.includes("--update") || flags.includes("-U")) return { action: "update", quiet };
  if (flags.includes("--update-router")) return { action: "update-router", quiet };
  if (flags.includes("--install")) return { action: "install", quiet };
  if (positionals.length === 0) return { action: "ready", quiet };
  return { action: "unknown", quiet };
}
