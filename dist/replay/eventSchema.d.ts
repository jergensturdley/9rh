export type EventType = "run_start" | "run_end" | "step_start" | "step_end" | "llm_request" | "llm_response" | "tool_call" | "tool_result" | "checkpoint" | "branch_create" | "compact" | "spec_plan" | "reasoning_plan" | "reasoning_summary";
export interface RunMetadata {
    runId: string;
    branchId: string;
    parentRunId?: string;
    parentStep?: number;
    branchReason?: string;
    model: string;
    modelParams: Record<string, unknown>;
    workDir: string;
    environmentVars: Record<string, string>;
    nodeVersion: string;
    packageVersions: Record<string, string>;
    timestamp: number;
}
export interface StepContext {
    stepIndex: number;
    iteration: number;
    compactCount: number;
}
export interface LLMRequestEvent {
    type: "llm_request";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        messages: unknown[];
        tools: unknown[];
        model: string;
        temperature: number;
        stream: boolean;
    };
}
export interface LLMResponseEvent {
    type: "llm_response";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        text: string;
        toolCalls: Array<{
            id: string;
            name: string;
            argsRaw: string;
        }> | null;
        finishReason: string;
    };
}
export interface ToolCallEvent {
    type: "tool_call";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        toolName: string;
        args: Record<string, unknown>;
        callId: string;
    };
}
export interface ToolResultEvent {
    type: "tool_result";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        toolName: string;
        callId: string;
        output: string;
        error?: string;
        durationMs: number;
    };
}
export interface CheckpointEvent {
    type: "checkpoint";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        snapshotId: string;
        workDirGitCommit?: string;
        workDirGitHash?: string;
        messageCount: number;
        reason: "periodic" | "pre_compact" | "pre_repair" | "manual";
    };
}
export interface BranchCreateEvent {
    type: "branch_create";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        newBranchId: string;
        parentRunId: string;
        parentStep: number;
        branchReason: string;
    };
}
export interface CompactEvent {
    type: "compact";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        messageCountBefore: number;
        messageCountAfter: number;
        summary: string;
    };
}
export interface SpecPlanEvent {
    type: "spec_plan";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        originalTask: string;
        summary: string;
    };
}
export interface ReasoningPlanEvent {
    type: "reasoning_plan";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        callId: string;
        goal: string;
        currentStep: string;
        assumptions: string[];
        chosenTool: string;
        expectedOutcome: string;
        alternativesConsidered: string[];
    };
}
export interface ReasoningSummaryEvent {
    type: "reasoning_summary";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        callId: string;
        expectedOutcome: string;
        observedOutcome: string;
        deviations: string[];
        nextAction: string;
        corrected: boolean;
    };
}
export type ReplayEvent = {
    type: "run_start";
    seq: number;
    ts: number;
    payload: RunMetadata;
} | {
    type: "run_end";
    seq: number;
    ts: number;
    payload: {
        runId: string;
        reason: string;
    };
} | {
    type: "step_start";
    seq: number;
    ts: number;
    step: StepContext;
    payload: Record<string, unknown>;
} | {
    type: "step_end";
    seq: number;
    ts: number;
    step: StepContext;
    payload: {
        stepIndex: number;
    };
} | LLMRequestEvent | LLMResponseEvent | ToolCallEvent | ToolResultEvent | CheckpointEvent | BranchCreateEvent | CompactEvent | SpecPlanEvent | ReasoningPlanEvent | ReasoningSummaryEvent;
export interface EventLog {
    version: 1;
    runId: string;
    branchId: string;
    metadata: RunMetadata;
    events: ReplayEvent[];
}
