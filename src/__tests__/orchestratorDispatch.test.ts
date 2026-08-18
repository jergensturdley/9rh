import { describe, it, expect } from "@jest/globals";
import { shouldSuggestTeam } from "../orchestrator/dispatch.js";

// shouldSuggestTeam is a SUGGESTION trigger, not a router: a true result
// means the harness offers "run as a team?"; only the user (or the explicit
// --orchestrate flag / /team command) actually routes into the pipeline.
describe("shouldSuggestTeam — team suggestion heuristic", () => {
  describe("triggers on design-pattern keywords", () => {
    it("matches 'plan'", () => {
      expect(shouldSuggestTeam("plan the rollout for v2")).toBe(true);
      expect(shouldSuggestTeam("rollout-plan the migration")).toBe(true);
    });

    it("matches 'design'", () => {
      expect(shouldSuggestTeam("design the API surface")).toBe(true);
      expect(shouldSuggestTeam("design review for v2")).toBe(true);
    });

    it("matches 'audit'", () => {
      expect(shouldSuggestTeam("audit the security posture")).toBe(true);
      expect(shouldSuggestTeam("audit-log every change")).toBe(true);
    });

    it("matches 'architect'", () => {
      expect(shouldSuggestTeam("architect a multi-tenant system")).toBe(true);
    });

    it("matches 'implement'", () => {
      expect(shouldSuggestTeam("implement the new feature")).toBe(true);
      expect(shouldSuggestTeam("implement v2 migration")).toBe(true);
    });
  });

  describe("does NOT trigger on common short tasks", () => {
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
      expect(shouldSuggestTeam(task)).toBe(false);
    });
  });

  describe("case insensitivity", () => {
    it("triggers regardless of case", () => {
      expect(shouldSuggestTeam("PLAN the rollout")).toBe(true);
      expect(shouldSuggestTeam("Plan The Rollout")).toBe(true);
      expect(shouldSuggestTeam("Architect the system")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns false on empty task", () => {
      expect(shouldSuggestTeam("")).toBe(false);
      expect(shouldSuggestTeam("   ")).toBe(false);
    });

    it("does NOT match stems or longer words (strict \\b boundary)", () => {
      expect(shouldSuggestTeam("the plans desk")).toBe(false);
      expect(shouldSuggestTeam("redesign the auth flow")).toBe(false);
      expect(shouldSuggestTeam("implementation tasks")).toBe(false);
      expect(shouldSuggestTeam("auditing the codebase")).toBe(false);
      expect(shouldSuggestTeam("auditor picked up")).toBe(false);
      expect(shouldSuggestTeam("architectural decision")).toBe(false);
    });
  });
});
