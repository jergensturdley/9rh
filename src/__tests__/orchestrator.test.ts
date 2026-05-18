import { describe, expect, it, jest } from "@jest/globals";
import {
  classifyRisk,
  isTrivialEdit,
  requiresSecurityAudit,
  requiresTestStrategy,
} from "../orchestrator/roles.js";
import {
  canOverride,
  createConflictLog,
  recordConflict,
  resolveConflict,
} from "../orchestrator/conflictResolver.js";
import {
  cachePlan,
  cacheTestStrategy,
  createOrchestratorCache,
  getCachedPlan,
  getCachedTestStrategy,
  getCacheStats,
  hashTask,
  hashTaskAndFiles,
} from "../orchestrator/performanceCache.js";
import { createProjectMemory, createTaskState } from "../orchestrator/taskState.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import type { RoleName } from "../orchestrator/roles.js";
import type { OrchestratorEvent } from "../orchestrator/orchestrator.js";

describe("classifyRisk", () => {
  it("returns critical for rm -rf / commands", () => {
    expect(classifyRisk("rm -rf / all the things")).toBe("critical");
  });

  it("returns critical for drop table commands", () => {
    expect(classifyRisk("DROP TABLE users")).toBe("critical");
  });

  it("returns high for auth changes", () => {
    expect(classifyRisk("update authentication middleware")).toBe("high");
  });

  it("returns high for API key writes", () => {
    expect(classifyRisk("write API keys to .env file")).toBe("high");
  });

  it("returns medium for refactoring", () => {
    expect(classifyRisk("refactor the user service module")).toBe("medium");
  });

  it("returns medium for new endpoints", () => {
    expect(classifyRisk("add new api endpoint for users")).toBe("medium");
  });

  it("returns low for innocuous tasks", () => {
    expect(classifyRisk("list all files in src directory")).toBe("low");
  });
});

describe("requiresSecurityAudit", () => {
  it("requires audit for high risk", () => {
    expect(requiresSecurityAudit("high")).toBe(true);
  });

  it("requires audit for critical risk", () => {
    expect(requiresSecurityAudit("critical")).toBe(true);
  });

  it("does not require audit for medium risk", () => {
    expect(requiresSecurityAudit("medium")).toBe(false);
  });

  it("does not require audit for low risk", () => {
    expect(requiresSecurityAudit("low")).toBe(false);
  });
});

describe("requiresTestStrategy", () => {
  it("returns true when task mentions tests", () => {
    expect(requiresTestStrategy("add unit tests for the auth module")).toBe(true);
  });

  it("returns true when task mentions coverage", () => {
    expect(requiresTestStrategy("improve coverage for the api layer")).toBe(true);
  });

  it("returns true for TDD mentions", () => {
    expect(requiresTestStrategy("implement using TDD approach")).toBe(true);
  });

  it("returns false for tasks with no test mention", () => {
    expect(requiresTestStrategy("refactor the user service module")).toBe(false);
  });
});

describe("isTrivialEdit", () => {
  it("recognizes typo fixes as trivial", () => {
    expect(isTrivialEdit("fix typo in README heading")).toBe(true);
  });

  it("recognizes rename variable as trivial", () => {
    expect(isTrivialEdit("rename variable foo to bar")).toBe(true);
  });

  it("is not trivial if task mentions security", () => {
    expect(isTrivialEdit("fix typo in security module")).toBe(false);
  });

  it("is not trivial for long tasks", () => {
    expect(isTrivialEdit("fix typo " + "x".repeat(120))).toBe(false);
  });

  it("is not trivial for delete operations", () => {
    expect(isTrivialEdit("fix typo then delete old comments")).toBe(false);
  });
});

describe("resolveConflict", () => {
  it("escalates security_auditor blocking conflict to human", () => {
    const { resolution } = resolveConflict(
      { parties: ["security_auditor", "implementer"], description: "critical vuln", severity: "blocking" },
      0,
      2
    );
    expect(resolution).toBe("escalate_human");
  });

  it("escalates security_auditor major conflict to coordinator", () => {
    const { resolution } = resolveConflict(
      { parties: ["security_auditor", "implementer"], description: "medium concern", severity: "major" },
      0,
      2
    );
    expect(resolution).toBe("escalate_coordinator");
  });

  it("sends implementer to revise within maxRevisions", () => {
    const { resolution } = resolveConflict(
      { parties: ["reviewer", "implementer"], description: "code quality issues", severity: "major" },
      0,
      2
    );
    expect(resolution).toBe("implementer_revises");
  });

  it("escalates to human when maxRevisions exhausted", () => {
    const { resolution } = resolveConflict(
      { parties: ["reviewer", "implementer"], description: "ongoing disagreement", severity: "major" },
      2,
      2
    );
    expect(resolution).toBe("escalate_human");
  });

  it("escalates test_strategist conflict to coordinator", () => {
    const { resolution } = resolveConflict(
      { parties: ["test_strategist", "implementer"], description: "coverage gap", severity: "major" },
      0,
      2
    );
    expect(resolution).toBe("escalate_coordinator");
  });
});

