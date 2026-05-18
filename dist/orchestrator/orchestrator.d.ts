import { type RoleName } from "./roles.js";
import { type TaskState, type ArchitectPlan, type ImplementationResult, type ReviewResult, type SecurityAuditResult, type TestStrategyResult } from "./taskState.js";
import { type ConflictLog, type ConflictResolution } from "./conflictResolver.js";
export type OrchestratorEvent = {
    type: "role_start";
    role: RoleName;
    taskId: string;
} | {
    type: "role_complete";
    role: RoleName;
    taskId: string;
    result: string;
} | {
    type: "role_skip";
    role: RoleName;
    taskId: string;
    reason: string;
} | {
    type: "conflict";
    taskId: string;
    parties: [string, string];
    resolution: ConflictResolution;
} | {
    type: "cache_hit";
    role: RoleName;
    taskId: string;
} | {
    type: "escalation";
    taskId: string;
    reason: string;
} | {
    type: "task_complete";
    taskId: string;
    status: string;
} | {
    type: "task_failed";
    taskId: string;
    error: string;
};
export type RoleInvoker = (role: RoleName, prompt: string) => Promise<string>;
export interface OrchestratorConfig {
    baseURL: string;
    apiKey: string;
    model: string;
    workDir: string;
    maxRevisions?: number;
    onEvent?: (event: OrchestratorEvent) => void;
    roleInvoker?: RoleInvoker;
}
export interface OrchestratorResult {
    taskId: string;
    status: TaskState["status"];
    summary: string;
    architectPlan?: ArchitectPlan;
    implementationResult?: ImplementationResult;
    reviewResult?: ReviewResult;
    securityAuditResult?: SecurityAuditResult;
    testStrategyResult?: TestStrategyResult;
    escalationReason?: string;
    conflictLog: ConflictLog;
}
export declare class Orchestrator {
    private config;
    private cache;
    private projectMemory;
    private invokeRole;
    constructor(config: OrchestratorConfig);
    private emit;
    private runArchitect;
    private runImplementer;
    private runReviewer;
    private runSecurityAuditor;
    private runTestStrategist;
    private buildResult;
    orchestrate(task: string): Promise<OrchestratorResult>;
    cacheStats(): {
        planCacheSize: number;
        testStrategyCacheSize: number;
        totalHits: number;
    };
}
