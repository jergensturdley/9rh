import type { ReplayEvent, ReasoningSummaryEvent } from "../replay/eventSchema.js";
export interface ReasonerConfig {
    /** Emit reasoning_plan before each tool call */
    emitPlans?: boolean;
    /** Emit reasoning_summary after each tool result */
    emitSummaries?: boolean;
    /** Called when a plan or summary event is ready */
    onReasoningEvent?: (event: ReplayEvent) => void;
    /** Called when observed outcome does not match expected */
    onDivergence?: (summary: ReasoningSummaryEvent) => void;
}
/**
 * Reasoner wraps agent tool execution and emits structured pre-action
 * (reasoning_plan) and post-action (reasoning_summary) events around each
 * tool call, enabling an inspectable reasoning trace.
 *
 * Usage:
 *   const reasoner = new Reasoner({ emitPlans: true, emitSummaries: true });
 *   reasoner.onReasoningEvent = (event) => eventLogger.log(event);
 *   // Before each tool call:
 *   reasoner.plan(callId, toolName, args, goal, currentStep, assumptions, expectedOutcome);
 *   // After each tool result:
 *   reasoner.summarize(callId, observedOutcome, nextAction, corrected);
 */
export declare class Reasoner {
    private config;
    private activeContexts;
    constructor(config?: ReasonerConfig);
    /**
     * Emit a reasoning_plan event before executing a tool.
     * Call this immediately before executeTool().
     *
     * @param callId - Unique identifier for this tool call (from LLM tool_call.id)
     * @param toolName - Name of the tool being called
     * @param args - Arguments being passed to the tool
     * @param goal - What the agent is trying to accomplish overall
     * @param currentStep - What specific step within the goal this tool addresses
     * @param assumptions - What the agent believes to be true before executing
     * @param expectedOutcome - What the agent expects to happen
     * @param stepContext - Current step context (stepIndex, iteration, compactCount)
     */
    plan(params: {
        callId: string;
        toolName: string;
        args: Record<string, unknown>;
        goal: string;
        currentStep: string;
        assumptions: string[];
        expectedOutcome: string;
        stepContext: {
            stepIndex: number;
            iteration: number;
            compactCount: number;
        };
        alternativesConsidered?: string[];
    }): void;
    /**
     * Emit a reasoning_summary event after a tool result is available.
     * Call this immediately after receiving the tool result.
     *
     * @param callId - Must match the callId from the corresponding plan()
     * @param observedOutcome - What actually happened (result output or error)
     * @param nextAction - What the agent will do next given the result
     * @param corrected - Whether a correction step was triggered due to mismatch
     * @param stepContext - Current step context (stepIndex, iteration, compactCount)
     */
    summarize(params: {
        callId: string;
        observedOutcome: string;
        nextAction: string;
        corrected: boolean;
        stepContext: {
            stepIndex: number;
            iteration: number;
            compactCount: number;
        };
    }): void;
    /**
     * Check if there is an active plan for the given callId.
     */
    hasActivePlan(callId: string): boolean;
    /**
     * Clear all active contexts (e.g., on agent reset or run end).
     */
    reset(): void;
}
