import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { Agent } from "../agent.js";
import type { AgentConfig, AgentEvent, ContinuationPolicy } from "../agent.js";

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

type AgentPrivate = { streamCompletionWithReplay(): Promise<StreamResult>; compactContext(): Promise<string> };
type StreamResult = { text: string; toolCalls: Array<{ id: string; name: string; argsRaw: string }> | null };
type AgentWithRuntime = AgentPrivate & { activeModel?: string; config: AgentConfig };
type AgentWithClient = AgentPrivate & { client: { chat: { completions: { create: () => Promise<AsyncIterable<unknown>> } } } };
type AgentWithMessages = AgentPrivate & { messages: Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }> };

function spyCompact(agent: Agent): void {
  jest.spyOn(agent as unknown as AgentPrivate, "compactContext").mockResolvedValue("summary");
}

function spyStream(agent: Agent, responses: StreamResult[]): void {
  let call = 0;
  jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay")
    .mockImplementation(async () => responses[Math.min(call++, responses.length - 1)]);
}

function spyStreamAndRecordModels(agent: Agent, responses: StreamResult[], models: string[]): void {
  let call = 0;
  jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay")
    .mockImplementation(async () => {
      const runtime = agent as unknown as AgentWithRuntime;
      models.push(runtime.activeModel ?? runtime.config.model);
      return responses[Math.min(call++, responses.length - 1)];
    });
}

const TOOL_CALL: StreamResult = {
  text: "",
  toolCalls: [{ id: "c1", name: "run_bash", argsRaw: '{"command":"echo hi"}' }],
};
const DONE: StreamResult = { text: "finished", toolCalls: null };

describe("Agent continuation policy", () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it("throws after maxIterations with no continuation policy", async () => {
    const agent = new Agent(makeConfig({ maxIterations: 2 }));
    spyStream(agent, [TOOL_CALL]);

    await expect(agent.run("task")).rejects.toThrow("Reached max iterations (2)");
  });

  it("fires continuation event and runs extra iterations before exhausting", async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent(
      makeConfig({
        maxIterations: 2,
        continuationPolicy: { maxContinuations: 1 } satisfies ContinuationPolicy,
        onEvent: (e) => events.push(e),
      }),
    );

    spyCompact(agent);
    spyStream(agent, [TOOL_CALL, TOOL_CALL, TOOL_CALL, DONE]);

    await expect(agent.run("task")).resolves.toBe("finished");

    const contEvents = events.filter((e) => e.type === "continuation");
    expect(contEvents).toHaveLength(1);
    expect(contEvents[0]).toMatchObject({ type: "continuation", count: 1, max: 1 });
  });

  it("throws after all continuations are exhausted", async () => {
    const agent = new Agent(
      makeConfig({
        maxIterations: 2,
        continuationPolicy: { maxContinuations: 2 },
      }),
    );

    spyCompact(agent);
    spyStream(agent, [TOOL_CALL]);

    await expect(agent.run("task")).rejects.toThrow(
      /Reached max iterations \(2\) after 2 continuation\(s\)/,
    );
  });

  it("uses iterationsPerContinuation when provided", async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent(
      makeConfig({
        maxIterations: 2,
        continuationPolicy: { maxContinuations: 1, iterationsPerContinuation: 3 },
        onEvent: (e) => events.push(e),
      }),
    );

    spyCompact(agent);
    const toolCallsThenDone: StreamResult[] = [
      TOOL_CALL, TOOL_CALL,
      TOOL_CALL, TOOL_CALL, DONE,
    ];
    spyStream(agent, toolCallsThenDone);

    await expect(agent.run("task")).resolves.toBe("finished");

    const iterEvents = events.filter((e) => e.type === "iteration");
    const maxValues = (iterEvents as Extract<AgentEvent, { type: "iteration" }>[]).map((e) => e.max);
    expect(maxValues).toContain(3);
  });

  it("emits compact event on continuation", async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent(
      makeConfig({
        maxIterations: 1,
        continuationPolicy: { maxContinuations: 1 },
        onEvent: (e) => events.push(e),
      }),
    );

    spyCompact(agent);
    spyStream(agent, [TOOL_CALL, DONE]);

    await expect(agent.run("task")).resolves.toBe("finished");

    expect(events.find((e) => e.type === "compact")).toBeDefined();
    expect(events.find((e) => e.type === "continuation")).toBeDefined();
  });

  it("switches model before compacting and resuming continuation", async () => {
    const events: AgentEvent[] = [];
    const models: string[] = [];
    const compactModels: string[] = [];
    const agent = new Agent(
      makeConfig({
        model: "fast-default",
        maxIterations: 1,
        continuationPolicy: {
          maxContinuations: 1,
          modelSwitch: { toModel: "continuation-heavy" },
        },
        onEvent: (e) => events.push(e),
      }),
    );

    jest.spyOn(agent as unknown as AgentPrivate, "compactContext")
      .mockImplementation(async () => {
        const runtime = agent as unknown as AgentWithRuntime;
        compactModels.push(runtime.activeModel ?? runtime.config.model);
        return "summary";
      });
    spyStreamAndRecordModels(agent, [TOOL_CALL, DONE], models);

    await expect(agent.run("task")).resolves.toBe("finished");

    expect(models).toEqual(["fast-default", "continuation-heavy"]);
    expect(compactModels).toEqual(["continuation-heavy"]);
    expect(events.find((e) => e.type === "model_switch")).toMatchObject({
      type: "model_switch",
      from: "fast-default",
      to: "continuation-heavy",
      reason: "continuation",
    });
  });

  it("switches model at the configured continuation count", async () => {
    const models: string[] = [];
    const agent = new Agent(
      makeConfig({
        model: "fast-default",
        maxIterations: 1,
        continuationPolicy: {
          maxContinuations: 2,
          modelSwitch: { toModel: "continuation-heavy", afterContinuations: 2 },
        },
      }),
    );

    spyCompact(agent);
    spyStreamAndRecordModels(agent, [TOOL_CALL, TOOL_CALL, DONE], models);

    await expect(agent.run("task")).resolves.toBe("finished");

    expect(models).toEqual(["fast-default", "fast-default", "continuation-heavy"]);
  });

  it("does not leak continuation model into subsequent runs", async () => {
    const firstRunModels: string[] = [];
    const secondRunModels: string[] = [];
    const agent = new Agent(
      makeConfig({
        model: "fast-default",
        maxIterations: 1,
        continuationPolicy: {
          maxContinuations: 1,
          modelSwitch: { toModel: "continuation-heavy" },
        },
      }),
    );

    spyCompact(agent);
    spyStreamAndRecordModels(agent, [TOOL_CALL, DONE], firstRunModels);
    await expect(agent.run("task one")).resolves.toBe("finished");

    jest.restoreAllMocks();
    spyStreamAndRecordModels(agent, [DONE], secondRunModels);
    await expect(agent.run("task two")).resolves.toBe("finished");

    expect(firstRunModels).toEqual(["fast-default", "continuation-heavy"]);
    expect(secondRunModels).toEqual(["fast-default"]);
  });
});

