import { describe, it, expect } from "@jest/globals";
import { shouldUseOrchestrator } from "../orchestrator/dispatch.js";

describe("shouldUseOrchestrator — complexity gate", () => {
  describe("explicit override (--orchestrate flag)", () => {
    it("dispatches when force is true regardless of task content", () => {
      expect(shouldUseOrchestrator("fix the typo", { force: true })).toBe(true);
      expect(shouldUseOrchestrator("", { force: true })).toBe(true);
      expect(shouldUseOrchestrator("read src/foo.ts", { force: true })).toBe(true);
    });

    it("does not dispatch when force is false", () => {
      expect(shouldUseOrchestrator("read src/foo.ts", { force: false })).toBe(false);
    });

    it("does not dispatch when force is undefined", () => {
      expect(shouldUseOrchestrator("read src/foo.ts")).toBe(false);
    });
  });

  describe("heuristic triggers on design-pattern keywords", () => {
    it("matches 'plan'", () => {
      expect(shouldUseOrchestrator("plan the rollout for v2")).toBe(true);
      expect(shouldUseOrchestrator("rollout-plan the migration")).toBe(true);
    });

    it("matches 'design'", () => {
      expect(shouldUseOrchestrator("design the API surface")).toBe(true);
      expect(shouldUseOrchestrator("design review for v2")).toBe(true);
    });

    it("matches 'audit'", () => {
      expect(shouldUseOrchestrator("audit the security posture")).toBe(true);
      expect(shouldUseOrchestrator("audit-log every change")).toBe(true);
    });

    it("matches 'architect'", () => {
      expect(shouldUseOrchestrator("architect a multi-tenant system")).toBe(true);
    });

    it("matches 'implement'", () => {
      expect(shouldUseOrchestrator("implement the new feature")).toBe(true);
      expect(shouldUseOrchestrator("implement v2 migration")).toBe(true);
    });
  });

  describe("heuristic does NOT trigger on common short tasks", () => {
    it.each([
      "fix the typo in main.ts",
      "read src/foo.ts",
      "list the files in src/",
      "show me the test output",
      "build the project",
      "run the test suite",
      "delete the .cache directory",
      "search for run_bash usage",
    ])("does not trigger on %s", (task) => {
      expect(shouldUseOrchestrator(task)).toBe(false);
    });
  });

  describe("case insensitivity", () => {
    it("triggers regardless of case", () => {
      expect(shouldUseOrchestrator("PLAN the rollout")).toBe(true);
      expect(shouldUseOrchestrator("Plan The Rollout")).toBe(true);
      expect(shouldUseOrchestrator("Architect the system")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns false on empty task", () => {
      expect(shouldUseOrchestrator("")).toBe(false);
      expect(shouldUseOrchestrator("   ")).toBe(false);
    });

    it("does NOT match stems or longer words (strict \\b boundary)", () => {
      // \b boundaries require exact word match, so prefixes/suffixes
      // don't trigger the heuristic. Tune the regex to broaden later
      // if false negatives become a real problem.
      expect(shouldUseOrchestrator("the plans desk")).toBe(false);
      expect(shouldUseOrchestrator("redesign the auth flow")).toBe(false);
      expect(shouldUseOrchestrator("implementation tasks")).toBe(false);
      expect(shouldUseOrchestrator("auditing the codebase")).toBe(false);
      expect(shouldUseOrchestrator("auditor picked up")).toBe(false);
      expect(shouldUseOrchestrator("architectural decision")).toBe(false);
    });
  });
});
