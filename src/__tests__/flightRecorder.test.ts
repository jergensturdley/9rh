import { describe, it, expect } from "@jest/globals";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { mapReplayEvent, renderEventLog, listRunLogs } from "../flightRecorder.js";
import type { ReplayEvent } from "../replay/eventSchema.js";
import type { AgentEvent } from "../agent.js";

const step = { stepIndex: 3, iteration: 3, compactCount: 0 };

describe("mapReplayEvent", () => {
  it("maps step_start to an iteration event", () => {
    const mapped = mapReplayEvent({ type: "step_start", seq: 1, ts: 1, step, payload: {} });
    expect(mapped).toEqual([{ type: "iteration", current: 3, max: 0 }]);
  });

  it("maps tool_call / tool_result onto the renderer vocabulary", () => {
    const call = mapReplayEvent({
      type: "tool_call",
      seq: 2,
      ts: 2,
      step,
      payload: { toolName: "run_bash", args: { command: "ls" }, callId: "c1" },
    });
    expect(call).toEqual([{ type: "tool_call", name: "run_bash", args: { command: "ls" } }]);
    const result = mapReplayEvent({
      type: "tool_result",
      seq: 3,
      ts: 3,
      step,
      payload: { toolName: "run_bash", callId: "c1", output: "a\nb", durationMs: 5 },
    });
    expect(result).toEqual([{ type: "tool_result", name: "run_bash", output: "a\nb", error: undefined }]);
  });

  it("maps llm_response text to thinking and drops empty text", () => {
    const withText = mapReplayEvent({
      type: "llm_response",
      seq: 4,
      ts: 4,
      step,
      payload: { text: "considering…", toolCalls: null, finishReason: "stop" },
    });
    expect(withText).toEqual([{ type: "thinking", text: "considering…" }]);
    const empty = mapReplayEvent({
      type: "llm_response",
      seq: 5,
      ts: 5,
      step,
      payload: { text: "", toolCalls: null, finishReason: "tool_calls" },
    });
    expect(empty).toEqual([]);
  });

  it("silently drops bookkeeping events (checkpoints, run bookends)", () => {
    expect(
      mapReplayEvent({
        type: "checkpoint",
        seq: 6,
        ts: 6,
        step,
        payload: { snapshotId: "snap-x", messageCount: 4, reason: "periodic" },
      }),
    ).toEqual([]);
    expect(mapReplayEvent({ type: "run_end", seq: 7, ts: 7, payload: { runId: "r", reason: "completed" } })).toEqual([]);
  });
});

describe("renderEventLog", () => {
  const events: ReplayEvent[] = [
    { type: "step_start", seq: 1, ts: 1000, step, payload: {} },
    {
      type: "tool_call",
      seq: 2,
      ts: 2000,
      step,
      payload: { toolName: "read_file", args: { path: "x" }, callId: "c" },
    },
    {
      type: "tool_result",
      seq: 3,
      ts: 2500,
      step,
      payload: { toolName: "read_file", callId: "c", output: "ok", durationMs: 3 },
    },
  ];

  it("emits mapped events paced by scaled, capped gaps", async () => {
    const emitted: AgentEvent[] = [];
    const sleeps: number[] = [];
    const { rendered, aborted } = await renderEventLog(events, (e) => emitted.push(e), {
      speed: 2,
      gapCapMs: 400,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(rendered).toBe(3);
    expect(aborted).toBe(false);
    expect(emitted.map((e) => e.type)).toEqual(["iteration", "tool_call", "tool_result"]);
    // gaps: (2000-1000)/2 = 500 → capped 400; (2500-2000)/2 = 250.
    expect(sleeps).toEqual([400, 250]);
  });

  it("stops when shouldAbort flips", async () => {
    let count = 0;
    const { rendered, aborted } = await renderEventLog(
      events,
      () => { count++; },
      { shouldAbort: () => count >= 1, sleep: async () => {} },
    );
    expect(aborted).toBe(true);
    expect(rendered).toBe(1);
  });
});

describe("listRunLogs", () => {
  it("lists run-*.jsonl newest first with meta sidecar info", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-"));
    await writeFile(join(dir, "run-aaa.jsonl"), "{}\n");
    await writeFile(join(dir, "run-aaa.meta.json"), JSON.stringify({ eventCount: 12, reason: "completed" }));
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(dir, "run-bbb.jsonl"), "{}\n");
    await writeFile(join(dir, "not-a-run.txt"), "x");
    const logs = await listRunLogs(dir);
    expect(logs.map((l) => l.runId)).toEqual(["bbb", "aaa"]);
    expect(logs[1].eventCount).toBe(12);
    expect(logs[1].reason).toBe("completed");
  });

  it("returns [] for a missing directory", async () => {
    expect(await listRunLogs(join(tmpdir(), "definitely-missing-dir-xyz"))).toEqual([]);
  });
});
