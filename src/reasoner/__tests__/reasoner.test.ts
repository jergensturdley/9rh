import { describe, it, expect, beforeEach } from "@jest/globals";
import { Reasoner } from "../reasoner.js";
import type { ReplayEvent } from "../../replay/eventSchema.js";

describe("Reasoner", () => {
  let emitted: ReplayEvent[];
  let divergenceEvents: unknown[];

  beforeEach(() => {
    emitted = [];
    divergenceEvents = [];
  });

  function makeReasoner(emitPlans = true, emitSummaries = true) {
    return new Reasoner({
      emitPlans,
      emitSummaries,
      onReasoningEvent: (e) => emitted.push(e),
      onDivergence: (e) => divergenceEvents.push(e),
    });
  }

  describe("plan / summarize", () => {
    it("emits a reasoning_plan event before tool execution", () => {
      const r = makeReasoner(true, false);
      r.plan({
        callId: "call_123",
        toolName: "read_file",
        args: { path: "src/agent.ts" },
        goal: "Understand agent structure",
        currentStep: "Read agent.ts file",
        assumptions: ["File exists at src/agent.ts"],
        expectedOutcome: "File contents displayed",
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
        alternativesConsidered: ["Use search_files to find relevant sections"],
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("reasoning_plan");
      expect((emitted[0] as { payload: { callId: string } }).payload.callId).toBe("call_123");
      expect((emitted[0] as { payload: { chosenTool: string } }).payload.chosenTool).toBe("read_file");
    });

    it("emits a reasoning_summary after tool result", () => {
      const r = makeReasoner(false, true);
      r.summarize({
        callId: "call_123",
        observedOutcome: "File contents: export class Agent {...}",
        nextAction: "Analyze the agent loop",
        corrected: false,
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe("reasoning_summary");
      const p = (emitted[0] as { payload: { callId: string; corrected: boolean } }).payload;
      expect(p.callId).toBe("call_123");
      expect(p.corrected).toBe(false);
    });

    it("skips plan emission when emitPlans is false", () => {
      const r = makeReasoner(false, true);
      r.plan({
        callId: "call_123",
        toolName: "read_file",
        args: {},
        goal: "Test",
        currentStep: "Test",
        assumptions: [],
        expectedOutcome: "Test",
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(emitted).toHaveLength(0);
    });

    it("skips summary emission when emitSummaries is false", () => {
      const r = makeReasoner(true, false);
      r.summarize({
        callId: "call_123",
        observedOutcome: "ok",
        nextAction: "done",
        corrected: false,
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(emitted).toHaveLength(0);
    });

    it("detects deviation when observed does not match expected outcome", () => {
      const r = makeReasoner(false, true);
      r.summarize({
        callId: "call_123",
        observedOutcome: "File not found at path",
        nextAction: "Check directory listing",
        corrected: false,
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      const summary = emitted[0] as { payload: { deviations: string[] } };
      expect(summary.payload.deviations.length).toBeGreaterThan(0);
    });

    it("triggers onDivergence when deviation detected", () => {
      const r = makeReasoner(false, true);
      r.summarize({
        callId: "call_123",
        observedOutcome: "File not found at path",
        nextAction: "Check directory",
        corrected: false,
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(divergenceEvents).toHaveLength(1);
    });

    it("triggers onDivergence when corrected is true", () => {
      const r = makeReasoner(false, true);
      r.summarize({
        callId: "call_123",
        observedOutcome: "Tool executed",
        nextAction: "Retry with different args",
        corrected: true,
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(divergenceEvents).toHaveLength(1);
    });

    it("does not trigger onDivergence when observed matches expected and corrected is false", () => {
      const r = makeReasoner(true, true);
      r.plan({
        callId: "call_123",
        toolName: "read_file",
        args: {},
        goal: "Read file",
        currentStep: "Read",
        assumptions: [],
        expectedOutcome: "File contents displayed",
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      r.summarize({
        callId: "call_123",
        observedOutcome: "File contents displayed",
        nextAction: "Continue",
        corrected: false,
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(divergenceEvents).toHaveLength(0);
    });
  });

  describe("hasActivePlan / reset", () => {
    it("reports active plan for callId after plan()", () => {
      const r = makeReasoner();
      r.plan({
        callId: "call_abc",
        toolName: "read_file",
        args: {},
        goal: "Test",
        currentStep: "Test",
        assumptions: [],
        expectedOutcome: "Test",
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(r.hasActivePlan("call_abc")).toBe(true);
      expect(r.hasActivePlan("call_other")).toBe(false);
    });

    it("clears active context after summarize()", () => {
      const r = makeReasoner();
      r.plan({
        callId: "call_abc",
        toolName: "read_file",
        args: {},
        goal: "Test",
        currentStep: "Test",
        assumptions: [],
        expectedOutcome: "Test",
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      r.summarize({
        callId: "call_abc",
        observedOutcome: "ok",
        nextAction: "next",
        corrected: false,
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      expect(r.hasActivePlan("call_abc")).toBe(false);
    });

    it("reset clears all active contexts", () => {
      const r = makeReasoner();
      r.plan({
        callId: "call_1",
        toolName: "read_file",
        args: {},
        goal: "Test",
        currentStep: "Test",
        assumptions: [],
        expectedOutcome: "Test",
        stepContext: { stepIndex: 1, iteration: 1, compactCount: 0 },
      });
      r.plan({
        callId: "call_2",
        toolName: "write_file",
        args: {},
        goal: "Test",
        currentStep: "Test",
        assumptions: [],
        expectedOutcome: "Test",
        stepContext: { stepIndex: 2, iteration: 2, compactCount: 0 },
      });
      r.reset();
      expect(r.hasActivePlan("call_1")).toBe(false);
      expect(r.hasActivePlan("call_2")).toBe(false);
    });
  });
});