describe("canOverride", () => {
  it("never allows overriding security_auditor", () => {
    const { allowed } = canOverride("reviewer", "security_auditor", "I think it is fine");
    expect(allowed).toBe(false);
  });

  it("allows reviewer to override architect with justification", () => {
    const { allowed } = canOverride("reviewer", "architect", "This approach causes circular deps");
    expect(allowed).toBe(true);
  });

  it("rejects reviewer override of architect without sufficient justification", () => {
    const { allowed } = canOverride("reviewer", "architect", "bad");
    expect(allowed).toBe(false);
  });

  it("allows override with sufficient justification", () => {
    const { allowed } = canOverride("reviewer", "implementer", "Implementation has a critical bug in X");
    expect(allowed).toBe(true);
  });

  it("rejects override without justification", () => {
    const { allowed } = canOverride("reviewer", "implementer", "nope");
    expect(allowed).toBe(false);
  });
});

describe("recordConflict", () => {
  it("records a conflict with generated id and timestamp", () => {
    const log = createConflictLog();
    const c = recordConflict(log, {
      parties: ["reviewer", "implementer"],
      description: "test",
      severity: "minor",
    });
    expect(c.id).toMatch(/^conflict_/);
    expect(c.timestamp).toBeGreaterThan(0);
    expect(log.conflicts).toHaveLength(1);
    expect(log.conflicts[0]).toBe(c);
  });
});

describe("hashing", () => {
  it("hashTask is deterministic", () => {
    expect(hashTask("do something")).toBe(hashTask("do something"));
  });

  it("hashTask trims and lowercases", () => {
    expect(hashTask("  Do Something  ")).toBe(hashTask("do something"));
  });

  it("hashTask is different for different tasks", () => {
    expect(hashTask("task a")).not.toBe(hashTask("task b"));
  });

  it("hashTaskAndFiles is deterministic and file-order-independent", () => {
    expect(hashTaskAndFiles("task", ["b.ts", "a.ts"])).toBe(
      hashTaskAndFiles("task", ["a.ts", "b.ts"])
    );
  });

  it("hashTaskAndFiles differs when files differ", () => {
    expect(hashTaskAndFiles("task", ["a.ts"])).not.toBe(
      hashTaskAndFiles("task", ["b.ts"])
    );
  });
});

describe("OrchestratorCache", () => {
  it("returns null for cache miss", () => {
    const cache = createOrchestratorCache();
    expect(getCachedPlan(cache, "missing")).toBeNull();
    expect(getCachedTestStrategy(cache, "missing")).toBeNull();
  });

  it("returns cached plan on hit", () => {
    const cache = createOrchestratorCache();
    const plan = {
      summary: "test plan",
      steps: [],
      riskLevel: "low" as const,
      requiresSecurityAudit: false,
      requiresTestStrategy: false,
      isTrivial: false,
      successCriteria: [],
    };
    cachePlan(cache, "key1", plan);
    expect(getCachedPlan(cache, "key1")).toEqual(plan);
  });

  it("increments hit count", () => {
    const cache = createOrchestratorCache();
    const plan = {
      summary: "p",
      steps: [],
      riskLevel: "low" as const,
      requiresSecurityAudit: false,
      requiresTestStrategy: false,
      isTrivial: false,
      successCriteria: [],
    };
    cachePlan(cache, "k", plan);
    getCachedPlan(cache, "k");
    getCachedPlan(cache, "k");
    expect(getCacheStats(cache).totalHits).toBe(2);
  });

  it("returns cached test strategy on hit", () => {
    const cache = createOrchestratorCache();
    const result = {
      verdict: "adequate" as const,
      testPlan: { unit: [], integration: [], e2e: [], edgeCases: [], failurePaths: [] },
      coverageGaps: [],
      requiredAdditions: [],
      justification: "ok",
    };
    cacheTestStrategy(cache, "ts-key", result);
    expect(getCachedTestStrategy(cache, "ts-key")).toEqual(result);
  });

  it("getCacheStats returns correct sizes", () => {
    const cache = createOrchestratorCache();
    cachePlan(cache, "p1", {
      summary: "p",
      steps: [],
      riskLevel: "low" as const,
      requiresSecurityAudit: false,
      requiresTestStrategy: false,
      isTrivial: false,
      successCriteria: [],
    });
    cacheTestStrategy(cache, "t1", {
      verdict: "adequate" as const,
      testPlan: { unit: [], integration: [], e2e: [], edgeCases: [], failurePaths: [] },
      coverageGaps: [],
      requiredAdditions: [],
      justification: "ok",
    });
    const stats = getCacheStats(cache);
    expect(stats.planCacheSize).toBe(1);
    expect(stats.testStrategyCacheSize).toBe(1);
  });
});

