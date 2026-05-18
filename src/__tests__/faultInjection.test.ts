import { describe, it, expect } from "@jest/globals";
import { FaultInjector } from "../faultInjection/injector.js";
import { RecoveryEvaluator } from "../faultInjection/evaluator.js";
import { ScenarioRegistry, createDefaultRegistry } from "../faultInjection/registry.js";
import { generateResilienceReport, rankByRisk, formatReport } from "../faultInjection/report.js";
import { BUILT_IN_SCENARIOS } from "../faultInjection/scenarios.js";
import {
  FAULT_TO_ERROR_CLASS,
  MINIMUM_RESILIENCE_THRESHOLD,
  RECOVERY_SCORES,
} from "../faultInjection/types.js";
import type { FaultScenario, ScenarioResult } from "../faultInjection/types.js";
import { withErrorInterception } from "../repair/errorInterceptor.js";
import { CircuitBreaker } from "../repair/circuitBreaker.js";
import { ErrorClass } from "../repair/errorTaxonomy.js";

describe("FaultInjector — trigger: always", () => {
  it("throws on every call", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("openai.stream", async () => "ok", {
      target: "openai.stream",
      type: "timeout",
      trigger: { kind: "always" },
    });
    await expect(fn()).rejects.toThrow(/timeout/i);
    await expect(fn()).rejects.toThrow(/timeout/i);
  });
});

describe("FaultInjector — trigger: on_call_n", () => {
  it("throws only on the nth call", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("openai.single", async () => "ok", {
      target: "openai.single",
      type: "rate_limit",
      trigger: { kind: "on_call_n", n: 2 },
    });
    await expect(fn()).resolves.toBe("ok");
    await expect(fn()).rejects.toThrow(/rate limit/i);
    await expect(fn()).resolves.toBe("ok");
  });
});

describe("FaultInjector — trigger: after_call_n", () => {
  it("passes first n calls then throws", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("fs.write", async () => "written", {
      target: "fs.write",
      type: "enospc",
      trigger: { kind: "after_call_n", n: 2 },
    });
    await expect(fn()).resolves.toBe("written");
    await expect(fn()).resolves.toBe("written");
    await expect(fn()).rejects.toThrow(/enospc/i);
    await expect(fn()).rejects.toThrow(/enospc/i);
  });
});

describe("FaultInjector — trigger: first_n_calls", () => {
  it("throws first n calls then passes through", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("openai.stream", async () => "ok", {
      target: "openai.stream",
      type: "timeout",
      trigger: { kind: "first_n_calls", n: 2 },
    });
    await expect(fn()).rejects.toThrow(/timeout/i);
    await expect(fn()).rejects.toThrow(/timeout/i);
    await expect(fn()).resolves.toBe("ok");
  });
});

describe("FaultInjector — trigger: probabilistic", () => {
  it("never fires when p=0", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("network.fetch", async () => "ok", {
      target: "network.fetch",
      type: "network_reset",
      trigger: { kind: "probabilistic", p: 0 },
    });
    for (let i = 0; i < 10; i++) {
      await expect(fn()).resolves.toBe("ok");
    }
  });

  it("always fires when p=1", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("network.fetch", async () => "ok", {
      target: "network.fetch",
      type: "network_reset",
      trigger: { kind: "probabilistic", p: 1 },
    });
    await expect(fn()).rejects.toThrow(/econnreset/i);
  });
});

describe("FaultInjector — register + reset", () => {
  it("register fires for matching target", async () => {
    const injector = new FaultInjector();
    injector.register({
      target: "fs.read",
      type: "eacces",
      trigger: { kind: "always" },
    });
    const fn = injector.wrap("fs.read", async () => "content");
    await expect(fn()).rejects.toThrow(/eacces/i);
  });

  it("reset clears all specs and call counts", async () => {
    const injector = new FaultInjector();
    injector.register({
      target: "fs.read",
      type: "eacces",
      trigger: { kind: "always" },
    });
    injector.reset();
    const fn = injector.wrap("fs.read", async () => "content");
    await expect(fn()).resolves.toBe("content");
    expect(injector.getCallCount("fs.read")).toBe(1);
  });

  it("reset(target) clears only that target", async () => {
    const injector = new FaultInjector();
    injector.register({ target: "fs.read", type: "eacces", trigger: { kind: "always" } });
    injector.register({ target: "fs.write", type: "enospc", trigger: { kind: "always" } });
    injector.reset("fs.read");

    const readFn = injector.wrap("fs.read", async () => "ok");
    const writeFn = injector.wrap("fs.write", async () => "ok");

    await expect(readFn()).resolves.toBe("ok");
    await expect(writeFn()).rejects.toThrow(/enospc/i);
  });

  it("custom message overrides default", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("tool.bash", async () => "ok", {
      target: "tool.bash",
      type: "timeout",
      trigger: { kind: "always" },
      message: "custom: bash killed after 5s",
    });
    await expect(fn()).rejects.toThrow("custom: bash killed after 5s");
  });
});

