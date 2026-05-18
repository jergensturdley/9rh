import type { RiskLevel } from "./roles.js";
export type TaskStatus = "pending" | "architecting" | "implementing" | "reviewing" | "security_audit" | "test_strategy" | "completed" | "failed" | "escalated";
export interface ArchitectPlan {
    summary: string;
    steps: Array<{
        id: string;
        action: string;
        files: string[];
        risk: string;
    }>;
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
    stepsSkipped: Array<{
        step: string;
        reason: string;
    }>;
    filesModified: string[];
    testResults: "pass" | "fail" | "not_run";
    diff: string;
}
export interface ReviewResult {
    decision: "approved" | "rejected" | "needs_revision";
    verdict: string;
    issues: Array<{
        severity: "blocker" | "warning" | "suggestion";
        description: string;
        file?: string;
    }>;
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
    taskHistory: Array<{
        taskId: string;
        summary: string;
        status: TaskStatus;
        completedAt: number;
    }>;
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
export declare function createTaskState(id: string, task: string, projectMemory: ProjectMemory): TaskState;
export declare function createProjectMemory(workDir: string, model: string): ProjectMemory;
export declare function getArchitectContext(state: TaskState): Record<string, unknown>;
export declare function getImplementerContext(state: TaskState): Record<string, unknown>;
export declare function getReviewerContext(state: TaskState): Record<string, unknown>;
export declare function getSecurityAuditContext(state: TaskState): Record<string, unknown>;
export declare function getTestStrategyContext(state: TaskState): Record<string, unknown>;
export declare function taskStateToContext(state: TaskState, role: string): string;
