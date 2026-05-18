import { describe, it, expect } from "@jest/globals";
import { ErrorClass, classifyError, tagError } from "../errorTaxonomy.js";
describe("classifyError", () => {
    it("classifies FATAL for invariant violations", () => {
        const result = classifyError(new Error("Fatal: invariant violated"));
        expect(result.errorClass).toBe(ErrorClass.FATAL);
    });
    it("classifies ENVIRONMENT_ERROR for ENOENT", () => {
        const result = classifyError(new Error("ENOENT: no such file"));
        expect(result.errorClass).toBe(ErrorClass.ENVIRONMENT_ERROR);
    });
    it("classifies ENVIRONMENT_ERROR for permission denied", () => {
        const result = classifyError(new Error("EACCES: permission denied"));
        expect(result.errorClass).toBe(ErrorClass.ENVIRONMENT_ERROR);
    });
    it("classifies AGENT_ERROR for malformed JSON", () => {
        const result = classifyError(new Error("malformed json in tool args"));
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
        const result = classifyError(new Error("UND_ERR_PRE_CLOSE"));
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
//# sourceMappingURL=errorTaxonomy.test.js.map