describe("Agent sandbox wiring", () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it("emits sandbox_health events during run", async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent(
      makeConfig({
        maxIterations: 5,
        onEvent: (e) => events.push(e),
      }),
    );

    spyStream(agent, [TOOL_CALL, DONE]);
    await agent.run("task");

    const healthEvents = events.filter((e) => e.type === "sandbox_health");
    expect(healthEvents.length).toBeGreaterThan(0);
  });

  it("observer total increments after run_bash via executor", async () => {
    const events: AgentEvent[] = [];
    const agent = new Agent(
      makeConfig({
        maxIterations: 5,
        onEvent: (e) => events.push(e),
      }),
    );

    spyStream(agent, [TOOL_CALL, DONE]);
    await agent.run("task");

    const healthEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: "sandbox_health" }> => e.type === "sandbox_health",
    );
    const last = healthEvents[healthEvents.length - 1];
    expect(last).toBeDefined();
    expect(last.total).toBeGreaterThanOrEqual(1);
  });
});

describe("Agent stream parsing", () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it("skips OpenAI-compatible stream chunks without choices", async () => {
    const agent = new Agent(makeConfig());
    async function* chunks() {
      yield {};
      yield { choices: [] };
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    (agent as unknown as AgentWithClient).client = {
      chat: {
        completions: {
          create: async () => chunks(),
        },
      },
    };

    await expect((agent as unknown as AgentPrivate).streamCompletionWithReplay()).resolves.toEqual({
      text: "ok",
      toolCalls: null,
    });
  });
});

describe("Agent tool call history", () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it("stores valid JSON arguments after a malformed tool call", async () => {
    const agent = new Agent(makeConfig({ maxIterations: 3 }));
    spyStream(agent, [
      { text: "", toolCalls: [{ id: "bad-call", name: "run_bash", argsRaw: "{command:" }] },
      DONE,
    ]);

    await expect(agent.run("task")).resolves.toBe("finished");

    const assistantWithToolCall = (agent as unknown as AgentWithMessages).messages.find(
      (message) => message.role === "assistant" && message.tool_calls,
    );
    expect(assistantWithToolCall?.tool_calls?.[0]?.function.arguments).toBe("{}");
  });
});
