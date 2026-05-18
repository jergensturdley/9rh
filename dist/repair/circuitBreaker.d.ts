import type { ErrorClass } from "./errorTaxonomy.js";
export declare enum CircuitState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN"
}
export declare class CircuitBreaker {
    private state;
    private consecutiveFailures;
    private lastFailureTime;
    private openedAt;
    private readonly failureThreshold;
    private readonly resetTimeoutMs;
    constructor(failureThreshold?: number, resetTimeoutMs?: number);
    isOpen(): boolean;
    recordFailure(errorClass: ErrorClass): void;
    recordSuccess(): void;
    getState(): CircuitState;
    getConsecutiveFailures(): number;
}
