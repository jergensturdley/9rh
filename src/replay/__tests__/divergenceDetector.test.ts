import { describe, it, expect } from "@jest/globals";
import {
  detectToolDivergence,
  detectLLMDivergence,
  compareEventLogs,
} from "../divergenceDetector.js";
import type { ToolResultEvent, LLMResponseEvent } from "../eventSchema.js";

describe("DivergenceDetector", () => {
  const step = { stepIndex: 1, iteration: 1, compactCount: 0 };

  describe("detectToolDivergence", () => {
    it("detects output mismatch at minor severity", () => {
      const rec: ToolResultEvent = {
        type: "tool_result", seq: 5, ts: 0, step,
        payload: { toolName: "run_bash", callId: "abc", output: "ABCDEFGHIJ", error: undefined, durationMs: 100 },
      };
      const rep: ToolResultEvent = {
        type: "tool_result", seq: 5, ts: 0, step,
        payload: { toolName: "run_bash", callId: "abc", output: "ABCDEFGHIX", error: undefined, durationMs: 100 },
      };
      const divs = detectToolDivergence(rec, rep);
      expect(divs.length).toBe(1);
      expect(divs[0].field).toBe("output");
      expect(divs[0].severity).toBe("minor");
    });

    it("detects error field mismatch as critical", () => {
      const rec: ToolResultEvent = {
        type: "tool_result", seq: 5, ts: 0, step,
        payload: { toolName: "run_bash", callId: "abc", output: "", error: "exit non-zero", durationMs: 100 },
      };
      const rep: ToolResultEvent = {
        type: "tool_result", seq: 5, ts: 0, step,
        payload: { toolName: "run_bash", callId: "abc", output: "", error: undefined, durationMs: 100 },
      };
      const divs = detectToolDivergence(rec, rep);
      expect(divs.length).toBe(1);
      expect(divs[0].severity).toBe("critical");
    });

    it("returns no divergences when outputs match", () => {
      const rec: ToolResultEvent = {
        type: "tool_result", seq: 5, ts: 0, step,
        payload: { toolName: "read_file", callId: "abc", output: "file content", error: undefined, durationMs: 50 },
      };
      const rep: ToolResultEvent = {
        type: "tool_result", seq: 5, ts: 0, step,
        payload: { toolName: "read_file", callId: "abc", output: "file content", error: undefined, durationMs: 51 },
      };
      expect(detectToolDivergence(rec, rep)).toHaveLength(0);
    });
  });

  describe("detectLLMDivergence", () => {
    it("detects tool call mismatch as critical", () => {
      const rec: LLMResponseEvent = {
        type: "llm_response", seq: 3, ts: 0, step,
        payload: { text: "", toolCalls: [{ id: "tc1", name: "read_file", argsRaw: '{"path":"a.ts"}' }], finishReason: "tool_calls" },
      };
      const rep: LLMResponseEvent = {
        type: "llm_response", seq: 3, ts: 0, step,
        payload: { text: "", toolCalls: [{ id: "tc1", name: "read_file", argsRaw: '{"path":"b.ts"}' }], finishReason: "tool_calls" },
      };
      const divs = detectLLMDivergence(rec, rep);
      expect(divs.length).toBe(1);
      expect(divs[0].field).toBe("toolCalls");
      expect(divs[0].severity).toBe("critical");
    });

    it("returns no divergences when tool calls match", () => {
      const rec: LLMResponseEvent = {
        type: "llm_response", seq: 3, ts: 0, step,
        payload: { text: "", toolCalls: [{ id: "tc1", name: "read_file", argsRaw: '{"path":"a.ts"}' }], finishReason: "tool_calls" },
      };
      const rep: LLMResponseEvent = {
        type: "llm_response", seq: 3, ts: 0, step,
        payload: { text: "", toolCalls: [{ id: "tc1", name: "read_file", argsRaw: '{"path":"a.ts"}' }], finishReason: "tool_calls" },
      };
      expect(detectLLMDivergence(rec, rep)).toHaveLength(0);
    });
  });

  describe("compareEventLogs", () => {
    it("returns null when no divergence", () => {
      const rec: ToolResultEvent[] = [
        { type: "tool_result", seq: 1, ts: 0, step, payload: { toolName: "run_bash", callId: "x", output: "ok", error: undefined, durationMs: 100 } },
      ];
      const rep: ToolResultEvent[] = [
        { type: "tool_result", seq: 1, ts: 0, step, payload: { toolName: "run_bash", callId: "x", output: "ok", error: undefined, durationMs: 100 } },
      ];
      expect(compareEventLogs(rec, rep)).toBeNull();
    });

    it("reports first divergence point", () => {
      const rec: ToolResultEvent[] = [
        { type: "tool_result", seq: 1, ts: 0, step, payload: { toolName: "run_bash", callId: "x", output: "ok", error: undefined, durationMs: 100 } },
        { type: "tool_result", seq: 2, ts: 0, step, payload: { toolName: "run_bash", callId: "y", output: "was here", error: undefined, durationMs: 100 } },
      ];
      const rep: ToolResultEvent[] = [
        { type: "tool_result", seq: 1, ts: 0, step, payload: { toolName: "run_bash", callId: "x", output: "ok", error: undefined, durationMs: 100 } },
        { type: "tool_result", seq: 2, ts: 0, step, payload: { toolName: "run_bash", callId: "y", output: "changed", error: undefined, durationMs: 100 } },
      ];
      const report = compareEventLogs(rec, rep);
      expect(report).not.toBeNull();
      expect(report!.eventsBeforeDivergence).toBe(1);
    });
  });
});
