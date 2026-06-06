export enum ErrorClass {
  RECOVERABLE = "RECOVERABLE",
  AGENT_ERROR = "AGENT_ERROR",
  ENVIRONMENT_ERROR = "ENVIRONMENT_ERROR",
  FATAL = "FATAL",
}

export interface ErrorClassMetadata {
  description: string;
  retryable: boolean;
  maxRetries: number;
  triggersRepair: boolean;
}

export const ERROR_TAXONOMY: Record<ErrorClass, ErrorClassMetadata> = {
  [ErrorClass.RECOVERABLE]: {
    description:
      "Transient network or resource issues — API timeouts, rate limits, socket resets, premature closes.",
    retryable: true,
    maxRetries: 3,
    triggersRepair: true,
  },
  [ErrorClass.AGENT_ERROR]: {
    description:
      "Internal agent logic failures — malformed JSON from LLM, unknown tool name, type errors in tool args.",
    retryable: false,
    maxRetries: 1,
    triggersRepair: true,
  },
  [ErrorClass.ENVIRONMENT_ERROR]: {
    description:
      "External environment failures — disk full, missing env var, sandbox process crash, permission denied.",
    retryable: false,
    maxRetries: 1,
    triggersRepair: true,
  },
  [ErrorClass.FATAL]: {
    description:
      "Unrecoverable fatal errors — invariants violated, internal assertion failures, unknown error states.",
    retryable: false,
    maxRetries: 0,
    triggersRepair: false,
  },
};

export type SourceLayer = "sandbox" | "llm" | "tool" | "orchestrator";

export interface TaggedError {
  cause: unknown;
  message: string;
  sourceLayer: SourceLayer;
  errorClass: ErrorClass;
  timestamp: number;
}

/**
 * F-31: Classify errors by ORIGIN first, then by exception type, then
 * by a small allowlist of well-known substrings. The previous version
 * classified entirely by message text, which made a malicious
 * file/URL/error message able to trigger arbitrary classification
 * (e.g. an LLM-fabricated "fatal invariant violation" reaching FATAL,
 * or "rate limit" triggering RECOVERABLE and burning retry budget).
 *
 * New rules:
 *   1. The SourceLayer gives a baseline — sandbox errors are
 *      ENVIRONMENT, LLM errors are RECOVERABLE/AGENT depending on
 *      type, tool errors are AGENT.
 *   2. The exception's `name` and `code` (for NodeJS.ErrnoException)
 *      are checked against a small allowlist.
 *   3. The error MESSAGE is checked ONLY against a small set of
 *      substrings known to appear in the originating library (e.g.
 *      "rate limit" from OpenAI, "ECONNRESET" from Node). Generic
 *      message-text scans are no longer used for class decisions.
 */

const ALLOWLIST_RECOVERABLE = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
  "UND_ERR_PRE_CLOSE", "UND_ERR_SOCKET",
]);
const ALLOWLIST_ENVIRONMENT = new Set([
  "ENOENT", "EACCES", "ENOSPC", "EISDIR", "ENOTDIR", "EROFS",
]);
// Substring allowlist. Each entry is a stable library-level marker, not
// a generic English phrase.
const SUBSTR_ALLOWLIST = [
  { substr: "rate limit", cls: ErrorClass.RECOVERABLE },
  { substr: "circuit breaker", cls: ErrorClass.RECOVERABLE },
  { substr: "stream incomplete", cls: ErrorClass.RECOVERABLE },
  { substr: "premature close", cls: ErrorClass.RECOVERABLE },
  { substr: "rate_limit_exceeded", cls: ErrorClass.RECOVERABLE },
  { substr: "429", cls: ErrorClass.RECOVERABLE },
  { substr: "503", cls: ErrorClass.RECOVERABLE },
  { substr: "502", cls: ErrorClass.RECOVERABLE },
  { substr: "504", cls: ErrorClass.RECOVERABLE },
  { substr: "missing environment variable", cls: ErrorClass.ENVIRONMENT_ERROR },
  { substr: "sandbox process", cls: ErrorClass.ENVIRONMENT_ERROR },
  { substr: "sandbox-exec error", cls: ErrorClass.ENVIRONMENT_ERROR },
  { substr: "writeFile after end", cls: ErrorClass.ENVIRONMENT_ERROR },
  { substr: "ECONN", cls: ErrorClass.RECOVERABLE },
  { substr: "TIMEOUT", cls: ErrorClass.RECOVERABLE },
];

export function classifyError(
  err: unknown,
  sourceLayer: SourceLayer = "tool",
): { errorClass: ErrorClass; reason: string } {
  // 1. Exception type wins. The error object itself is what was
  //    actually thrown; its name/code is the most reliable signal.
  const e = err as { name?: string; code?: string | number; message?: string };
  const code = typeof e?.code === "string" || typeof e?.code === "number" ? String(e.code) : "";
  const name = e?.name ?? "";

  if (ALLOWLIST_RECOVERABLE.has(code)) {
    return { errorClass: ErrorClass.RECOVERABLE, reason: `recoverable (${code})` };
  }
  if (ALLOWLIST_ENVIRONMENT.has(code)) {
    return { errorClass: ErrorClass.ENVIRONMENT_ERROR, reason: `env error (${code})` };
  }
  if (name === "AbortError") {
    return { errorClass: ErrorClass.RECOVERABLE, reason: "aborted" };
  }
  if (name === "SyntaxError" || name === "TypeError" || name === "ReferenceError") {
    return { errorClass: ErrorClass.AGENT_ERROR, reason: `${name} (likely schema/logic bug)` };
  }
  if (name === "RangeError" || name === "AssertionError") {
    return { errorClass: ErrorClass.FATAL, reason: `${name} (assertion)` };
  }

  // 2. Source layer baseline.
  let baseline: ErrorClass;
  switch (sourceLayer) {
    case "sandbox":
      baseline = ErrorClass.ENVIRONMENT_ERROR;
      break;
    case "llm":
      baseline = ErrorClass.RECOVERABLE;
      break;
    case "tool":
      baseline = ErrorClass.AGENT_ERROR;
      break;
    case "orchestrator":
      baseline = ErrorClass.AGENT_ERROR;
      break;
  }

  // 3. Substring allowlist (only library-level markers).
  const msg = (typeof err === "string" ? err : e?.message ?? "").toLowerCase();
  for (const { substr, cls } of SUBSTR_ALLOWLIST) {
    if (msg.includes(substr.toLowerCase())) {
      return { errorClass: cls, reason: `library marker: ${substr}` };
    }
  }

  // 4. Default to the source-layer baseline. We no longer promote
  //    unknown text to FATAL — FATAL is reserved for explicit
  //    AssertionError / RangeError or `tagError(..., fatal: true)`.
  return { errorClass: baseline, reason: `${sourceLayer} baseline` };
}

export function tagError(cause: unknown, sourceLayer: SourceLayer): TaggedError {
  const { errorClass } = classifyError(cause, sourceLayer);
  return {
    cause,
    message: cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Unknown error",
    sourceLayer,
    errorClass,
    timestamp: Date.now(),
  };
}
