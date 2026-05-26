import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { Agent } from "../agent.js";
import type { AgentConfig, AgentEvent } from "../agent.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    baseURL: "http://localhost:20128/v1",
    apiKey: "test",
    model: "test-model",
    maxIterations: 2,
    workDir: process.cwd(),
    replay: { enabled: false },
    specDrivenTesting: false,
    ...overrides,
  };
}

type AgentPrivate = {
  streamCompletionWithReplay(): Promise<StreamResult>;
  compactContext(): Promise<string>;
  executeToolWithRepair(name: string, args: Record<string, unknown>, callId: string): Promise<{ output: string; error?: string }>;
};
type StreamResult = { text: string; toolCalls: Array<{ id: string; name: string; argsRaw: string }> | null };

function spyStream(agent: Agent, responses: StreamResult[]): void {
  let call = 0;
  jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay")
    .mockImplementation(async () => responses[Math.min(call++, responses.length - 1)]);
}

const DONE: StreamResult = { text: "finished", toolCalls: null };
const TOOL_CALL: StreamResult = {
  text: "",
  toolCalls: [{ id: "c1", name: "run_bash", argsRaw: '{"command":"echo hi"}' }],
};

// Helper to create an AbortError from the DOMException constructor or a plain Error
function createAbortError(message: string): Error {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
  }
}

describe("Agent graceful exit", () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  describe("abort()", () => {
    it("returns gracefully instead of throwing on abort", async () => {
      const events: AgentEvent[] = [];
      const agent = new Agent(
        makeConfig({
          maxIterations: 5,
          onEvent: (e) => events.push(e),
        }),
      );
      spyStream(agent, [TOOL_CALL, DONE]);

      // Abort after the first stream call resolves
      const originalStream = (agent as unknown as AgentPrivate).streamCompletionWithReplay.bind(agent);
      let callCount = 0;
      jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay").mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // After first call, abort the agent
          agent.abort();
          throw createAbortError("Interrupted by user");
        }
        return originalStream();
      });

      // run() should handle abort gracefully — returning a string, not throwing
      const result = await agent.run("test task");

      // Should return a string, not throw
      expect(typeof result).toBe("string");

      // Should emit error and done events
      const errorEvents = events.filter((e) => e.type === "error");
      const doneEvents = events.filter((e) => e.type === "done");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("requestStop()", () => {
    it("stops gracefully after current iteration when requestStop is called", async () => {
      const events: AgentEvent[] = [];
      const agent = new Agent(
        makeConfig({
          maxIterations: 5,
          onEvent: (e) => events.push(e),
        }),
      );

      let callCount = 0;
      jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay").mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return TOOL_CALL;
        }
        // After the first tool call returns, request stop
        agent.requestStop();
        return DONE;
      });

      jest.spyOn(agent as unknown as AgentPrivate, "executeToolWithRepair")
        .mockResolvedValue({ output: "tool result" });

      const result = await agent.run("test task");

      // Should return a string (either "finished" or "Stopped by user request")
      expect(typeof result).toBe("string");

      // Should have a done event
      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents.length).toBe(1);
    });
  });

  describe("timeout", () => {
    it("handles abort gracefully (timeout triggers abort internally)", async () => {
      const events: AgentEvent[] = [];
      const agent = new Agent(
        makeConfig({
          maxIterations: 5,
          onEvent: (e) => events.push(e),
        }),
      );

      // Simulate abort triggered by timeout: call abort() with a timeout reason
      jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay").mockImplementation(async () => {
        // Simulate what happens when the timeout fires: abort with a message
        agent.abort();
        throw createAbortError("Interrupted by user");
      });

      const result = await agent.run("test task");

      // Should return a string, not throw
      expect(typeof result).toBe("string");

      // Should have error and done events
      const errorEvents = events.filter((e) => e.type === "error");
      const doneEvents = events.filter((e) => e.type === "done");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("clears timeout timer on successful completion", async () => {
      jest.useFakeTimers();
      const agent = new Agent(
        makeConfig({
          maxIterations: 2,
          timeoutMs: 5000,
        }),
      );
      spyStream(agent, [DONE]);

      const result = await agent.run("test task");
      expect(result).toBe("finished");

      // Advance timers to confirm no lingering timeout
      jest.advanceTimersByTime(10000);

      // No errors should be thrown by the lingering timer
      jest.useRealTimers();
    });
  });

  describe("error handling", () => {
    it("emits error event and finalizes replay before re-throwing on stream error", async () => {
      const events: AgentEvent[] = [];
      const agent = new Agent(
        makeConfig({
          maxIterations: 2,
          onEvent: (e) => events.push(e),
        }),
      );

      // Make the stream throw a non-retryable error
      jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay").mockImplementation(async () => {
        throw new Error("Provider function not found 404");
      });

      await expect(agent.run("test task")).rejects.toThrow();

      // Should have emitted an error event
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("handles stream errors without abort cleanly — returns error via catch block", async () => {
      const events: AgentEvent[] = [];
      const agent = new Agent(
        makeConfig({
          maxIterations: 2,
          onEvent: (e) => events.push(e),
        }),
      );

      jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay").mockImplementation(async () => {
        throw new Error("Some API error");
      });

      await expect(agent.run("test task")).rejects.toThrow("Some API error");

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("finalizeReplay guard", () => {
    it("does not call finalizeReplay twice on success", async () => {
      const agent = new Agent(makeConfig({ maxIterations: 2 }));
      spyStream(agent, [DONE]);

      // Access private method
      const finalizeSpy = jest.spyOn(agent as unknown as AgentPrivate & { finalizeReplay(reason: string): Promise<void> }, "finalizeReplay");

      await agent.run("test task");

      // finalizeReplay should be called exactly once
      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      expect(finalizeSpy).toHaveBeenCalledWith("completed");
    });

    it("returns gracefully on abort without throwing", async () => {
      const events: AgentEvent[] = [];
      const agent = new Agent(
        makeConfig({
          maxIterations: 5,
          onEvent: (e) => events.push(e),
        }),
      );

      // Make the stream throw an AbortError on the first call
      jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay").mockImplementation(async () => {
        agent.abort();
        throw createAbortError("Interrupted by user");
      });

      // Should NOT throw — abort is handled gracefully
      const result = await agent.run("test task");
      expect(typeof result).toBe("string");

      // Should have emitted error and done events
      const errorEvents = events.filter((e) => e.type === "error");
      const doneEvents = events.filter((e) => e.type === "done");
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});