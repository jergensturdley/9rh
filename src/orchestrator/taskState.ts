import type { RiskLevel } from "./roles.js";

export type TaskStatus =
  | "pending"
  | "architecting"
  | "implementing"
  | "reviewing"
  | "security_audit"
  | "test_strategy"
  | "completed"
  | "failed"
  | "escalated";

export interface ArchitectPlan {
  summary: string;
  steps: Array<{ id: string; action: string; files: string[]; risk: string }>;
  riskLevel: RiskLevel;
  requiresSecurityAudit: boolean;
  requiresTestStrategy: boolean;
  isTrivial: boolean;
  successCriteria: string[];
  clarifications?: string[];
}

export interface ImplementationResult {
  status: "completed" | "partial" | "failed";
  stepsCompleted: string[];
  stepsSkipped: Array<{ step: string; reason: string }>;
  filesModified: string[];
  testResults: "pass" | "fail" | "not_run";
  diff: string;
}

export interface ReviewResult {
  decision: "approved" | "rejected" | "needs_revision";
  verdict: string;
  issues: Array<{ severity: "blocker" | "warning" | "suggestion"; description: string; file?: string }>;
  requiredChanges: string[];
  justification: string;
}

export interface SecurityAuditResult {
  clearance: "approved" | "rejected" | "conditional";
  riskAssessment: RiskLevel;
  vulnerabilities: Array<{
    cve?: string;
    severity: "critical" | "high" | "medium" | "low";
    description: string;
    location: string;
    fix: string;
  }>;
  conditions: string[];
  justification: string;
}

export interface TestStrategyResult {
  verdict: "adequate" | "insufficient" | "requires_additions";
  testPlan: {
    unit: string[];
    integration: string[];
    e2e: string[];
    edgeCases: string[];
    failurePaths: string[];
  };
  coverageGaps: string[];
  requiredAdditions: string[];
  justification: string;
}

export interface ProjectMemory {
  workDir: string;
  model: string;
  taskHistory: Array<{ taskId: string; summary: string; status: TaskStatus; completedAt: number }>;
}

export interface TaskState {
  id: string;
  originalTask: string;
  status: TaskStatus;
  architectPlan?: ArchitectPlan;
  implementationResult?: ImplementationResult;
  reviewResult?: ReviewResult;
  securityAuditResult?: SecurityAuditResult;
  testStrategyResult?: TestStrategyResult;
  revisionCount: number;
  maxRevisions: number;
  escalationReason?: string;
  completedAt?: number;
  projectMemory: ProjectMemory;
}

export function createTaskState(id: string, task: string, projectMemory: ProjectMemory): TaskState {
  return {
    id,
    originalTask: task,
    status: "pending",
    revisionCount: 0,
    maxRevisions: 2,
    projectMemory,
  };
}

export function createProjectMemory(workDir: string, model: string): ProjectMemory {
  return { workDir, model, taskHistory: [] };
}

export function getArchitectContext(state: TaskState): Record<string, unknown> {
  return { task: state.originalTask };
}

export function getImplementerContext(state: TaskState): Record<string, unknown> {
  return { task: state.originalTask, plan: state.architectPlan };
}

export function getReviewerContext(state: TaskState): Record<string, unknown> {
  return {
    task: state.originalTask,
    plan: state.architectPlan,
    implementation: state.implementationResult,
    successCriteria: state.architectPlan?.successCriteria ?? [],
  };
}

export function getSecurityAuditContext(state: TaskState): Record<string, unknown> {
  return {
    task: state.originalTask,
    riskLevel: state.architectPlan?.riskLevel,
    filesModified: state.implementationResult?.filesModified ?? [],
    diff: state.implementationResult?.diff ?? "",
  };
}

export function getTestStrategyContext(state: TaskState): Record<string, unknown> {
  return {
    task: state.originalTask,
    plan: state.architectPlan,
    filesModified: state.implementationResult?.filesModified ?? [],
    testResults: state.implementationResult?.testResults,
  };
}

export function taskStateToContext(state: TaskState, role: string): string {
  const contextMap: Record<string, () => Record<string, unknown>> = {
    architect: () => getArchitectContext(state),
    implementer: () => getImplementerContext(state),
    reviewer: () => getReviewerContext(state),
    security_auditor: () => getSecurityAuditContext(state),
    test_strategist: () => getTestStrategyContext(state),
  };
  const fn = contextMap[role] ?? (() => ({ task: state.originalTask }));
  return JSON.stringify(fn(), null, 2);
}
