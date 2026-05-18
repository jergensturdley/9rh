import type { ScenarioResult, ResilienceReport } from "./types.js";
import { MINIMUM_RESILIENCE_THRESHOLD } from "./types.js";

export function generateResilienceReport(
  runId: string,
  results: ScenarioResult[],
  threshold = MINIMUM_RESILIENCE_THRESHOLD
): ResilienceReport {
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  const overallScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.resilienceScore, 0) / results.length
      : 0;

  const criticalGaps = identifyCriticalGaps(failed);
  const recommendations = buildRecommendations(failed);

  return {
    runId,
    timestamp: Date.now(),
    totalScenarios: results.length,
    passedScenarios: passed.length,
    failedScenarios: failed.length,
    overallScore,
    minimumThreshold: threshold,
    passed: overallScore >= threshold && failed.length === 0,
    results,
    criticalGaps,
    recommendations,
  };
}

export function rankByRisk(report: ResilienceReport): ScenarioResult[] {
  return [...report.results].sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? 1 : -1;
    return a.resilienceScore - b.resilienceScore;
  });
}

export function formatReport(report: ResilienceReport): string {
  const status = report.passed ? "PASS" : "FAIL";
  const bar = buildScoreBar(report.overallScore);

  const lines: string[] = [
    `Resilience Report — ${report.runId}`,
    `${"─".repeat(50)}`,
    `Status : ${status}`,
    `Score  : ${bar} ${(report.overallScore * 100).toFixed(1)}% (threshold ${(report.minimumThreshold * 100).toFixed(0)}%)`,
    `Suites : ${report.passedScenarios}/${report.totalScenarios} passed`,
    "",
  ];

  if (report.failedScenarios > 0) {
    lines.push("Failed Scenarios:");
    for (const r of rankByRisk(report).filter((x) => !x.passed)) {
      lines.push(
        `  ✗ ${r.scenarioId.padEnd(32)} score=${(r.resilienceScore * 100).toFixed(1)}%  got=${r.actualRecoveryPath}  want=${r.expectedRecoveryPath}`
      );
    }
    lines.push("");
  }

  if (report.criticalGaps.length > 0) {
    lines.push("Critical Gaps:");
    for (const gap of report.criticalGaps) {
      lines.push(`  • ${gap}`);
    }
    lines.push("");
  }

  if (report.recommendations.length > 0) {
    lines.push("Recommendations:");
    for (const rec of report.recommendations) {
      lines.push(`  → ${rec}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildScoreBar(score: number): string {
  const filled = Math.round(score * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

function identifyCriticalGaps(failed: ScenarioResult[]): string[] {
  const gaps: string[] = [];

  const silentIgnores = failed.filter((r) => r.actualRecoveryPath === "silent_ignore");
  if (silentIgnores.length > 0) {
    gaps.push(
      `${silentIgnores.length} scenario(s) swallowed faults silently — errors went undetected`
    );
  }

  const corruptOutputs = failed.filter((r) => r.actualRecoveryPath === "corrupt_output");
  if (corruptOutputs.length > 0) {
    gaps.push(`${corruptOutputs.length} scenario(s) produced corrupt output under fault conditions`);
  }

  const noDetection = failed.filter((r) => r.detectionScore === 0);
  if (noDetection.length > 0) {
    gaps.push(`${noDetection.length} scenario(s) failed to detect injected faults at all`);
  }

  const wrongRecovery = failed.filter(
    (r) => r.actualRecoveryPath !== r.expectedRecoveryPath && r.detectionScore > 0
  );
  if (wrongRecovery.length > 0) {
    gaps.push(
      `${wrongRecovery.length} scenario(s) detected faults but took the wrong recovery path`
    );
  }

  return gaps;
}

function buildRecommendations(failed: ScenarioResult[]): string[] {
  const recs: string[] = [];

  const networkFailed = failed.filter((r) => r.scenarioId.includes("timeout") || r.scenarioId.includes("rate_limit") || r.scenarioId.includes("network"));
  if (networkFailed.length > 0) {
    recs.push("Add retry logic with exponential backoff for all OpenAI stream calls");
  }

  const fsFailed = failed.filter((r) => r.scenarioId.includes("disk") || r.scenarioId.includes("permission"));
  if (fsFailed.length > 0) {
    recs.push("Ensure filesystem errors surface to user with actionable messages, not stack traces");
  }

  const agentFailed = failed.filter((r) => r.scenarioId.includes("json") || r.scenarioId.includes("tool_args"));
  if (agentFailed.length > 0) {
    recs.push("Extend repair playbook to cover malformed JSON and invalid tool argument patterns");
  }

  const cbFailed = failed.filter((r) => r.scenarioId.includes("circuit"));
  if (cbFailed.length > 0) {
    recs.push("Tune circuit breaker thresholds — currently ignores RECOVERABLE error accumulation");
  }

  if (failed.length > 0 && recs.length === 0) {
    recs.push("Review repair playbook entries for failing scenarios and add auto-apply patterns");
  }

  return recs;
}
