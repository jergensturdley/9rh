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
export class Reasoner {
    config;
    activeContexts = new Map();
    constructor(config = {}) {
        this.config = {
            emitPlans: config.emitPlans ?? true,
            emitSummaries: config.emitSummaries ?? true,
            onReasoningEvent: config.onReasoningEvent,
            onDivergence: config.onDivergence,
        };
    }
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
    plan(params) {
        if (!this.config.emitPlans)
            return;
        const event = {
            type: "reasoning_plan",
            step: params.stepContext,
            payload: {
                callId: params.callId,
                goal: params.goal,
                currentStep: params.currentStep,
                assumptions: params.assumptions,
                chosenTool: params.toolName,
                expectedOutcome: params.expectedOutcome,
                alternativesConsidered: params.alternativesConsidered ?? [],
            },
        };
        this.activeContexts.set(params.callId, {
            callId: params.callId,
            toolName: params.toolName,
            args: params.args,
            expectedOutcome: params.expectedOutcome,
            plannedAt: Date.now(),
        });
        this.config.onReasoningEvent?.(event);
    }
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
    summarize(params) {
        if (!this.config.emitSummaries)
            return;
        const ctx = this.activeContexts.get(params.callId);
        const expectedOutcome = ctx?.expectedOutcome ?? "<no-plan>";
        // Detect deviations between expected and observed
        const deviations = [];
        if (!params.observedOutcome.includes(expectedOutcome.slice(0, 20)) && params.observedOutcome !== expectedOutcome) {
            deviations.push(`Expected output to contain: "${expectedOutcome.slice(0, 50)}" but got: "${params.observedOutcome.slice(0, 50)}"`);
        }
        if (params.corrected) {
            deviations.push("Correction step triggered — agent deviated from expected plan");
        }
        const event = {
            type: "reasoning_summary",
            step: params.stepContext,
            payload: {
                callId: params.callId,
                expectedOutcome,
                observedOutcome: params.observedOutcome.slice(0, 500),
                deviations,
                nextAction: params.nextAction,
                corrected: params.corrected,
            },
        };
        this.activeContexts.delete(params.callId);
        const summaryEvent = event;
        this.config.onReasoningEvent?.(summaryEvent);
        if (deviations.length > 0 || params.corrected) {
            this.config.onDivergence?.(summaryEvent);
        }
    }
    /**
     * Check if there is an active plan for the given callId.
     */
    hasActivePlan(callId) {
        return this.activeContexts.has(callId);
    }
    /**
     * Clear all active contexts (e.g., on agent reset or run end).
     */
    reset() {
        this.activeContexts.clear();
    }
}
//# sourceMappingURL=reasoner.js.map