describe("FaultInjector — call count tracking", () => {
  it("tracks call count correctly", async () => {
    const injector = new FaultInjector();
    const fn = injector.wrap("sandbox.exec", async () => "ok", {
      target: "sandbox.exec",
      type: "timeout",
      trigger: { kind: "on_call_n", n: 999 },
    });
    await fn();
    await fn();
    await fn();
    expect(injector.getCallCount("sandbox.exec")).toBe(3);
  });
});

describe("FAULT_TO_ERROR_CLASS mappings", () => {
  it("maps transient faults to RECOVERABLE", () => {
    expect(FAULT_TO_ERROR_CLASS.timeout).toBe("RECOVERABLE");
    expect(FAULT_TO_ERROR_CLASS.rate_limit).toBe("RECOVERABLE");
    expect(FAULT_TO_ERROR_CLASS.network_reset).toBe("RECOVERABLE");
    expect(FAULT_TO_ERROR_CLASS.premature_close).toBe("RECOVERABLE");
    expect(FAULT_TO_ERROR_CLASS.circuit_breaker_open).toBe("RECOVERABLE");
  });

  it("maps agent logic faults to AGENT_ERROR", () => {
    expect(FAULT_TO_ERROR_CLASS.malformed_json).toBe("AGENT_ERROR");
    expect(FAULT_TO_ERROR_CLASS.invalid_tool_args).toBe("AGENT_ERROR");
  });

  it("maps environment faults to ENVIRONMENT_ERROR", () => {
    expect(FAULT_TO_ERROR_CLASS.enospc).toBe("ENVIRONMENT_ERROR");
    expect(FAULT_TO_ERROR_CLASS.eacces).toBe("ENVIRONMENT_ERROR");
    expect(FAULT_TO_ERROR_CLASS.sandbox_crash).toBe("ENVIRONMENT_ERROR");
    expect(FAULT_TO_ERROR_CLASS.missing_env_var).toBe("ENVIRONMENT_ERROR");
  });

  it("maps invariant_violation to FATAL", () => {
    expect(FAULT_TO_ERROR_CLASS.invariant_violation).toBe("FATAL");
  });
});

describe("RECOVERY_SCORES", () => {
  it("retried and repaired score 1.0", () => {
    expect(RECOVERY_SCORES.retried).toBe(1.0);
    expect(RECOVERY_SCORES.repaired).toBe(1.0);
  });

  it("escalated scores 0.8", () => {
    expect(RECOVERY_SCORES.escalated).toBe(0.8);
  });

  it("degraded_gracefully scores 0.6", () => {
    expect(RECOVERY_SCORES.degraded_gracefully).toBe(0.6);
  });

  it("silent_ignore and none score 0", () => {
    expect(RECOVERY_SCORES.silent_ignore).toBe(0.0);
    expect(RECOVERY_SCORES.none).toBe(0.0);
  });

  it("corrupt_output is negative", () => {
    expect(RECOVERY_SCORES.corrupt_output).toBeLessThan(0);
  });
});

