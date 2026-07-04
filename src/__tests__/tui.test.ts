import { describe, expect, it } from "@jest/globals";
import {
  createTuiRenderer,
  renderRecentTranscript,
  summarizeLiveModelInsight,
  renderDashboardLines,
  toolTarget,
  formatElapsed,
  computeGeometry,
  padDashboardToHeight,
  wrapStreamChunk,
  type DashboardState,
  type ToolHistoryEntry,
} from "../tui.js";
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

describe("createTuiRenderer", () => {
  it("wraps done summary inside the content column when dashboard is visible", () => {
    const originalIsTTY = process.stdout.isTTY;
    const originalColumns = process.stdout.columns;
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const render = createTuiRenderer({
        getModel: () => "test-model",
        getWorkDir: () => "/tmp/9rh",
        useColor: false,
      });
      render({ type: "done", text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", reportPath: "/tmp/report.html" });
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
      Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
    }

    const output = writes.join("");
    const summaryLines = output
      .split("\n")
      .filter(line => line.startsWith("  ") && /alpha|beta|gamma|delta|epsilon|zeta|theta|lambda/.test(line));
    expect(summaryLines.length).toBeGreaterThan(1);
    for (const line of summaryLines) {
      expect(line.length).toBeLessThanOrEqual(43);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// TUI column-wrap spec — geometry / padding / per-line wrap helpers
// ────────────────────────────────────────────────────────────────────
describe("computeGeometry", () => {
  it("computes two-column geometry for 80x24 (typical)", () => {
    const g = computeGeometry(80, 24);
    // dashWidth is clamped to floor(80*0.28)=22 by min, then max with 36 → 36
    expect(g.dashWidth).toBe(36);
    expect(g.dashCol).toBe(80 - 36 + 1);
    expect(g.leftColWidth).toBe(80 - 36 - 1);
    expect(g.leftInner).toBe(80 - 36 - 1 - 2);
    expect(g.wrapWidth).toBe(80 - 36 - 1 - 2);
    expect(g.termRows).toBe(24);
  });

  it("scales dashWidth to cap at 48 for wide terminals", () => {
    const g = computeGeometry(200, 60);
    // floor(200*0.28)=56 → min(56,48)=48 → max(36,48)=48
    expect(g.dashWidth).toBe(48);
    expect(g.wrapWidth).toBe(200 - 48 - 1 - 2);
  });

  it("clamps to a positive wrapWidth even for narrow terminals", () => {
    const g = computeGeometry(40, 20);
    // floor(40*0.28)=11 → min(11,48)=11 → max(36,11)=36 (so dashWidth is 36)
    expect(g.dashWidth).toBe(36);
    expect(g.leftColWidth).toBe(40 - 36 - 1);
    // leftInner = max(0, 3 - 2) = 1
    expect(g.leftInner).toBe(1);
    expect(g.wrapWidth).toBe(1);
  });

  it("falls back to 80x24 defaults when dims are non-positive (no-TTY path)", () => {
    const g = computeGeometry(0, 0);
    expect(g.termCols).toBe(80);
    expect(g.termRows).toBe(24);
    expect(g.dashWidth).toBe(36);
    expect(g.wrapWidth).toBe(80 - 36 - 1 - 2);
  });

  it("treats NaN/Infinity as non-positive (falls back)", () => {
    expect(computeGeometry(NaN, 24).termCols).toBe(80);
    expect(computeGeometry(80, Infinity).termRows).toBe(24);
  });
});

describe("padDashboardToHeight", () => {
  it("appends blank |…| rows to reach target", () => {
    const input = ["row1", "row2", "row3"];
    const padded = padDashboardToHeight(input, 6, 4);
    expect(padded).toHaveLength(6);
    expect(padded.slice(0, 3)).toEqual(input);
    expect(padded.slice(3)).toEqual(["│    │", "│    │", "│    │"]);
  });

  it("returns input unchanged when input already exceeds target", () => {
    const input = Array.from({ length: 25 }, (_, i) => `row${i}`);
    const padded = padDashboardToHeight(input, 20, 4);
    expect(padded).toEqual(input);
    expect(padded).toHaveLength(25);
  });

  it("returns input unchanged when target is non-positive", () => {
    const input = ["a", "b"];
    expect(padDashboardToHeight(input, 0, 4)).toEqual(input);
    expect(padDashboardToHeight(input, -5, 4)).toEqual(input);
  });

  it("emits a single-space row when innerWidth is 0", () => {
    const padded = padDashboardToHeight(["a"], 3, 0);
    expect(padded).toHaveLength(3);
    expect(padded[1]).toBe("│ │");
  });
});

describe("wrapStreamChunk", () => {
  it("returns short text unchanged", () => {
    expect(wrapStreamChunk("hello world", 20)).toBe("hello world");
  });

  it("word-wraps a line longer than width", () => {
    const out = wrapStreamChunk("alpha beta gamma delta epsilon zeta", 12);
    const lines = out.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
    expect(lines.join(" ").split(/\s+/).filter(Boolean).join(" "))
      .toBe("alpha beta gamma delta epsilon zeta");
  });

  it("hard-wraps a single token longer than width", () => {
    const out = wrapStreamChunk("a".repeat(20), 5);
    const lines = out.split("\n");
    expect(lines).toEqual(["aaaaa", "aaaaa", "aaaaa", "aaaaa"]);
  });

  it("preserves newlines and wraps each line independently", () => {
    const out = wrapStreamChunk("first line here\nsecond line here\nthird", 8);
    const lines = out.split("\n");
    // Each line wraps to multiple rows because they're all over width=8.
    // Spec contract is: row count ≥ number of input lines, no line exceeds width.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(8);
    }
  });

  it("emits empty string for whitespace-only and empty lines (preserves row count)", () => {
    expect(wrapStreamChunk("", 20)).toBe("");
    expect(wrapStreamChunk("   ", 20)).toBe("");
    expect(wrapStreamChunk("a\n   \nb", 20)).toBe("a\n\nb");
  });

  it("passes through text unchanged when width is 0", () => {
    expect(wrapStreamChunk("long line here", 0)).toBe("long line here");
  });
});
