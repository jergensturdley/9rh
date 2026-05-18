import { describe, it, expect } from "@jest/globals";
import { validateEvent, repairEvent, validateAndRepair } from "../validation.js";
import type { ReplayEvent } from "../../replay/eventSchema.js";

describe("validateEvent", () => {
  it("passes a valid reasoning_plan event", () => {
    const event: ReplayEvent = {
      type: "reasoning_plan",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: {
        callId: "call_abc",
        goal: "Read the package.json",
        currentStep: "Open file",
        assumptions: ["File exists at src/package.json"],
        chosenTool: "read_file",
        expectedOutcome: "File contents displayed",
        alternativesConsidered: ["Use list_files to confirm path"],
      },
    };
    const issues = validateEvent(event);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("fails a reasoning_plan missing required fields", () => {
    const event = {
      type: "reasoning_plan",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: { goal: "Read the package.json" },
    } as ReplayEvent;
    const issues = validateEvent(event);
    expect(issues.some((i) => i.severity === "error")).toBe(true);
    expect(issues.map((i) => i.path)).toContain("payload.callId");
  });

  it("fails a reasoning_summary missing corrected boolean", () => {
    const event = {
      type: "reasoning_summary",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: {
        callId: "call_abc",
        expectedOutcome: "File contents displayed",
        observedOutcome: "File not found",
        deviations: [],
        nextAction: "Use list_files to check directory",
        corrected: undefined,
      },
    } as unknown as ReplayEvent;
    const issues = validateEvent(event);
    expect(issues.some((i) => i.path === "payload.corrected")).toBe(true);
  });

  it("passes a valid reasoning_summary event", () => {
    const event: ReplayEvent = {
      type: "reasoning_summary",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: {
        callId: "call_abc",
        expectedOutcome: "File contents displayed",
        observedOutcome: "File contents displayed",
        deviations: [],
        nextAction: "Continue to next step",
        corrected: false,
      },
    };
    const issues = validateEvent(event);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("fails an event missing type field", () => {
    const event = { seq: 1, ts: Date.now() } as ReplayEvent;
    const issues = validateEvent(event);
    expect(issues.some((i) => i.path === "type")).toBe(true);
  });

  it("warns on llm_response with invalid text type", () => {
    const event = {
      type: "llm_response",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: { text: { nested: "object" }, toolCalls: null, finishReason: "stop" },
    } as unknown as ReplayEvent;
    const issues = validateEvent(event);
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
  });
});

describe("repairEvent", () => {
  it("leaves a valid event unchanged", () => {
    const event: ReplayEvent = {
      type: "reasoning_plan",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: {
        callId: "call_abc",
        goal: "Read the package.json",
        currentStep: "Open file",
        assumptions: [],
        chosenTool: "read_file",
        expectedOutcome: "File contents displayed",
        alternativesConsidered: [],
      },
    };
    const repaired = repairEvent(event);
    expect(repaired).toEqual(event);
  });

  it("fills missing required fields for reasoning_plan", () => {
    const event = {
      type: "reasoning_plan",
      seq: 0,
      ts: 0,
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: { goal: "Fix the bug" },
    } as ReplayEvent;
    const repaired = repairEvent(event) as {
      payload: Record<string, unknown>;
    };
    expect(repaired.payload.callId).toBe("<unknown-callId>");
    expect(repaired.payload.goal).toBe("Fix the bug");
    expect(repaired.payload.chosenTool).toBe("<unknown-tool>");
    expect(repaired.payload.expectedOutcome).toBe("<unknown-outcome>");
    expect(repaired.payload.assumptions).toEqual([]);
    expect(repaired.payload.alternativesConsidered).toEqual([]);
  });

  it("fills missing required fields for reasoning_summary", () => {
    const event = {
      type: "reasoning_summary",
      seq: 0,
      ts: 0,
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: { nextAction: "Continue" },
    } as ReplayEvent;
    const repaired = repairEvent(event) as {
      payload: Record<string, unknown>;
    };
    expect(repaired.payload.callId).toBe("<unknown-callId>");
    expect(repaired.payload.corrected).toBe(false);
  });

  it("does not modify event with no type", () => {
    const event = { seq: 1, ts: Date.now() } as ReplayEvent;
    const repaired = repairEvent(event);
    expect(repaired).toEqual(event);
  });
});

describe("validateAndRepair", () => {
  it("returns event unchanged and no issues when valid", () => {
    const event: ReplayEvent = {
      type: "reasoning_summary",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: {
        callId: "call_abc",
        expectedOutcome: "ok",
        observedOutcome: "ok",
        deviations: [],
        nextAction: "done",
        corrected: false,
      },
    };
    const { event: result, issues } = validateAndRepair(event);
    expect(result).toEqual(event);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("repairs and reports issues for malformed event", () => {
    const event = {
      type: "reasoning_plan",
      seq: 0,
      ts: 0,
      step: { stepIndex: 1, iteration: 1, compactCount: 0 },
      payload: { goal: "Test" },
    } as ReplayEvent;
    const { event: repaired, issues } = validateAndRepair(event);
    expect(issues.some((i) => i.severity === "error")).toBe(true);
    expect((repaired as { payload: Record<string, unknown> }).payload.callId).toBe("<unknown-callId>");
  });
});