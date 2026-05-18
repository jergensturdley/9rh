import { describe, it, expect } from "@jest/globals";
import { withErrorInterception } from "../errorInterceptor.js";
import { ErrorClass } from "../errorTaxonomy.js";
describe("withErrorInterception", () => {
    it("returns result when fn succeeds", async () => {
        const result = await withErrorInterception(async () => 42, {
            sourceLayer: "tool",
        });
        expect(result).toBe(42);
    });
    it("propagates FATAL errors without repair", async () => {
        await expect(withErrorInterception(async () => { throw new Error("Fatal: invariant violated"); }, {
            sourceLayer: "orchestrator",
            repairAgent: async () => ({ success: true, userMessage: "should not run", escalate: false }),
        })).rejects.toThrow("Fatal: invariant violated");
    });
    it("calls repairAgent on ENVIRONMENT_ERROR", async () => {
        let repairCalled = false;
        try {
            await withErrorInterception(async () => { throw new Error("sandbox process exited unexpectedly"); }, {
                sourceLayer: "tool",
                repairAgent: async (tagged, attempt) => {
                    repairCalled = true;
                    expect(tagged.errorClass).toBe(ErrorClass.ENVIRONMENT_ERROR);
                    return { success: false, userMessage: "repaired", escalate: false };
                },
            });
        }
        catch { }
        expect(repairCalled).toBe(true);
    });
    it("re-runs fn after successful repair", async () => {
        let attempts = 0;
        const fn = async () => {
            attempts++;
            if (attempts === 1)
                throw new Error("retryable timeout");
            return "success";
        };
        const result = await withErrorInterception(fn, {
            sourceLayer: "llm",
            repairAgent: async () => ({ success: true, userMessage: "fixed", escalate: false }),
        });
        expect(result).toBe("success");
        expect(attempts).toBe(2);
    });
    it("escalates after max retries exceeded", async () => {
        await expect(withErrorInterception(async () => { throw new Error("unknown error"); }, {
            sourceLayer: "tool",
            repairAgent: async () => ({ success: false, userMessage: "failed", escalate: false }),
        })).rejects.toThrow("unknown error");
    });
});
//# sourceMappingURL=errorInterceptor.test.js.map