import type { ErrorClass } from "../repair/errorTaxonomy.js";
import {
  type FaultTarget,
  type FaultType,
  type RecoveryPath,
  type ObservedErrorEvent,
  type ExpectedOutcome,
  type ScenarioResult,
  type ResilienceScores,
  FAULT_TO_ERROR_CLASS,
  RECOVERY_SCORES,
} from "./types.js";

export class RecoveryEvaluator {
  private injectedCount = 0;
  private detectedCount = 0;
  private classifiedCorrectlyCount = 0;
  private recoveryScoresObserved: number[] = [];
  private errorEvents: ObservedErrorEvent[] = [];
  private lastRecoveryPath: RecoveryPath = "none";

  onFaultInjected(target: FaultTarget, faultType: FaultType): void {
    this.injectedCount++;
    this.errorEvents.push({
      timestamp: Date.now(),
      target,
      faultType,
      detected: false,
      recoveryPath: "none",
    });
  }

  onFaultDetected(target: FaultTarget, faultType: FaultType, errorClass: ErrorClass): void {
    this.detectedCount++;
    const expectedClass = FAULT_TO_ERROR_CLASS[faultType];
    if (errorClass === expectedClass) {
      this.classifiedCorrectlyCount++;
    }

    let pending: ObservedErrorEvent | undefined = undefined;
    for (let i = this.errorEvents.length - 1; i >= 0; i--) {
      const e = this.errorEvents[i];
      if (e.target === target && !e.detected) {
        pending = e;
        break;
      }
    }

    if (pending) {
      pending.detected = true;
      pending.errorClass = errorClass;
    } else {
      this.errorEvents.push({
        timestamp: Date.now(),
        target,
        faultType,
        detected: true,
        errorClass,
        recoveryPath: "none",
      });
    }
  }

  onRecovery(path: RecoveryPath): void {
    this.lastRecoveryPath = path;
    this.recoveryScoresObserved.push(RECOVERY_SCORES[path]);

    for (let i = this.errorEvents.length - 1; i >= 0; i--) {
      const e = this.errorEvents[i];
      if (e.recoveryPath === "none") {
        e.recoveryPath = path;
        break;
      }
    }
  }

  computeResilienceScore(): ResilienceScores {
    const detectionRate =
      this.injectedCount > 0
        ? Math.min(1.0, this.detectedCount / this.injectedCount)
        : 0;
    const classificationRate =
      this.detectedCount > 0 ? this.classifiedCorrectlyCount / this.detectedCount : 0;
    const avgRecovery =
      this.recoveryScoresObserved.length > 0
        ? this.recoveryScoresObserved.reduce((a, b) => a + b, 0) /
          this.recoveryScoresObserved.length
        : 0;

    const detection = 0.25 * detectionRate;
    const classification = 0.25 * classificationRate;
    const recovery = 0.5 * Math.max(0, avgRecovery);
    const total = detection + classification + recovery;

    return { total, detection, classification, recovery };
  }

  scoreScenario(scenarioId: string, expected: ExpectedOutcome, durationMs: number): ScenarioResult {
    const scores = this.computeResilienceScore();
    const actualRecoveryPath = this.lastRecoveryPath;
    const recoveryMatches = actualRecoveryPath === expected.recoveryPath;
    const detectionMatches = this.detectedCount > 0 === expected.detectedFault;

    const passed =
      scores.total >= 0.8 &&
      detectionMatches &&
      recoveryMatches;

    return {
      scenarioId,
      passed,
      resilienceScore: scores.total,
      actualRecoveryPath,
      expectedRecoveryPath: expected.recoveryPath,
      detectionScore: scores.detection,
      classificationScore: scores.classification,
      recoveryScore: scores.recovery,
      errorEvents: [...this.errorEvents],
      durationMs,
    };
  }

  reset(): void {
    this.injectedCount = 0;
    this.detectedCount = 0;
    this.classifiedCorrectlyCount = 0;
    this.recoveryScoresObserved = [];
    this.errorEvents = [];
    this.lastRecoveryPath = "none";
  }
}
