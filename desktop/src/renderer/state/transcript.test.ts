import { describe, it, expect } from "vitest";
import type { SessionEvent, SessionEventEnvelope, SessionSnapshot, TurnDigest } from "@shared/ipc";
import { applyEnvelope, emptySessionView } from "./transcript";
import type { SessionView, TranscriptBlock } from "./types";

const snap = (turnCount = 0): SessionSnapshot => ({
  id: "s1",
  workDir: "/tmp/w",
  model: "m",
  backendName: "router",
  backendDescription: "router",
  baseURL: "http://127.0.0.1:20128/v1",
  hasNativeRouter: true,
  status: "idle",
  createdAt: 0,
  turnStartedAt: null,
  ledger: {
    sessionStartedAt: 0,
    turnCount,
    completedTurnCount: turnCount,
    goal: null,
    goalActive: false,
    lastOutcome: null,
    tokens: { prompt: 0, completion: 0, total: 0 },
    filesTouched: 0,
    commandsRun: 0,
    turns: [],
  },
  sandbox: { kind: "unavailable", label: "none" },
  pending: null,
  quiet: false,
  teamMode: false,
  maxIterations: 100,
  toolConcurrency: 4,
  allowSkillInstall: false,
  keepReports: false,
  lastReportPath: null,
  warnings: [],
  lastError: null,
});

const env = (seq: number, event: SessionEvent, ts = seq * 10): SessionEventEnvelope => ({ sessionId: "s1", seq, ts, event });

const fold = (events: SessionEvent[], view: SessionView = emptySessionView(snap())): SessionView =>
  events.reduce((v, e, i) => applyEnvelope(v, env(i + 1, e)), view);

const turnStart = (turnIndex = 0, task = "do it"): SessionEvent => ({ type: "turn_start", task, turnIndex, team: false });

const kinds = (v: SessionView): string[] => v.blocks.map((b) => b.kind);

describe("emptySessionView", () => {
  it("starts empty with the ledger turn count", () => {
    const v = emptySessionView(snap(3));
    expect(v.blocks).toEqual([]);
    expect(v.lastSeq).toBe(0);
    expect(v.currentTurn).toBe(3);
    expect(v.hud.activity).toBe("idle");
  });
});

