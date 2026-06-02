import { describe, expect, it } from "@jest/globals";
import { renderRunReport, escapeHtml } from "../reports/runReport.js";
import type { RunReportData } from "../reports/runReportData.js";

function makeSampleData(overrides: Partial<RunReportData> = {}): RunReportData {
  return {
    runId: "test-run-001",
    task: "Refactor the auth module",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_123_456,
    durationMs: 123_456,
    model: "kr/claude-sonnet-4.5",
    backendName: "router",
    hasNativeRouter: true,
    status: "completed",
    steps: 5,
    compactionCount: 1,
    tokenUsage: { prompt: 1234, completion: 567, total: 1801 },
    toolCalls: [
      {
        step: 1,
        name: "read_file",
        args: { path: "src/auth.ts" },
        output: "export function login() { /* ... */ }",
        durationMs: 42,
        timestamp: 1_700_000_010_000,
      },
      {
        step: 2,
        name: "write_file",
        args: { path: "src/auth.ts", content: "new content" },
        output: "Written src/auth.ts",
        durationMs: 15,
        timestamp: 1_700_000_050_000,
      },
      {
        step: 3,
        name: "run_bash",
        args: { command: "npm test" },
        error: "exit non-zero",
        durationMs: 5000,
        timestamp: 1_700_000_080_000,
      },
    ],
    reasoning: [
      { step: 1, text: "First, let me look at the auth module.\n", timestamp: 1 },
      { step: 2, text: "Now I will refactor it to use JWT.", timestamp: 2 },
    ],
    fileChanges: [
      {
        step: 2,
        path: "src/auth.ts",
        operation: "edit",
        before: "export function login() { /* old */ }",
        after: "export function login() { /* new */ }",
      },
      {
        step: 4,
        path: "src/auth.test.ts",
        operation: "create",
        after: "test('login works', () => {});",
      },
    ],
    errors: [],
    repairs: [
      {
        step: 2,
        attempt: 1,
        outcome: "REPAIRED",
        message: "recovered from transient API error",
        timestamp: 3,
      },
    ],
    compactions: [
      {
        step: 3,
        summary: "tool result run_bash compacted for context: 12,000 → 800 chars",
        timestamp: 4,
      },
    ],
    ...overrides,
  };
}

describe("renderRunReport", () => {
  it("produces a valid HTML5 document", () => {
    const html = renderRunReport(makeSampleData());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");
  });

  it("includes the run id, task, model, and backend in the header", () => {
    const html = renderRunReport(makeSampleData());
    expect(html).toContain("test-run-001");
    expect(html).toContain("Refactor the auth module");
    expect(html).toContain("kr/claude-sonnet-4.5");
    expect(html).toContain("router");
  });

  it("renders the summary cards (status, duration, steps, tokens)", () => {
    const html = renderRunReport(makeSampleData());
    expect(html).toContain("completed");
    expect(html).toContain("2m 3s"); // 123,456ms formatted
    expect(html).toContain("5"); // steps
    expect(html).toContain("1.8k"); // total tokens
  });

  it("renders tool calls with ok/error tags", () => {
    const html = renderRunReport(makeSampleData());
    expect(html).toContain("read_file");
    expect(html).toContain("write_file");
    expect(html).toContain("run_bash");
    expect(html).toContain("exit non-zero");
  });

  it("renders file changes with before/after for edits and full content for creates", () => {
    const html = renderRunReport(makeSampleData());
    expect(html).toContain("src/auth.ts");
    expect(html).toContain("src/auth.test.ts");
    expect(html).toContain("created");
    expect(html).toContain("edited");
  });

  it("renders repairs and compactions", () => {
    const html = renderRunReport(makeSampleData());
    expect(html).toContain("recovered from transient API error");
    expect(html).toContain("repaired");
    expect(html).toContain("compacted for context");
  });

  it("HTML-escapes user-supplied strings (XSS safety)", () => {
    const evil = `<script>alert('xss')</script>`;
    const data = makeSampleData({
      task: evil,
      errors: [{ step: 1, message: evil, timestamp: 0 }],
    });
    const html = renderRunReport(data);
    expect(html).not.toContain(`<script>alert('xss')</script>`);
    expect(html).toContain(`&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;`);
  });

  it("HTML-escapes tool args and output", () => {
    const data = makeSampleData({
      toolCalls: [
        {
          step: 1,
          name: "search_files",
          args: { pattern: "<html>" },
          output: "matched <tag> & 'quoted' \"stuff\"",
          timestamp: 0,
        },
      ],
    });
    const html = renderRunReport(data);
    expect(html).toContain("&lt;html&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&quot;");
  });

  it("handles empty data gracefully (no crashes, sensible defaults)", () => {
    const data: RunReportData = {
      runId: "empty",
      task: "",
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
      model: "test",
      backendName: "router",
      hasNativeRouter: true,
      status: "completed",
      steps: 0,
      compactionCount: 0,
      toolCalls: [],
      reasoning: [],
      fileChanges: [],
      errors: [],
      repairs: [],
      compactions: [],
    };
    const html = renderRunReport(data);
    expect(html).toContain("empty");
    expect(html).toContain("no tool calls in this run");
    expect(html).toContain("no files modified in this run");
    expect(html).toContain("no errors");
    expect(html).toContain("no repair attempts");
    expect(html).toContain("no context compactions");
  });

  it("renders different status tags correctly", () => {
    for (const [status, expectedTag] of [
      ["completed", "completed"],
      ["aborted", "aborted"],
      ["max_iterations", "max iterations"],
      ["error", "error"],
    ] as const) {
      const html = renderRunReport(makeSampleData({ status }));
      expect(html).toContain(`class="tag ${status === "max_iterations" ? "warn" : status === "completed" ? "ok" : status === "error" ? "err" : "warn"}"`);
      expect(html).toContain(expectedTag);
    }
  });

  it("includes the replay log path when set", () => {
    const html = renderRunReport(makeSampleData({ replayLogPath: "./logs/runs/abc/events.jsonl" }));
    expect(html).toContain("./logs/runs/abc/events.jsonl");
  });

  it("renders reasoning text (inline when short, details when long)", () => {
    const shortHtml = renderRunReport(makeSampleData());
    expect(shortHtml).toContain("look at the auth module");
    expect(shortHtml).toContain("refactor it to use JWT");

    const longText = "x".repeat(2000);
    const longHtml = renderRunReport(makeSampleData({
      reasoning: [{ step: 1, text: longText, timestamp: 0 }],
    }));
    // Long reasoning should be folded into a <details> block.
    expect(longHtml).toContain("<details>");
    expect(longHtml).toContain("Full reasoning");
  });
});

describe("escapeHtml", () => {
  it("escapes the five required characters", () => {
    expect(escapeHtml(`<script>alert("x&y's")</script>`)).toBe(
      `&lt;script&gt;alert(&quot;x&amp;y&#39;s&quot;)&lt;/script&gt;`,
    );
  });

  it("leaves safe text alone", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("")).toBe("");
  });
});
