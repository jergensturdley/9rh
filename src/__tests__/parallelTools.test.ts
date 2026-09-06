import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { setTimeout as delay } from "timers/promises";
import { Agent } from "../agent.js";
import type { AgentConfig } from "../agent.js";
import { resolveParallelTools } from "../cliArgs.js";

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
type AgentWithMessages = AgentPrivate & {
  messages: Array<{ role: string; tool_call_id?: string; content?: string | null }>;
};

function spyStream(agent: Agent, responses: StreamResult[]): void {
  let call = 0;
  jest.spyOn(agent as unknown as AgentPrivate, "streamCompletionWithReplay")
    .mockImplementation(async () => responses[Math.min(call++, responses.length - 1)]);
}

const DONE: StreamResult = { text: "finished", toolCalls: null };

function toolMessages(agent: Agent): Array<{ tool_call_id?: string; content?: string | null }> {
  const msgs = (agent as unknown as AgentWithMessages).messages.filter((m) => m.role === "tool");
  return msgs;
}

interface Interval { name: string; start: number; end: number }

/** Mock executor that records per-call intervals and sleeps `ms`. */
function mockExecutorRecordingIntervals(agent: Agent, intervals: Interval[], msFor: (name: string, args: Record<string, unknown>) => number): void {
  jest.spyOn(agent as unknown as AgentPrivate, "executeToolWithRepair").mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      const start = Date.now();
      await delay(msFor(name, args));
      intervals.push({ name, start, end: Date.now() });
      return { output: `out:${name}` };
    },
  );
}

function toolCallsSpec(specs: Array<{ id: string; name: string; args?: Record<string, unknown> }>): StreamResult {
  return {
    text: "",
    toolCalls: specs.map((s) => ({ id: s.id, name: s.name, argsRaw: JSON.stringify(s.args ?? {}) })),
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
});