describe("RecoveryEvaluator — computeResilienceScore", () => {
  it("returns zero scores when no events recorded", () => {
    const ev = new RecoveryEvaluator();
    const scores = ev.computeResilienceScore();
    expect(scores.total).toBe(0);
    expect(scores.detection).toBe(0);
    expect(scores.classification).toBe(0);
    expect(scores.recovery).toBe(0);
  });

  it("full score when fault detected, classified correctly, and recovered via retried", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("openai.stream", "timeout");
    ev.onFaultDetected("openai.stream", "timeout", ErrorClass.RECOVERABLE);
    ev.onRecovery("retried");

    const scores = ev.computeResilienceScore();
    expect(scores.detection).toBeCloseTo(0.25);
    expect(scores.classification).toBeCloseTo(0.25);
    expect(scores.recovery).toBeCloseTo(0.5);
    expect(scores.total).toBeCloseTo(1.0);
  });

  it("detection score penalised when fault not detected", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("fs.write", "enospc");
    ev.onRecovery("none");

    const scores = ev.computeResilienceScore();
    expect(scores.detection).toBe(0);
    expect(scores.classification).toBe(0);
    expect(scores.total).toBe(0);
  });

  it("classification penalised when error class is wrong", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("openai.stream", "timeout");
    // timeout should be RECOVERABLE but we report FATAL — intentionally wrong class for negative test
    ev.onFaultDetected("openai.stream", "timeout", ErrorClass.FATAL);
    ev.onRecovery("escalated");

    const scores = ev.computeResilienceScore();
    expect(scores.detection).toBeCloseTo(0.25);
    expect(scores.classification).toBe(0);
  });

  it("degraded_gracefully recovery gives partial score", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("repair.llm", "network_reset");
    ev.onFaultDetected("repair.llm", "network_reset", ErrorClass.RECOVERABLE);
    ev.onRecovery("degraded_gracefully");

    const scores = ev.computeResilienceScore();
    expect(scores.recovery).toBeCloseTo(0.5 * RECOVERY_SCORES.degraded_gracefully);
  });

  it("reset clears all state", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("fs.read", "eacces");
    ev.onFaultDetected("fs.read", "eacces", ErrorClass.ENVIRONMENT_ERROR);
    ev.onRecovery("escalated");
    ev.reset();

    const scores = ev.computeResilienceScore();
    expect(scores.total).toBe(0);
  });
});

describe("RecoveryEvaluator — scoreScenario", () => {
  it("passes when score >= 0.8 and recovery path matches", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("openai.stream", "timeout");
    ev.onFaultDetected("openai.stream", "timeout", ErrorClass.RECOVERABLE);
    ev.onRecovery("retried");

    const result = ev.scoreScenario("test-1", { detectedFault: true, recoveryPath: "retried" }, 50);
    expect(result.passed).toBe(true);
    expect(result.resilienceScore).toBeCloseTo(1.0);
    expect(result.scenarioId).toBe("test-1");
  });

  it("fails when expected detection=true but fault was not detected", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("fs.write", "enospc");
    ev.onRecovery("none");

    const result = ev.scoreScenario("test-2", { detectedFault: true, recoveryPath: "escalated" }, 10);
    expect(result.passed).toBe(false);
  });

  it("fails when recovery path does not match expected", () => {
    const ev = new RecoveryEvaluator();
    ev.onFaultInjected("openai.stream", "malformed_json");
    ev.onFaultDetected("openai.stream", "malformed_json", ErrorClass.AGENT_ERROR);
    ev.onRecovery("escalated");

    const result = ev.scoreScenario("test-3", { detectedFault: true, recoveryPath: "repaired" }, 20);
    expect(result.passed).toBe(false);
    expect(result.actualRecoveryPath).toBe("escalated");
    expect(result.expectedRecoveryPath).toBe("repaired");
  });
});

