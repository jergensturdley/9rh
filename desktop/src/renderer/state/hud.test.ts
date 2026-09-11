import { describe, it, expect } from "vitest";
import type { SessionEvent, SessionEventEnvelope } from "@shared/ipc";
import { applyHudEvent } from "./hud";
import { EMPTY_HUD, type HudState } from "./types";

let seq = 0;
const env = (event: SessionEvent, ts = 1000): SessionEventEnvelope => ({ sessionId: "s1", seq: ++seq, ts, event });
const fold = (events: SessionEvent[], start: HudState = EMPTY_HUD): HudState =>
  events.reduce((h, e) => applyHudEvent(h, env(e)), start);

describe("applyHudEvent", () => {
  it("turn_start resets to EMPTY_HUD with activity thinking", () => {
    const dirty: HudState = { ...EMPTY_HUD, iterCurrent: 7, thinkingChars: 99, activity: "done" };
    expect(applyHudEvent(dirty, env({ type: "turn_start", task: "t", turnIndex: 1, team: false }))).toEqual({
      ...EMPTY_HUD,
      activity: "thinking",
    });
  });

  it("thinking accumulates chars and keeps a single-line 120 char preview", () => {
    const hud = fold([
      { type: "thinking", text: "hello\n  world " },
      { type: "thinking", text: "x".repeat(200) },
    ]);
    expect(hud.activity).toBe("thinking");
    expect(hud.thinkingChars).toBe(14 + 200);
    expect(hud.thinkingPreview).toHaveLength(120);
    expect(hud.thinkingPreview).not.toMatch(/\n/);
    const short = fold([{ type: "thinking", text: "a\nb" }]);
    expect(short.thinkingPreview).toBe("a b");
  });

  it("tool_call sets current tool and pushes running history, capped at 8", () => {
    const one = fold([{ type: "tool_call", name: "read_file", args: { path: "a.ts" } }]);
    expect(one.activity).toBe("tool");
    expect(one.currentTool).toBe("read_file");
    expect(one.currentToolTarget).toBe("a.ts");
    expect(one.toolHistory).toEqual([{ name: "read_file", target: "a.ts", status: "running" }]);

    const calls: SessionEvent[] = Array.from({ length: 10 }, (_, i) => ({
      type: "tool_call",
      name: "run_bash",
      args: { command: `cmd${i}` },
    }));
    const many = fold(calls);
    expect(many.toolHistory).toHaveLength(8);
    expect(many.toolHistory[0].target).toBe("cmd2");
    expect(many.toolHistory[7].target).toBe("cmd9");
  });

  it("tool_call clears the thinking preview from the previous round", () => {
    const hud = fold([
      { type: "thinking", text: "planning" },
      { type: "tool_call", name: "list_files", args: {} },
    ]);
    expect(hud.thinkingChars).toBe(0);
    expect(hud.thinkingPreview).toBe("");
    expect(hud.currentToolTarget).toBe(".");
  });

  it("tool_result marks the oldest running item with that name (FIFO)", () => {
    const hud = fold([
      { type: "tool_call", name: "run_bash", args: { command: "one" } },
      { type: "tool_call", name: "run_bash", args: { command: "two" } },
      { type: "tool_result", name: "run_bash", output: "", error: "boom" },
    ]);
    expect(hud.toolHistory.map((h) => h.status)).toEqual(["error", "running"]);
    expect(hud.activity).toBe("thinking");
    expect(hud.currentTool).toBeNull();
    expect(hud.currentToolTarget).toBeNull();

    const done = applyHudEvent(hud, env({ type: "tool_result", name: "run_bash", output: "ok" }));
    expect(done.toolHistory.map((h) => h.status)).toEqual(["error", "success"]);
  });

  it("tool_result falls back to the oldest running item of any name", () => {
    const hud = fold([
      { type: "tool_call", name: "read_file", args: { path: "a" } },
      { type: "tool_result", name: "mystery", output: "ok" },
    ]);
    expect(hud.toolHistory[0].status).toBe("success");
  });

  it("iteration sets counters and resets the thinking preview", () => {
    const hud = fold([
      { type: "thinking", text: "old" },
      { type: "iteration", current: 3, max: 100 },
    ]);
    expect(hud.iterCurrent).toBe(3);
    expect(hud.iterMax).toBe(100);
    expect(hud.thinkingPreview).toBe("");
    expect(hud.activity).toBe("thinking");
  });

  it("continuation and usage update their fields", () => {
    const turn = { prompt: 10, completion: 5, total: 15 };
    const last = { prompt: 4, completion: 1, total: 5 };
    const hud = fold([
      { type: "continuation", count: 1, max: 20 },
      { type: "usage", lastCompletion: last, turn },
    ]);
    expect(hud.continuation).toEqual({ count: 1, max: 20 });
    expect(hud.turnTokens).toEqual(turn);
    expect(hud.lastCompletion).toEqual(last);
  });

  it("done and error set activity and clear the current tool", () => {
    const base = fold([{ type: "tool_call", name: "run_bash", args: { command: "x" } }]);
    expect(applyHudEvent(base, env({ type: "done", text: "ok" })).activity).toBe("done");
    expect(applyHudEvent(base, env({ type: "done", text: "ok" })).currentTool).toBeNull();
    expect(applyHudEvent(base, env({ type: "error", message: "no" })).activity).toBe("error");
  });

  it("team events fold into lanes with the envelope timestamp", () => {
    const start = applyHudEvent(
      EMPTY_HUD,
      env({ type: "team", event: { type: "role_start", role: "architect", taskId: "t" } }, 500),
    );
    const done = applyHudEvent(
      start,
      env(
        {
          type: "team",
          event: { type: "role_complete", role: "architect", taskId: "t", result: "r", usage: { prompt: 1, completion: 1, total: 42 } },
        },
        900,
      ),
    );
    expect(done.teamLanes).toEqual([{ role: "architect", status: "done", startedAt: 500, endedAt: 900, tokens: 42 }]);
  });

  it("turn_end goes idle unless done/error already closed the turn", () => {
    const turnEnd: SessionEvent = { type: "turn_end", turnIndex: 0, status: "aborted", durationMs: 1 };
    expect(applyHudEvent({ ...EMPTY_HUD, activity: "tool" }, env(turnEnd)).activity).toBe("idle");
    expect(applyHudEvent({ ...EMPTY_HUD, activity: "done" }, env(turnEnd)).activity).toBe("done");
    expect(applyHudEvent({ ...EMPTY_HUD, activity: "error" }, env(turnEnd)).activity).toBe("error");
  });

  it("returns the same object for events that do not touch the HUD", () => {
    expect(applyHudEvent(EMPTY_HUD, env({ type: "compact", summary: "s" }))).toBe(EMPTY_HUD);
  });
});
