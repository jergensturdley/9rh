import { describe, expect, it } from "@jest/globals";
import { renderRecentTranscript, summarizeLiveModelInsight, renderDashboardLines, toolTarget, formatElapsed, type DashboardState, type ToolHistoryEntry } from "../tui.js";
import { createRunVisualization, applyAgentEvent, renderRunMapCompact } from "../visualization.js";

describe("TUI live model insight", () => {
  it("connects recent reasoning to the next tool call", () => {
    const insight = summarizeLiveModelInsight(
      ["Need to inspect the renderer first. ", "Search for the live panel code before editing."],
      "agentgrep",
      { query: "live action", path: "src" },
    );

    expect(insight).toContain("intent: gather evidence with agentgrep");
    expect(insight).toContain("reasoning: Need to inspect the renderer first. Search for the live panel code before editing.");
    expect(insight).toContain("approx reasoning tokens");
  });

  it("falls back gracefully when no reasoning has streamed yet", () => {
    const insight = summarizeLiveModelInsight([], "bash", { command: "npm test" });

    expect(insight).toContain("intent: execute or validate with bash (npm test)");
    expect(insight).toContain("waiting for explicit reasoning text from the model");
    expect(insight).toContain("0 approx reasoning tokens");
  });
});

describe("TUI recent transcript", () => {
  it("keeps a compact conversational ledger next to the live map", () => {
    const transcript = renderRecentTranscript([
      { kind: "agent", text: "I will inspect the repo.\nThen run tests." },
      { kind: "tool", text: "run_bash {\"command\":\"npm test\"}" },
      { kind: "result", text: "PASS src/__tests__/tui.test.ts" },
    ]);

    expect(transcript).toContain("agent: I will inspect the repo. Then run tests.");
    expect(transcript).toContain("tool: run_bash");
    expect(transcript).toContain("result: PASS");
  });

  it("shows only the most recent transcript entries", () => {
    const transcript = renderRecentTranscript(
      Array.from({ length: 12 }, (_, i) => ({ kind: "system" as const, text: `entry ${i + 1}` })),
      4,
    );

    expect(transcript).not.toContain("entry 8");
    expect(transcript).toContain("entry 9");
    expect(transcript).toContain("entry 12");
  });
});
describe("formatElapsed", () => {
  it("formats seconds only for sub-minute durations", () => {
    const start = new Date(Date.now() - 45000);
    expect(formatElapsed(start)).toMatch(/^\d+s$/);
  });

  it("formats minutes and seconds for minute-level durations", () => {
    const start = new Date(Date.now() - 185000);
    const result = formatElapsed(start);
    expect(result).toContain("m");
    expect(result).toContain("s");
  });

  it("formats hours and minutes for hour-level durations", () => {
    const start = new Date(Date.now() - 3700000);
    const result = formatElapsed(start);
    expect(result).toContain("h");
    expect(result).toContain("m");
  });
});