function makeOrchestrator(
  roleInvoker: (role: RoleName, _prompt: string) => Promise<string>,
  opts: { maxRevisions?: number; onEvent?: (e: OrchestratorEvent) => void } = {}
) {
  return new Orchestrator({
    baseURL: "http://localhost:20128/v1",
    apiKey: "test",
    model: "test-model",
    workDir: "/tmp",
    maxRevisions: opts.maxRevisions ?? 2,
    onEvent: opts.onEvent,
    roleInvoker,
  });
}

const approvedReview = JSON.stringify({
  decision: "approved",
  verdict: "LGTM",
  issues: [],
  requiredChanges: [],
  justification: "All good",
});

const approvedSecurity = JSON.stringify({
  clearance: "approved",
  riskAssessment: "medium",
  vulnerabilities: [],
  conditions: [],
  justification: "No issues",
});

const lowRiskPlan = JSON.stringify({
  summary: "Trivial feature",
  steps: [{ id: "step_1", action: "do something", files: ["src/foo.ts"], risk: "low" }],
  riskLevel: "low",
  requiresSecurityAudit: false,
  requiresTestStrategy: false,
  isTrivial: false,
  successCriteria: ["Done"],
});

const implementationOk = JSON.stringify({
  status: "completed",
  stepsCompleted: ["step_1"],
  stepsSkipped: [],
  filesModified: ["src/foo.ts"],
  testResults: "pass",
  diff: "minor change",
});

describe("Orchestrator — happy path (low risk, no security, reviewer approves)", () => {
  it("emits task_complete and returns completed status", async () => {
    const events: OrchestratorEvent[] = [];
    const invoker = jest.fn(async (role: RoleName) => {
      if (role === "architect") return lowRiskPlan;
      if (role === "implementer") return implementationOk;
      if (role === "reviewer") return approvedReview;
      return "{}";
    });

    const o = makeOrchestrator(invoker, { onEvent: (e) => events.push(e) });
    const result = await o.orchestrate("Add a helper function to src/foo.ts");

    expect(result.status).toBe("completed");
    expect(result.conflictLog.conflicts).toHaveLength(0);
    expect(events.some((e) => e.type === "task_complete")).toBe(true);
    expect(events.some((e) => e.type === "task_failed")).toBe(false);

    const roles = events.filter((e) => e.type === "role_complete").map((e) => (e as { role: string }).role);
    expect(roles).toContain("architect");
    expect(roles).toContain("implementer");
    expect(roles).toContain("reviewer");
    expect(roles).not.toContain("security_auditor");
    expect(roles).not.toContain("test_strategist");
  });
});

describe("Orchestrator — security rejection escalates to human", () => {
  it("returns escalated status when security auditor rejects", async () => {
    const highRiskPlan = JSON.stringify({
      summary: "Update auth tokens",
      steps: [{ id: "step_1", action: "update token generation", files: ["src/auth.ts"], risk: "high" }],
      riskLevel: "high",
      requiresSecurityAudit: true,
      requiresTestStrategy: false,
      isTrivial: false,
      successCriteria: ["Tokens rotate correctly"],
    });

    const rejectedSecurity = JSON.stringify({
      clearance: "rejected",
      riskAssessment: "critical",
      vulnerabilities: [
        {
          severity: "critical",
          description: "Tokens stored in plaintext",
          location: "src/auth.ts:12",
          fix: "Use secure hash",
        },
      ],
      conditions: [],
      justification: "Plaintext token storage is unacceptable",
    });

    const events: OrchestratorEvent[] = [];
    const invoker = jest.fn(async (role: RoleName) => {
      if (role === "architect") return highRiskPlan;
      if (role === "implementer") return implementationOk;
      if (role === "security_auditor") return rejectedSecurity;
      return approvedReview;
    });

    const o = makeOrchestrator(invoker, { onEvent: (e) => events.push(e) });
    const result = await o.orchestrate("update authentication token generation");

    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toMatch(/security audit rejected/i);
    expect(result.conflictLog.conflicts).toHaveLength(1);
    expect(result.conflictLog.conflicts[0].parties).toContain("security_auditor");
    expect(events.some((e) => e.type === "escalation")).toBe(true);
  });
});

