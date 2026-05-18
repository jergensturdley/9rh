import { describe, expect, it } from "@jest/globals";
import {
  formatSpecDrivenPrompt,
  parseTaskSpecification,
  shouldUseSpecDrivenTesting,
  synthesizeTestPlan,
} from "../specDrivenTesting.js";
import { validateEvent } from "../../reasoner/validation.js";
import type { ReplayEvent } from "../../replay/eventSchema.js";

describe("parseTaskSpecification", () => {
  it("preserves original wording and maps known requirement patterns into expected test types", () => {
    const original = [
      "Add login so valid users receive a token.",
      "Reject missing passwords with a helpful error.",
      "Edge case: locked accounts must not authenticate.",
      "Do not change the existing session storage format.",
    ].join("\n");

    const spec = parseTaskSpecification(original);
    const plan = synthesizeTestPlan(spec);

    expect(spec.original).toBe(original);
    expect(spec.functionalBehavior.map((r) => r.text)).toContain("Add login so valid users receive a token.");
    expect(spec.edgeCases.map((r) => r.text)).toContain("Edge case: locked accounts must not authenticate.");
    expect(spec.constraints.map((r) => r.text)).toContain("Do not change the existing session storage format.");
    expect(plan.tests.some((test) => test.type === "unit" && test.path === "happy")).toBe(true);
    expect(plan.tests.some((test) => test.type === "edge" && test.path === "failure")).toBe(true);
    expect(plan.coverage.every((entry) => entry.testIds.length > 0 || entry.status === "gap")).toBe(true);
  });

  it("treats validation errors as failure-path behavior, not automatic bug reports", () => {
    const spec = parseTaskSpecification("Reject missing passwords with a helpful error.");
    const plan = synthesizeTestPlan(spec);

    expect(spec.bugReports).toHaveLength(0);
    expect(spec.functionalBehavior.map((r) => r.text)).toContain("Reject missing passwords with a helpful error.");
    expect(plan.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "unit", path: "failure", expectedInitialState: "unknown" }),
      ]),
    );
    expect(plan.tests.some((test) => test.type === "regression")).toBe(false);
  });

  it("maps reject and prevent requirements to failure or guard-path tests", () => {
    const spec = parseTaskSpecification("Add checkout validation. Reject empty carts. Prevent duplicate submissions.");
    const plan = synthesizeTestPlan(spec);

    const negativeTests = plan.tests.filter((test) =>
      test.intent.includes("Reject empty carts") || test.intent.includes("Prevent duplicate submissions"),
    );

    expect(negativeTests).toHaveLength(2);
    expect(negativeTests.every((test) => test.path === "failure")).toBe(true);
  });

  it("marks ambiguous requirements for confirmation instead of pretending they are clear", () => {
    const spec = parseTaskSpecification("Improve task handling and make it fast if possible.");

    expect(spec.ambiguities.map((item) => item.text)).toEqual([
      "Improve task handling and make it fast if possible.",
    ]);
    expect(synthesizeTestPlan(spec).canAutoProceed).toBe(false);
  });

  it("does not auto-proceed when no concrete tests are synthesized", () => {
    const plan = synthesizeTestPlan(parseTaskSpecification(""));

    expect(plan.tests).toHaveLength(0);
    expect(plan.canAutoProceed).toBe(false);
    expect(plan.confidence).toBe("low");
  });

  it("validates that a bug report creates at least one reproducible failing regression test", () => {
    const spec = parseTaskSpecification("Fix bug: /switch crashes when the model name is empty.");
    const plan = synthesizeTestPlan(spec);

    expect(spec.bugReports).toHaveLength(1);
    expect(plan.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "regression", expectedInitialState: "failing" }),
      ]),
    );
  });
});

describe("formatSpecDrivenPrompt", () => {
  it("creates a first-class test artifact with assumptions, gaps, and tight loop instructions", () => {
    const prompt = formatSpecDrivenPrompt("Add checkout validation. Reject empty carts.");

    expect(prompt).toContain("Original user request");
    expect(prompt).toContain("Generated test plan");
    expect(prompt).toContain("Run the generated or updated tests first and capture the failing baseline");
    expect(prompt).toContain("Specification coverage");
    expect(prompt).toContain("Prune duplicate or low-value tests");
  });

  it("does not wrap purely informational tasks", () => {
    expect(shouldUseSpecDrivenTesting("Explain how replay works")).toBe(false);
    expect(shouldUseSpecDrivenTesting("Add replay divergence tests")).toBe(true);
  });

  it("allows spec_plan replay events as durable review artifacts", () => {
    const event: ReplayEvent = {
      type: "spec_plan",
      seq: 1,
      ts: Date.now(),
      step: { stepIndex: 0, iteration: 0, compactCount: 0 },
      payload: {
        originalTask: "Add checkout validation.",
        summary: formatSpecDrivenPrompt("Add checkout validation."),
      },
    };

    expect(validateEvent(event).filter((issue) => issue.severity === "error")).toHaveLength(0);
  });
});
