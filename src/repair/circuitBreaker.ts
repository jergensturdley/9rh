import type { ErrorClass } from "./errorTaxonomy.js";
import { ErrorClass as EC } from "./errorTaxonomy.js";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(failureThreshold = 3, resetTimeoutMs = 60_000) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  isOpen(): boolean {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        return false;
      }
      return true;
    }
    return false;
  }

  recordFailure(errorClass: ErrorClass): void {
    if (errorClass === EC.FATAL || errorClass === EC.ENVIRONMENT_ERROR) {
      this.consecutiveFailures++;
      this.lastFailureTime = Date.now();
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
        this.openedAt = Date.now();
      }
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = CircuitState.CLOSED;
  }

  getState(): CircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