describe("parallel tool execution", () => {
  it("appends tool messages in the original call order despite reversed completion order", async () => {
    const agent = new Agent(makeConfig({ toolConcurrency: 4 }));
    spyStream(agent, [
      toolCallsSpec([
        { id: "c-slow", name: "read_file", args: { path: "a.txt" } },
        { id: "c-mid", name: "read_file", args: { path: "b.txt" } },
        { id: "c-fast", name: "read_file", args: { path: "c.txt" } },
      ]),
      DONE,
    ]);
    const intervals: Interval[] = [];
    mockExecutorRecordingIntervals(agent, intervals, (name, args) => {
      // First call finishes last.
      void name;
      return args.path === "a.txt" ? 90 : args.path === "b.txt" ? 50 : 5;
    });

    await expect(agent.run("task")).resolves.toBe("finished");

    const ids = toolMessages(agent).map((m) => m.tool_call_id);
    expect(ids).toEqual(["c-slow", "c-mid", "c-fast"]);
  });

  it("runs read-only calls concurrently (observed overlap, not wall-clock)", async () => {
    const agent = new Agent(makeConfig({ toolConcurrency: 4 }));
    spyStream(agent, [
      toolCallsSpec([
        { id: "1", name: "read_file", args: { path: "1" } },
        { id: "2", name: "read_file", args: { path: "2" } },
        { id: "3", name: "read_file", args: { path: "3" } },
        { id: "4", name: "read_file", args: { path: "4" } },
      ]),
      DONE,
    ]);
    const intervals: Interval[] = [];
    mockExecutorRecordingIntervals(agent, intervals, () => 50);

    await agent.run("task");
    expect(intervals).toHaveLength(4);

    // Count how many intervals overlap the busiest point. Sequential = 1,
    // concurrent with pool 4 must show at least 2 overlapping calls.
    let maxOverlap = 0;
    for (const iv of intervals) {
      const mid = (iv.start + iv.end) / 2;
      maxOverlap = Math.max(maxOverlap, intervals.filter((o) => o.start <= mid && mid <= o.end).length);
    }
    expect(maxOverlap).toBeGreaterThanOrEqual(2);
  });

  it("never runs two mutating (medium/high risk) calls at the same time", async () => {
    const agent = new Agent(makeConfig({ toolConcurrency: 4 }));
    spyStream(agent, [
      toolCallsSpec([
        { id: "1", name: "run_bash", args: { command: "node --version" } },
        { id: "2", name: "run_bash", args: { command: "node --version" } },
        { id: "3", name: "run_bash", args: { command: "node --version" } },
      ]),
      DONE,
    ]);
    const intervals: Interval[] = [];
    mockExecutorRecordingIntervals(agent, intervals, () => 40);

    await agent.run("task");

    intervals.sort((a, b) => a.start - b.start);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i].start).toBeGreaterThanOrEqual(intervals[i - 1].end);
    }
  });

  it("a low-risk bash command may overlap a mutating bash command (does not take the lock)", async () => {
    const agent = new Agent(makeConfig({ toolConcurrency: 4 }));
    spyStream(agent, [
      toolCallsSpec([
        { id: "mut", name: "run_bash", args: { command: "node --version" } },
        { id: "ro", name: "run_bash", args: { command: "cat README.md" } },
      ]),
      DONE,
    ]);
    const intervals: Interval[] = [];
    mockExecutorRecordingIntervals(agent, intervals, () => 80);

    await agent.run("task");

    const byId = new Map(intervals.map((iv) => [iv.name === "run_bash" ? iv : iv, iv]));
    expect(byId.size).toBe(2);
    const [a, b] = intervals;
    const overlap = a.start < b.end && b.start < a.end;
    expect(overlap).toBe(true);
  });

  it("toolConcurrency 1 reproduces strict sequential execution", async () => {
    const agent = new Agent(makeConfig({ toolConcurrency: 1 }));
    spyStream(agent, [
      toolCallsSpec([
        { id: "1", name: "read_file", args: { path: "1" } },
        { id: "2", name: "read_file", args: { path: "2" } },
        { id: "3", name: "read_file", args: { path: "3" } },
      ]),
      DONE,
    ]);
    const intervals: Interval[] = [];
    mockExecutorRecordingIntervals(agent, intervals, () => 15);

    await agent.run("task");

    intervals.sort((a, b) => a.start - b.start);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i].start).toBeGreaterThanOrEqual(intervals[i - 1].end);
    }
    const ids = toolMessages(agent).map((m) => m.tool_call_id);
    expect(ids).toEqual(["1", "2", "3"]);
  });

  it("contains an executor rejection: the failing call gets an ERROR tool message and the run continues", async () => {
    const agent = new Agent(makeConfig({ toolConcurrency: 4 }));
    spyStream(agent, [
      toolCallsSpec([
        { id: "ok-1", name: "read_file", args: { path: "1" } },
        { id: "bad", name: "read_file", args: { path: "2" } },
        { id: "ok-2", name: "read_file", args: { path: "3" } },
      ]),
      DONE,
    ]);
    jest.spyOn(agent as unknown as AgentPrivate, "executeToolWithRepair").mockImplementation(
      async (_name: string, args: Record<string, unknown>) => {
        if (args.path === "2") throw new Error("boom");
        return { output: "fine" };
      },
    );

    await expect(agent.run("task")).resolves.toBe("finished");

    const msgs = toolMessages(agent);
    expect(msgs.map((m) => m.tool_call_id)).toEqual(["ok-1", "bad", "ok-2"]);
    expect(msgs[1].content).toContain("ERROR");
    expect(msgs[1].content).toContain("boom");
  });

  it("records per-call duration on the report for concurrent calls", async () => {
    const agent = new Agent(makeConfig({ toolConcurrency: 4 }));
    spyStream(agent, [
      toolCallsSpec([
        { id: "1", name: "read_file", args: { path: "1" } },
        { id: "2", name: "read_file", args: { path: "2" } },
      ]),
      DONE,
    ]);
    mockExecutorRecordingIntervals(agent, [], () => 20);

    await agent.run("task");

    const report = (agent as unknown as { report: { toolCalls: Array<{ name: string; durationMs?: number }> } | null }).report;
    const durations = (report?.toolCalls ?? []).filter((t) => t.name === "read_file");
    expect(durations).toHaveLength(2);
    for (const d of durations) expect(d.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveParallelTools", () => {
  it("prefers the flag value", () => {
    expect(resolveParallelTools("2", 4)).toEqual({ ok: true, value: 2 });
  });
  it("falls back to the default when the flag is missing", () => {
    expect(resolveParallelTools(undefined, 4)).toEqual({ ok: true, value: 4 });
  });
  it("falls back to the default on invalid input (0, negative, NaN)", () => {
    expect(resolveParallelTools("0", 4)).toEqual({ ok: true, value: 4 });
    expect(resolveParallelTools("-3", 4)).toEqual({ ok: true, value: 4 });
    expect(resolveParallelTools("abc", 4)).toEqual({ ok: true, value: 4 });
  });
  it("accepts 1 as explicit sequential mode", () => {
    expect(resolveParallelTools("1", 4)).toEqual({ ok: true, value: 1 });
  });
});
