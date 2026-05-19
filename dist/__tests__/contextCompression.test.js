import { describe, expect, it } from "@jest/globals";
import { compressContextText, compressToolResultForContext } from "../contextCompression.js";
describe("context compression", () => {
    it("compresses large tool outputs while preserving high-signal lines", () => {
        const output = [
            "running npm test",
            ...Array.from({ length: 220 }, (_, i) => `verbose noise ${i} ${"x".repeat(80)}`),
            "FAIL src/app.test.ts",
            "Expected: true",
            "Received: false",
            "Error: timeout at src/app.ts:42",
            ...Array.from({ length: 80 }, (_, i) => `tail noise ${i} ${"y".repeat(80)}`),
        ].join("\n");
        const result = compressToolResultForContext("run_bash", output, undefined, { maxChars: 1800 });
        expect(result.changed).toBe(true);
        expect(result.text).toContain("tool result:run_bash compressed for model context");
        expect(result.text).toContain("FAIL src/app.test.ts");
        expect(result.text).toContain("Expected: true");
        expect(result.text).toContain("Received: false");
        expect(result.text).toContain("Error: timeout at src/app.ts:42");
        expect(result.text).toContain("Tool context compaction");
        expect(result.text.length).toBeLessThan(output.length / 5);
    });
    it("leaves small context untouched", () => {
        const result = compressContextText("small output", "tool result:read_file");
        expect(result.changed).toBe(false);
        expect(result.text).toBe("small output");
    });
});
//# sourceMappingURL=contextCompression.test.js.map