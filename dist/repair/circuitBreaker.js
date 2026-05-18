import { ErrorClass as EC } from "./errorTaxonomy.js";
export var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (CircuitState = {}));
export class CircuitBreaker {
    state = CircuitState.CLOSED;
    consecutiveFailures = 0;
    lastFailureTime = 0;
    openedAt = 0;
    failureThreshold;
    resetTimeoutMs;
    constructor(failureThreshold = 3, resetTimeoutMs = 60_000) {
        this.failureThreshold = failureThreshold;
        this.resetTimeoutMs = resetTimeoutMs;
    }
    isOpen() {
        if (this.state === CircuitState.OPEN) {
            if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
                this.state = CircuitState.HALF_OPEN;
                return false;
            }
            return true;
        }
        return false;
    }
    recordFailure(errorClass) {
        if (errorClass === EC.FATAL || errorClass === EC.ENVIRONMENT_ERROR) {
            this.consecutiveFailures++;
            this.lastFailureTime = Date.now();
            if (this.consecutiveFailures >= this.failureThreshold) {
                this.state = CircuitState.OPEN;
                this.openedAt = Date.now();
            }
        }
    }
    recordSuccess() {
        this.consecutiveFailures = 0;
        this.state = CircuitState.CLOSED;
    }
    getState() {
        return this.state;
    }
    getConsecutiveFailures() {
        return this.consecutiveFailures;
    }
}
//# sourceMappingURL=circuitBreaker.js.map