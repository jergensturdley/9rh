import type { ToolResultEvent, LLMResponseEvent } from "./eventSchema.js";
export interface Divergence {
    seq: number;
    eventType: string;
    step: number;
    field: string;
    expected: string;
    actual: string;
    severity: "minor" | "major" | "critical";
}
export interface DivergenceReport {
    runId: string;
    branchId: string;
    divergedAt: Divergence;
    totalEventsCompared: number;
    eventsBeforeDivergence: number;
}
export declare function detectToolDivergence(recorded: ToolResultEvent, replayed: ToolResultEvent): Divergence[];
export declare function detectLLMDivergence(recorded: LLMResponseEvent, replayed: LLMResponseEvent): Divergence[];
export declare function compareEventLogs(recordedEvents: (ToolResultEvent | LLMResponseEvent)[], replayedEvents: (ToolResultEvent | LLMResponseEvent)[]): DivergenceReport | null;
