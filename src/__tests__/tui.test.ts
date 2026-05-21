import { describe, expect, it } from "@jest/globals";
import { renderRecentTranscript, summarizeLiveModelInsight } from "../tui.js";

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