describe("ScenarioRegistry", () => {
  it("seeds built-in scenarios by default", () => {
    const reg = createDefaultRegistry();
    expect(reg.size()).toBe(BUILT_IN_SCENARIOS.length);
  });

  it("starts empty when seedDefaults=false", () => {
    const reg = new ScenarioRegistry(false);
    expect(reg.size()).toBe(0);
  });

  it("register and get round-trip", () => {
    const reg = new ScenarioRegistry(false);
    const scenario: FaultScenario = {
      id: "custom-1",
      name: "Custom Scenario",
      description: "Test",
      category: "network",
      severity: "low",
      fault: { target: "openai.stream", type: "timeout", trigger: { kind: "always" } },
      expected: { detectedFault: true, recoveryPath: "retried" },
    };
    reg.register(scenario);
    expect(reg.get("custom-1")).toEqual(scenario);
  });

  it("getAll returns all registered scenarios", () => {
    const reg = createDefaultRegistry();
    expect(reg.getAll().length).toBe(BUILT_IN_SCENARIOS.length);
  });

  it("findByCategory filters correctly", () => {
    const reg = createDefaultRegistry();
    const network = reg.findByCategory("network");
    expect(network.length).toBeGreaterThan(0);
    expect(network.every((s) => s.category === "network")).toBe(true);
  });

  it("findBySeverity filters correctly", () => {
    const reg = createDefaultRegistry();
    const critical = reg.findBySeverity("critical");
    expect(critical.length).toBeGreaterThan(0);
    expect(critical.every((s) => s.severity === "critical")).toBe(true);
  });

  it("findByTag filters correctly", () => {
    const reg = createDefaultRegistry();
    const retryTagged = reg.findByTag("retry");
    expect(retryTagged.length).toBeGreaterThan(0);
    expect(retryTagged.every((s) => s.tags?.includes("retry"))).toBe(true);
  });

  it("get returns undefined for unknown id", () => {
    const reg = new ScenarioRegistry(false);
    expect(reg.get("does-not-exist")).toBeUndefined();
  });

  it("toJSON / fromJSON round-trip", () => {
    const reg = createDefaultRegistry();
    const json = reg.toJSON();
    const restored = ScenarioRegistry.fromJSON(json);
    expect(restored.size()).toBe(reg.size());
    for (const s of json) {
      expect(restored.get(s.id)).toEqual(s);
    }
  });
});

describe("generateResilienceReport", () => {
  function makeResult(id: string, score: number, passed: boolean): ScenarioResult {
    return {
      scenarioId: id,
      passed,
      resilienceScore: score,
      actualRecoveryPath: passed ? "retried" : "none",
      expectedRecoveryPath: "retried",
      detectionScore: score * 0.25,
      classificationScore: score * 0.25,
      recoveryScore: score * 0.5,
      errorEvents: [],
      durationMs: 10,
    };
  }

  it("passes when all results pass and average score >= threshold", () => {
    const results = [makeResult("a", 1.0, true), makeResult("b", 1.0, true)];
    const report = generateResilienceReport("run-1", results);
    expect(report.passed).toBe(true);
    expect(report.overallScore).toBeCloseTo(1.0);
    expect(report.passedScenarios).toBe(2);
    expect(report.failedScenarios).toBe(0);
  });

  it("fails when any result fails", () => {
    const results = [makeResult("a", 1.0, true), makeResult("b", 0.3, false)];
    const report = generateResilienceReport("run-2", results);
    expect(report.passed).toBe(false);
    expect(report.failedScenarios).toBe(1);
  });

  it("fails when overall score is below threshold even if all passed=true", () => {
    const results = [makeResult("a", 0.5, true), makeResult("b", 0.5, true)];
    const report = generateResilienceReport("run-3", results, 0.8);
    expect(report.passed).toBe(false);
  });

  it("uses MINIMUM_RESILIENCE_THRESHOLD by default", () => {
    const report = generateResilienceReport("run-4", []);
    expect(report.minimumThreshold).toBe(MINIMUM_RESILIENCE_THRESHOLD);
  });

  it("report has correct counts", () => {
    const results = [
      makeResult("a", 1.0, true),
      makeResult("b", 1.0, true),
      makeResult("c", 0.2, false),
    ];
    const report = generateResilienceReport("run-5", results);
    expect(report.totalScenarios).toBe(3);
    expect(report.passedScenarios).toBe(2);
    expect(report.failedScenarios).toBe(1);
  });
});