describe("toolTarget", () => {
  it("extracts path from args", () => {
    expect(toolTarget({ path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("extracts command from args", () => {
    expect(toolTarget({ command: "npm test" })).toBe("npm test");
  });

  it("extracts query from args", () => {
    expect(toolTarget({ query: "search term" })).toBe("search term");
  });

  it("truncates long paths", () => {
    const longPath = "src/components/deep/nested/very/long/path/to/file.ts";
    const result = toolTarget({ path: longPath });
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it("returns empty string for args without recognized keys", () => {
    expect(toolTarget({ foo: "bar" })).toBe("");
  });
});

describe("renderDashboardLines", () => {
  it("renders a dashboard with idle state", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 0,
      iterMax: 0,
      activity: "idle",
      thinkingCharCount: 0,
      thinkingPreview: "",
      currentTool: null,
      currentToolTarget: null,
      toolHistory: [],
    };
    const view = createRunVisualization();
    const lines = renderDashboardLines(state, false, 44, view);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("9rh");
    expect(lines.some(l => l.includes("idle"))).toBe(true);
    // Verify all lines have consistent width
    const widths = lines.map(l => l.length);
    const uniqueWidths = [...new Set(widths)];
    expect(uniqueWidths.length).toBe(1);
    expect(uniqueWidths[0]).toBe(44);
  });

  it("renders thinking activity with char count", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 1,
      iterMax: 5,
      activity: "thinking",
      thinkingCharCount: 847,
      thinkingPreview: "hashing the token budget while it ponders the constraints of...",
      currentTool: null,
      currentToolTarget: null,
      toolHistory: [],
    };
    const view = createRunVisualization();
    const lines = renderDashboardLines(state, false, 44, view);
    expect(lines.some(l => l.includes("thinking"))).toBe(true);
    expect(lines.some(l => l.includes("847"))).toBe(true);
  });

  it("renders tool activity", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 2,
      iterMax: 10,
      activity: "tool",
      thinkingCharCount: 0,
      thinkingPreview: "",
      currentTool: "read_file",
      currentToolTarget: "src/main.ts",
      toolHistory: [
        { status: "running", name: "read_file", target: "src/main.ts" },
        { status: "success", name: "bash", target: "npm test" },
      ],
    };
    const view = createRunVisualization();
    const lines = renderDashboardLines(state, false, 44, view);
    expect(lines.some(l => l.includes("read_file"))).toBe(true);
    expect(lines.some(l => l.includes("bash"))).toBe(true);
  });

  it("renders timeline from run map", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 1,
      iterMax: 5,
      activity: "thinking",
      thinkingCharCount: 100,
      thinkingPreview: "planning",
      currentTool: null,
      currentToolTarget: null,
      toolHistory: [],
    };
    const view = createRunVisualization();
    applyAgentEvent(view, { type: "iteration", current: 1, max: 5 });
    applyAgentEvent(view, { type: "tool_call", name: "bash", args: { command: "npm test" } });

    const lines = renderDashboardLines(state, false, 44, view);
    expect(lines.some(l => l.includes("timeline"))).toBe(true);
    expect(lines.some(l => l.includes("bash"))).toBe(true);
  });

  it("renders sandbox health in footer", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 1,
      iterMax: 5,
      activity: "idle",
      thinkingCharCount: 0,
      thinkingPreview: "",
      currentTool: null,
      currentToolTarget: null,
      toolHistory: [],
    };
    const view = createRunVisualization();
    applyAgentEvent(view, { type: "sandbox_health", total: 3, sandboxed: 2, direct: 1, timedOut: 0 });

    const lines = renderDashboardLines(state, false, 44, view);
    expect(lines.some(l => l.includes("2/1/0"))).toBe(true);
  });

  it("returns empty array for very narrow terminals", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 0,
      iterMax: 0,
      activity: "idle",
      thinkingCharCount: 0,
      thinkingPreview: "",
      currentTool: null,
      currentToolTarget: null,
      toolHistory: [],
    };
    const view = createRunVisualization();
    const lines = renderDashboardLines(state, false, 8, view);
    expect(lines).toEqual([]);
  });

  it("renders done state", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 5,
      iterMax: 5,
      activity: "done",
      thinkingCharCount: 0,
      thinkingPreview: "",
      currentTool: null,
      currentToolTarget: null,
      toolHistory: [{ status: "success", name: "bash", target: "npm test" }],
    };
    const view = createRunVisualization();
    const lines = renderDashboardLines(state, false, 44, view);
    expect(lines.some(l => l.includes("done"))).toBe(true);
  });

  it("renders error state", () => {
    const state: DashboardState = {
      startedAt: new Date(),
      iterCurrent: 2,
      iterMax: 10,
      activity: "error",
      thinkingCharCount: 0,
      thinkingPreview: "",
      currentTool: null,
      currentToolTarget: null,
      toolHistory: [{ status: "error", name: "bash", target: "bad command" }],
    };
    const view = createRunVisualization();
    const lines = renderDashboardLines(state, false, 44, view);
    expect(lines.some(l => l.includes("error"))).toBe(true);
  });
});