describe("applyEnvelope", () => {
  it("turn_start pushes a user block and sets currentTurn; lastSeq tracks the envelope", () => {
    const v = fold([turnStart(2, "hello")]);
    expect(v.blocks).toEqual([{ kind: "user", id: "s1:1", ts: 10, turn: 2, text: "hello" }]);
    expect(v.currentTurn).toBe(2);
    expect(v.lastSeq).toBe(1);
    expect(v.hud.activity).toBe("thinking");
  });

  it("does not mutate the previous view", () => {
    const before = fold([turnStart()]);
    const frozen = JSON.stringify(before);
    applyEnvelope(before, env(2, { type: "thinking", text: "x" }));
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("coalesces consecutive thinking deltas into one block", () => {
    const v = fold([turnStart(), { type: "thinking", text: "ab" }, { type: "thinking", text: "cd" }]);
    expect(kinds(v)).toEqual(["user", "thinking"]);
    expect(v.blocks[1]).toMatchObject({ id: "s1:2", text: "abcd" });
  });

  it("starts a new thinking block after a tool call intervenes", () => {
    const v = fold([
      turnStart(),
      { type: "thinking", text: "a" },
      { type: "tool_call", name: "read_file", args: { path: "x" } },
      { type: "tool_result", name: "read_file", output: "y" },
      { type: "thinking", text: "b" },
    ]);
    expect(kinds(v)).toEqual(["user", "thinking", "tool", "thinking"]);
    expect(v.blocks[3]).toMatchObject({ text: "b", id: "s1:5" });
  });

  it("does not coalesce thinking across turns", () => {
    const v = fold([{ type: "thinking", text: "a" }, turnStart(1), { type: "thinking", text: "b" }]);
    expect(kinds(v)).toEqual(["thinking", "user", "thinking"]);
  });

  it("pairs tool results FIFO with the oldest running block of the same name", () => {
    const v = fold([
      turnStart(),
      { type: "tool_call", name: "run_bash", args: { command: "one" } },
      { type: "tool_call", name: "run_bash", args: { command: "two" } },
      { type: "tool_result", name: "run_bash", output: "out-1", error: "bad" },
    ]);
    expect(v.blocks[1]).toMatchObject({ kind: "tool", args: { command: "one" }, status: "error", output: "out-1", error: "bad", endedTs: 40 });
    expect(v.blocks[2]).toMatchObject({ kind: "tool", args: { command: "two" }, status: "running" });
    const v2 = applyEnvelope(v, env(5, { type: "tool_result", name: "run_bash", output: "out-2" }));
    expect(v2.blocks[2]).toMatchObject({ status: "success", output: "out-2", endedTs: 50 });
    expect((v2.blocks[2] as Extract<TranscriptBlock, { kind: "tool" }>).error).toBeUndefined();
  });

  it("interleaved parallel tools of different names complete their own block", () => {
    const v = fold([
      turnStart(),
      { type: "tool_call", name: "read_file", args: { path: "a" } },
      { type: "tool_call", name: "run_bash", args: { command: "b" } },
      { type: "tool_result", name: "run_bash", output: "B" },
      { type: "tool_result", name: "read_file", output: "A" },
    ]);
    expect(v.blocks[1]).toMatchObject({ name: "read_file", status: "success", output: "A" });
    expect(v.blocks[2]).toMatchObject({ name: "run_bash", status: "success", output: "B" });
  });

  it("pushes a completed tool block when no running block matches", () => {
    const v = fold([turnStart(), { type: "tool_result", name: "orphan", output: "o" }]);
    expect(v.blocks[1]).toMatchObject({ kind: "tool", id: "s1:2", name: "orphan", args: {}, status: "success", output: "o" });
  });

  it("renders loop bookkeeping and repair telemetry as markers", () => {
    const v = fold([
      turnStart(),
      { type: "iteration", current: 3, max: 100 },
      { type: "continuation", count: 1, max: 20 },
      { type: "model_switch", from: "kr/x", to: "y", reason: "continuation" },
      { type: "compact", summary: "dropped 3 msgs" },
      { type: "repair_start", message: "retrying", attempt: 1 },
      { type: "repair_success", message: "fixed" },
      { type: "escalate", message: "giving up" },
      { type: "circuit_open" },
      { type: "incident", stepId: "st1", cause: "timeout", repairAttempt: 2, circuitOpen: true },
      { type: "spec_plan", summary: "plan" },
      { type: "branch_create", stepId: "st1", branchId: "b2", reason: "retry" },
      { type: "sandbox_health", total: 0, sandboxed: 0, direct: 0, timedOut: 0 },
      { type: "step_inspect", stepId: "st2", params: "p", output: "o" },
      { type: "partial_output", stepId: "st2", text: "chunk" },
    ]);
    const markers = v.blocks.filter((b) => b.kind === "marker");
    expect(markers.map((m) => [m.variant, m.text])).toEqual([
      ["iteration", "iteration 3/100"],
      ["continuation", "continuation 1/20"],
      ["model_switch", "model switch kr/x -> y (continuation)"],
      ["compact", "compacted context"],
      ["repair_start", "repair attempt 1: retrying"],
      ["repair_success", "repair succeeded: fixed"],
      ["escalate", "escalated: giving up"],
      ["circuit_open", "circuit open: repair budget exhausted"],
      ["incident", "incident at st1: timeout"],
      ["spec_plan", "generated test plan"],
      ["branch_create", "branch b2 from st1: retry"],
      ["sandbox_health", "sandbox: 0/0 sandboxed"],
      ["step_inspect", "step st2"],
      ["partial_output", "partial output from st2"],
    ]);
    expect(markers[3].detail).toBe("dropped 3 msgs");
    expect(markers[8].detail).toBe("repair attempt 2, circuit open");
    expect(markers[12].detail).toBe("p\no");
    expect(markers[13].detail).toBe("chunk");
  });

  it("maps team events to team blocks and task_failed to a marker", () => {
    const v = fold([
      turnStart(),
      { type: "team", event: { type: "role_start", role: "architect", taskId: "t" } },
      { type: "team", event: { type: "role_complete", role: "architect", taskId: "t", result: "plan", usage: { prompt: 1, completion: 1, total: 12 } } },
      { type: "team", event: { type: "role_skip", role: "security_auditor", taskId: "t", reason: "no code" } },
      { type: "team", event: { type: "cache_hit", role: "test_strategist", taskId: "t" } },
      { type: "team", event: { type: "conflict", taskId: "t", parties: ["implementer", "reviewer"], resolution: "implementer_revises" } },
      { type: "team", event: { type: "escalation", taskId: "t", reason: "stuck" } },
      { type: "team", event: { type: "task_complete", taskId: "t", status: "ok" } },
      { type: "team", event: { type: "task_failed", taskId: "t", error: "boom" } },
    ]);
    expect(v.blocks.slice(1)).toEqual([
      { kind: "team", id: "s1:2", ts: 20, turn: 0, role: "architect", status: "start" },
      { kind: "team", id: "s1:3", ts: 30, turn: 0, role: "architect", status: "complete", text: "plan", tokens: 12 },
      { kind: "team", id: "s1:4", ts: 40, turn: 0, role: "security_auditor", status: "skip", text: "no code" },
      { kind: "team", id: "s1:5", ts: 50, turn: 0, role: "test_strategist", status: "cache" },
      { kind: "team", id: "s1:6", ts: 60, turn: 0, role: "implementer / reviewer", status: "conflict", text: "conflict resolved: implementer_revises" },
      { kind: "team", id: "s1:7", ts: 70, turn: 0, role: "team", status: "escalation", text: "stuck" },
      { kind: "marker", id: "s1:9", ts: 90, turn: 0, variant: "incident", text: "team failed: boom" },
    ]);
    expect(v.hud.teamLanes.map((l) => [l.role, l.status])).toEqual([
      ["architect", "done"],
      ["security_auditor", "skipped"],
      ["test_strategist", "cache"],
    ]);
  });

  it("done pushes completed receipts with a lite digest and report path", () => {
    const digest: TurnDigest = {
      task: "t",
      status: "completed",
      durationMs: 5,
      steps: 1,
      files: [],
      commands: [],
      toolCounts: {},
      fileChangeRecords: [{ step: 1, path: "a.ts", operation: "edit", before: "x", after: "y" }],
    };
    const v = fold([turnStart(), { type: "done", text: "all good", reportPath: "/r.html", digest }]);
    const r = v.blocks[1];
    expect(r.kind).toBe("receipts");
    expect(r).toMatchObject({ status: "completed", text: "all good", reportPath: "/r.html" });
    if (r.kind !== "receipts") throw new Error("expected receipts");
    expect(r.digest?.diffablePaths).toEqual(["a.ts"]);
    expect((r.digest as Record<string, unknown>).fileChangeRecords).toBeUndefined();
    expect(v.hud.activity).toBe("done");
  });

  it("done without a digest omits digest and reportPath", () => {
    const v = fold([turnStart(), { type: "done", text: "ok" }]);
    expect(v.blocks[1]).toEqual({ kind: "receipts", id: "s1:2", ts: 20, turn: 0, status: "completed", text: "ok" });
  });

  it("error pushes error receipts with the message", () => {
    const v = fold([turnStart(), { type: "error", message: "nope", reportPath: "/e.html" }]);
    expect(v.blocks[1]).toMatchObject({ kind: "receipts", status: "error", text: "nope", reportPath: "/e.html" });
    expect(v.hud.activity).toBe("error");
  });

  it("turn_end closes an aborted turn with aborted receipts", () => {
    const v = fold([turnStart(4), { type: "thinking", text: "..." }, { type: "turn_end", turnIndex: 4, status: "aborted", durationMs: 9 }]);
    expect(v.blocks[2]).toEqual({
      kind: "receipts",
      id: "s1:3",
      ts: 30,
      turn: 4,
      status: "aborted",
      text: "turn ended without a result",
    });
    expect(v.hud.activity).toBe("idle");
  });

  it("turn_end with a non-abort status and no receipts closes as error", () => {
    const v = fold([turnStart(), { type: "turn_end", turnIndex: 0, status: "error", durationMs: 1 }]);
    expect(v.blocks[1]).toMatchObject({ kind: "receipts", status: "error" });
  });

  it("turn_end adds nothing when the turn already has receipts", () => {
    const v = fold([turnStart(), { type: "done", text: "ok" }, { type: "turn_end", turnIndex: 0, status: "completed", durationMs: 1 }]);
    expect(kinds(v)).toEqual(["user", "receipts"]);
    expect(v.lastSeq).toBe(3);
    expect(v.hud.activity).toBe("done");
  });

  it("usage and replay_event add no blocks but still advance lastSeq and the HUD", () => {
    const usage = { prompt: 1, completion: 2, total: 3 };
    const v = fold([
      turnStart(),
      { type: "usage", lastCompletion: usage, turn: usage },
      { type: "replay_event", event: { type: "run_start" } as never },
    ]);
    expect(kinds(v)).toEqual(["user"]);
    expect(v.lastSeq).toBe(3);
    expect(v.hud.turnTokens).toEqual(usage);
  });

  it("assigns unique ids to every block across a full turn", () => {
    const v = fold([
      turnStart(),
      { type: "iteration", current: 1, max: 2 },
      { type: "thinking", text: "a" },
      { type: "tool_call", name: "run_bash", args: { command: "x" } },
      { type: "tool_result", name: "run_bash", output: "y" },
      { type: "thinking", text: "b" },
      { type: "done", text: "z" },
      { type: "turn_end", turnIndex: 0, status: "completed", durationMs: 1 },
    ]);
    const ids = v.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => i.startsWith("s1:"))).toBe(true);
  });
});
