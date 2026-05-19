import { describe, expect, it } from "@jest/globals";
import { summarizeLiveModelInsight } from "../tui.js";

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