describe("Orchestrator — reviewer/implementer revision loop", () => {
  it("iterates up to maxRevisions then escalates", async () => {
    const needsRevision = JSON.stringify({
      decision: "needs_revision",
      verdict: "Missing error handling",
      issues: [{ severity: "blocker", description: "No try/catch around async call" }],
      requiredChanges: ["Add try/catch in processRequest"],
      justification: "Async calls must be wrapped",
    });

    const revisionCount = { n: 0 };
    const invoker = jest.fn(async (role: RoleName) => {
      if (role === "architect") return lowRiskPlan;
      if (role === "implementer") return implementationOk;
      if (role === "reviewer") {
        revisionCount.n++;
        return needsRevision;
      }
      return "{}";
    });

    const events: OrchestratorEvent[] = [];
    const o = makeOrchestrator(invoker, { maxRevisions: 1, onEvent: (e) => events.push(e) });
    const result = await o.orchestrate("Add a helper function to src/foo.ts");

    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toMatch(/maximum revisions/i);
    expect(result.conflictLog.conflicts.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "escalation")).toBe(true);
    expect(revisionCount.n).toBeGreaterThan(1);
  });

  it("resolves after one revision if reviewer approves second time", async () => {
    let reviewCall = 0;
    const invoker = jest.fn(async (role: RoleName) => {
      if (role === "architect") return lowRiskPlan;
      if (role === "implementer") return implementationOk;
      if (role === "reviewer") {
        reviewCall++;
        if (reviewCall === 1) {
          return JSON.stringify({
            decision: "needs_revision",
            verdict: "Missing docstring",
            issues: [{ severity: "warning", description: "Add docstring" }],
            requiredChanges: ["Add JSDoc to processRequest"],
            justification: "Docs needed",
          });
        }
        return approvedReview;
      }
      return "{}";
    });

    const o = makeOrchestrator(invoker, { maxRevisions: 2 });
    const result = await o.orchestrate("Add a helper function to src/foo.ts");

    expect(result.status).toBe("completed");
    expect(reviewCall).toBe(2);
  });
});

describe("Orchestrator — trivial edit skips reviews", () => {
  it("skips reviewer, security_auditor, test_strategist for trivial edits", async () => {
    const invoker = jest.fn(async () => implementationOk);
    const events: OrchestratorEvent[] = [];
    const o = makeOrchestrator(invoker, { onEvent: (e) => events.push(e) });

    const result = await o.orchestrate("fix typo in src/README comment");

    expect(result.status).toBe("completed");
    const skipped = events.filter((e) => e.type === "role_skip").map((e) => (e as { role: string }).role);
    expect(skipped).toContain("reviewer");
    expect(skipped).toContain("security_auditor");
    expect(skipped).toContain("test_strategist");
    const completedRoles = events
      .filter((e) => e.type === "role_complete")
      .map((e) => (e as { role: string }).role);
    expect(completedRoles).not.toContain("reviewer");
    expect(completedRoles).not.toContain("security_auditor");
  });
});

describe("Orchestrator — cache_hit events", () => {
  it("emits cache_hit on second call with same task", async () => {
    const invoker = jest.fn(async (role: RoleName) => {
      if (role === "architect") return lowRiskPlan;
      if (role === "implementer") return implementationOk;
      if (role === "reviewer") return approvedReview;
      return "{}";
    });

    const events: OrchestratorEvent[] = [];
    const o = makeOrchestrator(invoker, { onEvent: (e) => events.push(e) });

    await o.orchestrate("Add a helper function to src/foo.ts");
    events.length = 0;
    await o.orchestrate("Add a helper function to src/foo.ts");

    expect(events.some((e) => e.type === "cache_hit" && (e as { role: string }).role === "architect")).toBe(true);
  });
});

describe("Orchestrator — cacheStats", () => {
  it("returns stats object", async () => {
    const invoker = jest.fn(async (role: RoleName) => {
      if (role === "architect") return lowRiskPlan;
      if (role === "implementer") return implementationOk;
      if (role === "reviewer") return approvedReview;
      return "{}";
    });
    const o = makeOrchestrator(invoker);
    await o.orchestrate("Add a helper function to src/foo.ts");
    const stats = o.cacheStats();
    expect(stats).toHaveProperty("planCacheSize");
    expect(stats).toHaveProperty("testStrategyCacheSize");
    expect(stats).toHaveProperty("totalHits");
  });
});
