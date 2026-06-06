import { describe, it, expect } from "@jest/globals";
import { ErrorClass, classifyError, tagError } from "../errorTaxonomy.js";

describe("classifyError", () => {
  it("classifies FATAL for invariant violations", () => {
    const result = classifyError(new RangeError("Fatal: invariant violated"));
    expect(result.errorClass).toBe(ErrorClass.FATAL);
  });

  it("classifies ENVIRONMENT_ERROR for ENOENT", () => {
    const result = classifyError(
      Object.assign(new Error("no such file"), { code: "ENOENT" }),
      "sandbox",
    );
    expect(result.errorClass).toBe(ErrorClass.ENVIRONMENT_ERROR);
  });

  it("classifies ENVIRONMENT_ERROR for permission denied", () => {
    const result = classifyError(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
      "sandbox",
    );
    expect(result.errorClass).toBe(ErrorClass.ENVIRONMENT_ERROR);
  });

  it("classifies AGENT_ERROR for malformed JSON", () => {
    const result = classifyError(new SyntaxError("malformed json in tool args"));
    expect(result.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });

  it("classifies AGENT_ERROR for unknown tool", () => {
    const result = classifyError(new Error("Unknown tool: do_something"));
    expect(result.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });

  it("classifies RECOVERABLE for timeout", () => {
    const result = classifyError(new Error("Request timeout after 30s"));
    expect(result.errorClass).toBe(ErrorClass.RECOVERABLE);
  });

  it("classifies RECOVERABLE for rate limit", () => {
    const result = classifyError(new Error("rate limit exceeded — retry after 1s"));
    expect(result.errorClass).toBe(ErrorClass.RECOVERABLE);
  });

  it("classifies RECOVERABLE for premature close", () => {
    const result = classifyError(new Error("premature close: other side closed"));
    expect(result.errorClass).toBe(ErrorClass.RECOVERABLE);
  });

  it("classifies RECOVERABLE for UND_ERR_PRE_CLOSE", () => {
    const result = classifyError(
      Object.assign(new Error("premature close"), { code: "UND_ERR_PRE_CLOSE" }),
    );
    expect(result.errorClass).toBe(ErrorClass.RECOVERABLE);
  });

  it("defaults unknown errors to AGENT_ERROR", () => {
    const result = classifyError(new Error("Something completely unexpected"));
    expect(result.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });

  it("handles non-Error strings", () => {
    const result = classifyError("just a plain string error");
    expect(result.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });
});

describe("classifyError — F-31 origin-first behavior", () => {
  it("origin: sandbox layer defaults to ENVIRONMENT_ERROR", () => {
    const r = classifyError(new Error("anything"), "sandbox");
    expect(r.errorClass).toBe(ErrorClass.ENVIRONMENT_ERROR);
  });

  it("origin: llm layer defaults to RECOVERABLE", () => {
    const r = classifyError(new Error("anything"), "llm");
    expect(r.errorClass).toBe(ErrorClass.RECOVERABLE);
  });

  it("origin: tool layer defaults to AGENT_ERROR", () => {
    const r = classifyError(new Error("anything"), "tool");
    expect(r.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });

  it("origin: orchestrator layer defaults to AGENT_ERROR", () => {
    const r = classifyError(new Error("anything"), "orchestrator");
    expect(r.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });

  it("rejects message-text attack: file content with 'fatal invariant violation'", () => {
    const r = classifyError(new Error("fatal invariant violation"), "tool");
    expect(r.errorClass).not.toBe(ErrorClass.FATAL);
    expect(r.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });

  it("rejects retry-bomb attack: file content with 'rate limit'", () => {
    // The substr allowlist still catches the literal phrase "rate limit"
    // (case-insensitive) because it's a known library-level marker. A
    // hyphenated "rate-limited" form does not match the allowlist and
    // falls through to the source-layer baseline (AGENT_ERROR for tool).
    const r = classifyError(new Error("rate-limited attack triggered"), "tool");
    expect(r.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });
});

describe("tagError", () => {
  it("tags error with source layer and correct class", () => {
    const tagged = tagError(new Error("timeout after 30s"), "llm");
    expect(tagged.sourceLayer).toBe("llm");
    expect(tagged.errorClass).toBe(ErrorClass.RECOVERABLE);
    expect(tagged.message).toBe("timeout after 30s");
    expect(tagged.timestamp).toBeGreaterThan(0);
  });

  it("extracts message from plain string", () => {
    const tagged = tagError("simple string error", "tool");
    expect(tagged.message).toBe("simple string error");
    expect(tagged.errorClass).toBe(ErrorClass.AGENT_ERROR);
  });
});
