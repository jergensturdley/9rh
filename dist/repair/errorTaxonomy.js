export var ErrorClass;
(function (ErrorClass) {
    ErrorClass["RECOVERABLE"] = "RECOVERABLE";
    ErrorClass["AGENT_ERROR"] = "AGENT_ERROR";
    ErrorClass["ENVIRONMENT_ERROR"] = "ENVIRONMENT_ERROR";
    ErrorClass["FATAL"] = "FATAL";
})(ErrorClass || (ErrorClass = {}));
export const ERROR_TAXONOMY = {
    [ErrorClass.RECOVERABLE]: {
        description: "Transient network or resource issues — API timeouts, rate limits, socket resets, premature closes.",
        retryable: true,
        maxRetries: 3,
        triggersRepair: true,
    },
    [ErrorClass.AGENT_ERROR]: {
        description: "Internal agent logic failures — malformed JSON from LLM, unknown tool name, type errors in tool args.",
        retryable: false,
        maxRetries: 1,
        triggersRepair: true,
    },
    [ErrorClass.ENVIRONMENT_ERROR]: {
        description: "External environment failures — disk full, missing env var, sandbox process crash, permission denied.",
        retryable: false,
        maxRetries: 1,
        triggersRepair: true,
    },
    [ErrorClass.FATAL]: {
        description: "Unrecoverable fatal errors — invariants violated, internal assertion failures, unknown error states.",
        retryable: false,
        maxRetries: 0,
        triggersRepair: false,
    },
};
export function classifyError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes("fatal") || lower.includes("invariant violation")) {
        return { errorClass: ErrorClass.FATAL, reason: "Fatal invariant violation" };
    }
    if (lower.includes("enoent") ||
        lower.includes("eacces") ||
        lower.includes("permission denied") ||
        lower.includes("disk full") ||
        lower.includes("enospc") ||
        lower.includes("missing environment variable") ||
        lower.includes("env var") ||
        lower.includes("sandbox process") ||
        lower.includes("exited with code") ||
        lower.includes("killed")) {
        return { errorClass: ErrorClass.ENVIRONMENT_ERROR, reason: "Environment failure" };
    }
    if (lower.includes("invalid tool arguments") ||
        lower.includes("unknown tool") ||
        lower.includes("malformed json") ||
        lower.includes("unexpected token") ||
        lower.includes("parse error") ||
        lower.includes("invalid json") ||
        lower.includes("schema mismatch")) {
        return { errorClass: ErrorClass.AGENT_ERROR, reason: "Agent logic error" };
    }
    if (lower.includes("timeout") ||
        lower.includes("rate limit") ||
        lower.includes("socket") ||
        lower.includes("econnreset") ||
        lower.includes("econnrefused") ||
        lower.includes("network") ||
        lower.includes("premature close") ||
        lower.includes("other side closed") ||
        lower.includes("und_err_pre_close") ||
        lower.includes("500") ||
        lower.includes("502") ||
        lower.includes("503") ||
        lower.includes("circuit breaker") ||
        lower.includes("stream incomplete")) {
        return { errorClass: ErrorClass.RECOVERABLE, reason: "Transient recoverable error" };
    }
    return { errorClass: ErrorClass.AGENT_ERROR, reason: "Unknown error — default to AGENT_ERROR" };
}
export function tagError(cause, sourceLayer) {
    const { errorClass } = classifyError(cause);
    return {
        cause,
        message: cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Unknown error",
        sourceLayer,
        errorClass,
        timestamp: Date.now(),
    };
}
//# sourceMappingURL=errorTaxonomy.js.map