describe("rankByRisk", () => {
  it("places failed scenarios before passed ones", () => {
    function r(id: string, score: number, passed: boolean): ScenarioResult {
      return {
        scenarioId: id,
        passed,
        resilienceScore: score,
        actualRecoveryPath: "none",
        expectedRecoveryPath: "retried",
        detectionScore: 0,
        classificationScore: 0,
        recoveryScore: 0,
        errorEvents: [],
        durationMs: 0,
      };
    }
    const results = [r("pass-high", 0.95, true), r("fail-low", 0.1, false), r("fail-med", 0.5, false)];
    const report = generateResilienceReport("run-rank", results);
    const ranked = rankByRisk(report);
    expect(ranked[0].passed).toBe(false);
    expect(ranked[1].passed).toBe(false);
    expect(ranked[2].passed).toBe(true);
  });

  it("sorts by resilience score within failed group (lowest first)", () => {
    function r(id: string, score: number): ScenarioResult {
      return {
        scenarioId: id,
        passed: false,
        resilienceScore: score,
        actualRecoveryPath: "none",
        expectedRecoveryPath: "retried",
        detectionScore: 0,
        classificationScore: 0,
        recoveryScore: 0,
        errorEvents: [],
        durationMs: 0,
      };
    }
    const results = [r("b", 0.5), r("a", 0.1), r("c", 0.7)];
    const report = generateResilienceReport("run-sort", results);
    const ranked = rankByRisk(report);
    expect(ranked[0].resilienceScore).toBe(0.1);
    expect(ranked[1].resilienceScore).toBe(0.5);
    expect(ranked[2].resilienceScore).toBe(0.7);
  });
});

describe("formatReport", () => {
  it("includes PASS status for a clean report", () => {
    const report = generateResilienceReport("run-fmt", [
      {
        scenarioId: "s1",
        passed: true,
        resilienceScore: 1.0,
        actualRecoveryPath: "retried",
        expectedRecoveryPath: "retried",
        detectionScore: 0.25,
        classificationScore: 0.25,
        recoveryScore: 0.5,
        errorEvents: [],
        durationMs: 5,
      },
    ]);
    const text = formatReport(report);
    expect(text).toContain("PASS");
    expect(text).toContain("run-fmt");
    expect(text).toContain("100.0%");
  });

  it("includes FAIL status and scenario IDs for failed report", () => {
    const report = generateResilienceReport("run-fail-fmt", [
      {
        scenarioId: "broken-scenario",
        passed: false,
        resilienceScore: 0.2,
        actualRecoveryPath: "none",
        expectedRecoveryPath: "repaired",
        detectionScore: 0,
        classificationScore: 0,
        recoveryScore: 0,
        errorEvents: [],
        durationMs: 5,
      },
    ]);
    const text = formatReport(report);
    expect(text).toContain("FAIL");
    expect(text).toContain("broken-scenario");
  });
});

describe("MINIMUM_RESILIENCE_THRESHOLD", () => {
  it("is exactly 0.8", () => {
    expect(MINIMUM_RESILIENCE_THRESHOLD).toBe(0.8);
  });
});

describe("Scenario flow — api_timeout_on_retry", () => {
  it("correctly handles retry-based recovery from timeout", async () => {
    const injector = new FaultInjector();
    const ev = new RecoveryEvaluator();
    const start = Date.now();

    const faultedFn = injector.wrap("openai.stream", async () => "llm-response", {
      target: "openai.stream",
      type: "timeout",
      trigger: { kind: "first_n_calls", n: 2 },
    });

    ev.onFaultInjected("openai.stream", "timeout");

    let retryCount = 0;
    let result: string | undefined;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await faultedFn();
        break;
      } catch (err) {
        ev.onFaultDetected("openai.stream", "timeout", ErrorClass.RECOVERABLE);
        retryCount++;
      }
    }

    ev.onRecovery("retried");

    const scenarioResult = ev.scoreScenario(
      "api_timeout_on_retry",
      { detectedFault: true, recoveryPath: "retried", errorClass: ErrorClass.RECOVERABLE },
      Date.now() - start
    );

    expect(result).toBe("llm-response");
    expect(retryCount).toBe(2);
    expect(scenarioResult.passed).toBe(true);
    expect(scenarioResult.resilienceScore).toBeCloseTo(1.0);
  });
});

