import { ErrorClass } from "../repair/errorTaxonomy.js";

export type FaultTarget =
  | "openai.stream"
  | "openai.single"
  | "fs.read"
  | "fs.write"
  | "sandbox.exec"
  | "tool.bash"
  | "repair.llm"
  | "network.fetch";

export type FaultType =
  | "timeout"
  | "rate_limit"
  | "network_reset"
  | "premature_close"
  | "malformed_json"
  | "invalid_tool_args"
  | "enospc"
  | "eacces"
  | "sandbox_crash"
  | "missing_env_var"
  | "invariant_violation"
  | "circuit_breaker_open";

export type TriggerCondition =
  | { kind: "always" }
  | { kind: "on_call_n"; n: number }
  | { kind: "after_call_n"; n: number }
  | { kind: "first_n_calls"; n: number }
  | { kind: "probabilistic"; p: number };

export type RecoveryPath =
  | "retried"
  | "repaired"
  | "escalated"
  | "degraded_gracefully"
  | "silent_ignore"
  | "corrupt_output"
  | "none";

export interface FaultSpec {
  target: FaultTarget;
  type: FaultType;
  trigger: TriggerCondition;
  message?: string;
}

export interface ExpectedOutcome {
  detectedFault: boolean;
  recoveryPath: RecoveryPath;
  errorClass?: ErrorClass;
  maxRetries?: number;
}

export interface FaultScenario {
  id: string;
  name: string;
  description: string;
  category: "network" | "filesystem" | "agent" | "system" | "circuit_breaker";
  severity: "low" | "medium" | "high" | "critical";
  fault: FaultSpec;
  expected: ExpectedOutcome;
  tags?: string[];
}

export interface ObservedErrorEvent {
  timestamp: number;
  target: FaultTarget;
  faultType: FaultType;
  detected: boolean;
  errorClass?: ErrorClass;
  recoveryPath: RecoveryPath;
}

export interface ResilienceScores {
  total: number;
  detection: number;
  classification: number;
  recovery: number;
}

export interface ScenarioResult {
  scenarioId: string;
  passed: boolean;
  resilienceScore: number;
  actualRecoveryPath: RecoveryPath;
  expectedRecoveryPath: RecoveryPath;
  detectionScore: number;
  classificationScore: number;
  recoveryScore: number;
  errorEvents: ObservedErrorEvent[];
  durationMs: number;
}

export interface ResilienceReport {
  runId: string;
  timestamp: number;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  overallScore: number;
  minimumThreshold: number;
  passed: boolean;
  results: ScenarioResult[];
  criticalGaps: string[];
  recommendations: string[];
}

export const FAULT_TO_ERROR_CLASS: Record<FaultType, ErrorClass> = {
  timeout: ErrorClass.RECOVERABLE,
  rate_limit: ErrorClass.RECOVERABLE,
  network_reset: ErrorClass.RECOVERABLE,
  premature_close: ErrorClass.RECOVERABLE,
  circuit_breaker_open: ErrorClass.RECOVERABLE,
  malformed_json: ErrorClass.AGENT_ERROR,
  invalid_tool_args: ErrorClass.AGENT_ERROR,
  enospc: ErrorClass.ENVIRONMENT_ERROR,
  eacces: ErrorClass.ENVIRONMENT_ERROR,
  sandbox_crash: ErrorClass.ENVIRONMENT_ERROR,
  missing_env_var: ErrorClass.ENVIRONMENT_ERROR,
  invariant_violation: ErrorClass.FATAL,
} as const;

export const RECOVERY_SCORES: Record<RecoveryPath, number> = {
  retried: 1.0,
  repaired: 1.0,
  escalated: 0.8,
  degraded_gracefully: 0.6,
  silent_ignore: 0.0,
  corrupt_output: -0.5,
  none: 0.0,
} as const;

export const MINIMUM_RESILIENCE_THRESHOLD = 0.8;
