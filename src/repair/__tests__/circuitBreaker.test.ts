import { describe, it, expect } from "@jest/globals";
import { CircuitBreaker, CircuitState } from "../circuitBreaker.js";
import { ErrorClass } from "../errorTaxonomy.js";

describe("CircuitBreaker", () => {
  it("starts in CLOSED state", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.isOpen()).toBe(false);
  });

  it("opens after failureThreshold consecutive ENVIRONMENT_ERRORs", () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) {
      cb.recordFailure(ErrorClass.ENVIRONMENT_ERROR);
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.isOpen()).toBe(true);
  });

  it("opens after 1 FATAL error when threshold is 1", () => {
    const cb = new CircuitBreaker(1, 60_000);
    cb.recordFailure(ErrorClass.FATAL);
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.isOpen()).toBe(true);
  });

  it("does NOT open for RECOVERABLE errors", () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 10; i++) {
      cb.recordFailure(ErrorClass.RECOVERABLE);
    }
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.isOpen()).toBe(false);
  });

  it("does NOT open for AGENT_ERROR alone", () => {
    const cb = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) {
      cb.recordFailure(ErrorClass.AGENT_ERROR);
    }
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("resets consecutive failures on recordSuccess", () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordFailure(ErrorClass.ENVIRONMENT_ERROR);
    cb.recordFailure(ErrorClass.ENVIRONMENT_ERROR);
    cb.recordSuccess();
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("transitions to HALF_OPEN after reset timeout", async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure(ErrorClass.FATAL);
    expect(cb.isOpen()).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
  });
});
