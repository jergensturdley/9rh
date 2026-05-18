import { type SourceLayer, type TaggedError, ErrorClass } from "./errorTaxonomy.js";
export interface InterceptionOptions {
    sourceLayer: SourceLayer;
    onTaggedError?: (tagged: TaggedError) => void;
    onRepairTriggered?: (tagged: TaggedError, attempt: number) => Promise<void>;
    repairAgent?: (tagged: TaggedError, attempt: number) => Promise<RepairResult>;
    circuitBreaker?: CircuitBreakerRef;
}
export interface RepairResult {
    success: boolean;
    snapshotId?: string;
    userMessage?: string;
    escalate: boolean;
}
interface CircuitBreakerRef {
    isOpen: () => boolean;
    recordFailure: (errorClass: ErrorClass) => void;
    recordSuccess: () => void;
}
export declare function withErrorInterception<T>(fn: () => Promise<T>, opts: InterceptionOptions): Promise<T>;
export {};
