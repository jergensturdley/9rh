import type { ReplayEvent } from "./replay/eventSchema.js";
export interface AgentConfig {
    baseURL: string;
    apiKey: string;
    model: string;
    maxIterations: number;
    workDir: string;
    systemPrompt?: string;
    onEvent?: (event: AgentEvent) => void;
    compactAfter?: number;
    replay?: ReplayConfig;
    specDrivenTesting?: boolean;
    continuationPolicy?: ContinuationPolicy;
}
export interface ContinuationPolicy {
    maxContinuations: number;
    iterationsPerContinuation?: number;
    modelSwitch?: ContinuationModelSwitch;
}
export interface ContinuationModelSwitch {
    toModel: string;
    afterContinuations?: number;
}
export interface ReplayConfig {
    enabled: boolean;
    runId?: string;
    branchId?: string;
    logDir?: string;
    checkpointDir?: string;
    onReplayEvent?: (event: ReplayEvent) => void;
}
export type AgentEvent = {
    type: "thinking";
    text: string;
} | {
    type: "tool_call";
    name: string;
    args: Record<string, unknown>;
} | {
    type: "tool_result";
    name: string;
    output: string;
    error?: string;
} | {
    type: "done";
    text: string;
} | {
    type: "error";
    message: string;
} | {
    type: "iteration";
    current: number;
    max: number;
} | {
    type: "compact";
    summary: string;
} | {
    type: "continuation";
    count: number;
    max: number;
} | {
    type: "model_switch";
    from: string;
    to: string;
    reason: "continuation";
} | {
    type: "repair_start";
    message: string;
    attempt: number;
} | {
    type: "repair_success";
    message: string;
} | {
    type: "escalate";
    message: string;
} | {
    type: "circuit_open";
} | {
    type: "replay_event";
    event: ReplayEvent;
} | {
    type: "spec_plan";
    summary: string;
} | {
    type: "sandbox_health";
    total: number;
    sandboxed: number;
    direct: number;
    timedOut: number;
};
export declare class Agent {
    private client;
    private config;
    private messages;
    private compactThreshold;
    private circuitBreaker;
    private currentTask;
    private stepIndex;
    private compactCount;
    private replay;
    private eventLogger;
    private reasoner;
    private executor;
    private observer;
    private activeModel;
    constructor(config: AgentConfig);
    private emit;
    private currentModel;
    private shouldCompact;
    private compactContext;
    private resetForContinuation;
    private applyContinuationModelSwitch;
    private buildAgentState;
    private stepContext;
    private initReplay;
    private logReplay;
    private finalizeReplay;
    private runRepair;
    private executeToolWithRepair;
    run(task: string): Promise<string>;
    private streamCompletionWithReplay;
}
