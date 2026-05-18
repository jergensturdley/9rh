import type { ReplayEvent } from "./eventSchema.js";
import type { DivergenceReport } from "./divergenceDetector.js";
export interface ReplayOptions {
    eventLogPath: string;
    workDir: string;
    fromStep?: number;
    stopOnDivergence?: boolean;
    onEvent?: (event: ReplayEvent) => void;
    onDivergence?: (report: DivergenceReport) => void;
    llmProvider?: LLMProvider;
}
export interface LLMProvider {
    complete(messages: unknown, model: string, params: unknown): Promise<{
        text: string;
        toolCalls: Array<{
            id: string;
            name: string;
            argsRaw: string;
        }> | null;
        finishReason: string;
    }>;
}
export declare class ReplayEngine {
    private options;
    private events;
    private eventIndex;
    private stepIndex;
    private diverged;
    private recordedOutputs;
    constructor(options: ReplayOptions);
    load(): Promise<void>;
    replay(): Promise<{
        eventCount: number;
        divergenceReport: DivergenceReport | null;
    }>;
    isDiverged(): boolean;
    getEventAt(index: number): ReplayEvent | undefined;
    getEventCount(): number;
}
