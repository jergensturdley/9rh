import type { FaultTarget, FaultType, FaultSpec, TriggerCondition } from "./types.js";

const FAULT_MESSAGES: Record<FaultType, string> = {
  timeout: "API request timeout after 30000ms",
  rate_limit: "rate limit exceeded: retry after 60s",
  network_reset: "ECONNRESET: network connection reset by peer",
  premature_close: "premature close: other side closed connection",
  circuit_breaker_open: "circuit breaker is open — halting requests",
  malformed_json: "malformed json: unexpected token at position 42",
  invalid_tool_args: "invalid tool arguments: missing required field 'path'",
  enospc: "ENOSPC: no space left on device, write",
  eacces: "EACCES: permission denied, open '/etc/passwd'",
  sandbox_crash: "sandbox process exited with code 1 (SIGSEGV)",
  missing_env_var: "missing environment variable: OPENAI_API_KEY",
  invariant_violation: "Fatal: invariant violation in core loop — unexpected null",
};

export class FaultInjector {
  private callCounts = new Map<string, number>();
  private activeSpecs: FaultSpec[] = [];

  register(spec: FaultSpec): void {
    this.activeSpecs.push(spec);
  }

  reset(target?: FaultTarget): void {
    if (target === undefined) {
      this.callCounts.clear();
      this.activeSpecs = [];
    } else {
      for (const key of this.callCounts.keys()) {
        if (key.startsWith(target)) this.callCounts.delete(key);
      }
      this.activeSpecs = this.activeSpecs.filter((s) => s.target !== target);
    }
  }

  wrap<T>(target: FaultTarget, fn: () => Promise<T>, spec?: FaultSpec): () => Promise<T> {
    const effectiveSpecs = spec ? [spec] : this.activeSpecs.filter((s) => s.target === target);

    return async (): Promise<T> => {
      const key = target;
      const prev = this.callCounts.get(key) ?? 0;
      const callCount = prev + 1;
      this.callCounts.set(key, callCount);

      for (const s of effectiveSpecs) {
        if (this.shouldFire(s.trigger, callCount)) {
          throw this.createFault(s.type, s.message);
        }
      }

      return fn();
    };
  }

  getCallCount(target: FaultTarget): number {
    return this.callCounts.get(target) ?? 0;
  }

  private shouldFire(trigger: TriggerCondition, callCount: number): boolean {
    switch (trigger.kind) {
      case "always":
        return true;
      case "on_call_n":
        return callCount === trigger.n;
      case "after_call_n":
        return callCount > trigger.n;
      case "first_n_calls":
        return callCount <= trigger.n;
      case "probabilistic":
        return Math.random() < trigger.p;
      default:
        return false;
    }
  }

  private createFault(type: FaultType, message?: string): Error {
    return new Error(message ?? FAULT_MESSAGES[type]);
  }
}