describe("Scenario flow — malformed_json_response (withErrorInterception)", () => {
  it("repair system detects and classifies AGENT_ERROR", async () => {
    const injector = new FaultInjector();
    const ev = new RecoveryEvaluator();
    const start = Date.now();

    let callCount = 0;
    const faultedFn = injector.wrap(
      "openai.stream",
      async () => {
        callCount++;
        return "valid-response";
      },
      {
        target: "openai.stream",
        type: "malformed_json",
        trigger: { kind: "on_call_n", n: 1 },
      }
    );

    ev.onFaultInjected("openai.stream", "malformed_json");

    const result = await withErrorInterception(faultedFn, {
      sourceLayer: "llm",
      onTaggedError: (tagged) => {
        ev.onFaultDetected("openai.stream", "malformed_json", tagged.errorClass);
      },
      repairAgent: async () => {
        ev.onRecovery("repaired");
        return { success: true, escalate: false };
      },
    });

    expect(result).toBe("valid-response");

    const scenarioResult = ev.scoreScenario(
      "malformed_json_response",
      { detectedFault: true, recoveryPath: "repaired", errorClass: ErrorClass.AGENT_ERROR },
      Date.now() - start
    );

    expect(scenarioResult.passed).toBe(true);
    expect(scenarioResult.resilienceScore).toBeCloseTo(1.0);
  });
});

describe("Scenario flow — fatal_invariant_violation", () => {
  it("FATAL errors are not repaired — they escalate immediately", async () => {
    const injector = new FaultInjector();
    const ev = new RecoveryEvaluator();
    const start = Date.now();

    const faultedFn = injector.wrap("sandbox.exec", async () => "ok", {
      target: "sandbox.exec",
      type: "invariant_violation",
      trigger: { kind: "on_call_n", n: 1 },
    });

    ev.onFaultInjected("sandbox.exec", "invariant_violation");

    let repairAttempted = false;

    await withErrorInterception(faultedFn, {
      sourceLayer: "sandbox",
      onTaggedError: (tagged) => {
        ev.onFaultDetected("sandbox.exec", "invariant_violation", tagged.errorClass);
      },
      repairAgent: async () => {
        repairAttempted = true;
        return { success: true, escalate: false };
      },
    }).catch(() => {
      ev.onRecovery("escalated");
    });

    expect(repairAttempted).toBe(false);

    const scenarioResult = ev.scoreScenario(
      "fatal_invariant_violation",
      { detectedFault: true, recoveryPath: "escalated", errorClass: ErrorClass.FATAL },
      Date.now() - start
    );

    expect(scenarioResult.passed).toBe(true);
  });
});

describe("Scenario flow — circuit_breaker_trip", () => {
  it("circuit opens after 3 consecutive ENVIRONMENT_ERRORs", async () => {
    const injector = new FaultInjector();
    const cb = new CircuitBreaker(3, 60_000);
    const ev = new RecoveryEvaluator();

    const faultedFn = injector.wrap("fs.write", async () => "ok", {
      target: "fs.write",
      type: "enospc",
      trigger: { kind: "always" },
    });

    for (let i = 0; i < 3; i++) {
      ev.onFaultInjected("fs.write", "enospc");
      await withErrorInterception(faultedFn, {
        sourceLayer: "tool",
        circuitBreaker: cb,
        onTaggedError: (tagged) => {
          ev.onFaultDetected("fs.write", "enospc", tagged.errorClass);
        },
      }).catch(() => {
        ev.onRecovery("escalated");
      });
    }

    expect(cb.isOpen()).toBe(true);
    expect(cb.getConsecutiveFailures()).toBe(3);
  });
});

describe("BUILT_IN_SCENARIOS", () => {
  it("has exactly 10 scenarios", () => {
    expect(BUILT_IN_SCENARIOS.length).toBe(10);
  });

  it("all scenario IDs are unique", () => {
    const ids = BUILT_IN_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all scenarios have non-empty name and description", () => {
    for (const s of BUILT_IN_SCENARIOS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("all expected errorClass values match FAULT_TO_ERROR_CLASS", () => {
    for (const s of BUILT_IN_SCENARIOS) {
      if (s.expected.errorClass !== undefined) {
        expect(s.expected.errorClass).toBe(FAULT_TO_ERROR_CLASS[s.fault.type]);
      }
    }
  });

  it("all fault targets are valid FaultTarget values", () => {
    const validTargets = new Set([
      "openai.stream",
      "openai.single",
      "fs.read",
      "fs.write",
      "sandbox.exec",
      "tool.bash",
      "repair.llm",
      "network.fetch",
    ]);
    for (const s of BUILT_IN_SCENARIOS) {
      expect(validTargets.has(s.fault.target)).toBe(true);
    }
  });
});
