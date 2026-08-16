import { describe, expect, it, jest } from "@jest/globals";
import { resolveAskUserCall, type AskUserRequest, type AskUserResponse } from "../agent.js";
import { executeTool } from "../tools.js";
import type { ExecutionResult, SandboxProvider } from "../sandbox/index.js";

function stubExecutor(): SandboxProvider {
  const result: ExecutionResult = {
    output: "",
    error: undefined,
    exitCode: 0,
    signal: null,
    killed: false,
    timedOut: false,
    durationMs: 0,
    sandboxUsed: true,
    requestedTimeoutMs: 60_000,
    effectiveTimeoutMs: 60_000,
    clampedTimeout: false,
  };
  return {
    exec: jest.fn<SandboxProvider["exec"]>().mockResolvedValue(result),
    validatePath: jest.fn<SandboxProvider["validatePath"]>().mockResolvedValue("/safe/path"),
  };
}

describe("resolveAskUserCall", () => {
  it("returns the user's answer when the interactive callback answers", async () => {
    const result = await resolveAskUserCall(
      { question: "Which database?", options: ["postgres", "sqlite"] },
      async () => ({ answer: "sqlite" }),
    );
    expect(result.output).toBe("User answered: sqlite");
    expect(result.error).toBeUndefined();
    expect(result.assumption).toBeUndefined();
  });

  it("passes question, options, and free-text flag through to the callback", async () => {
    let seen: AskUserRequest | null = null;
    await resolveAskUserCall(
      { question: "Pick one", options: ["a", "b"], allow_free_text: false },
      async (req) => {
        seen = req;
        return { answer: "a" };
      },
    );
    expect(seen).toEqual({ question: "Pick one", options: ["a", "b"], allowFreeText: false });
  });

  it("records an assumption when the callback reports an assumed default", async () => {
    const result = await resolveAskUserCall(
      { question: "Deploy target?", options: ["staging", "prod"] },
      async (): Promise<AskUserResponse> => ({ answer: "staging", assumed: true }),
    );
    expect(result.output).toContain("Proceeding with the default: staging");
    expect(result.assumption).toBe('Deploy target? → assumed "staging"');
  });

  it("handles a dismissed question (empty answer) without an assumption", async () => {
    const result = await resolveAskUserCall(
      { question: "Sure?", options: ["yes"] },
      async () => ({ answer: "" }),
    );
    expect(result.output).toContain("dismissed the question");
    expect(result.assumption).toBeUndefined();
  });

  it("auto-selects the first option and records an assumption with no callback", async () => {
    const result = await resolveAskUserCall({
      question: "Which package manager?",
      options: ["npm", "pnpm"],
    });
    expect(result.output).toContain("auto-selected the first option: npm");
    expect(result.assumption).toBe('Which package manager? → assumed "npm"');
  });

  it("records a best-judgment assumption with no callback and no options", async () => {
    const result = await resolveAskUserCall({ question: "Anything to add?" });
    expect(result.output).toContain("no answer available");
    expect(result.assumption).toContain("model's best judgment");
  });

  it("rejects a missing or empty question", async () => {
    expect((await resolveAskUserCall({})).error).toContain("non-empty question");
    expect((await resolveAskUserCall({ question: "   " })).error).toContain("non-empty question");
  });

  it("ignores non-string entries in options", async () => {
    const result = await resolveAskUserCall({
      question: "Pick",
      options: ["ok", 42, "", null, "fine"],
    });
    expect(result.output).toContain("auto-selected the first option: ok");
  });
});

describe("ask_user via executeTool (defense in depth)", () => {
  it("refuses direct execution with a pointer to the agent loop", async () => {
    const result = await executeTool("ask_user", { question: "hi?" }, "/tmp", { executor: stubExecutor() });
    expect(result.error).toContain("agent loop");
  });

  it("still validates arguments at the boundary", async () => {
    const result = await executeTool("ask_user", { question: "" }, "/tmp", { executor: stubExecutor() });
    expect(result.error).toContain("Invalid tool arguments");
  });
});
