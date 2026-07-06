import { afterEach, describe, expect, it } from "@jest/globals";
import { readdir, rm } from "fs/promises";
import { join } from "path";
import OpenAI from "openai";
import { runRepairAgent, type RepairContext } from "../repairAgent.js";
import type { AgentState } from "../snapshotManager.js";
import type { TaggedError } from "../errorTaxonomy.js";

// runRepairAgent captures a snapshot to ./snapshots as a side effect.
// The dir is gitignored; clean the files after each test (keep .gitkeep).
afterEach(async () => {
  try {
    for (const f of await readdir("./snapshots")) {
      if (f !== ".gitkeep") await rm(join("./snapshots", f));
    }
  } catch {}
});

const AGENT_STATE: AgentState = {
  currentTask: "do the thing",
  memory: {},
  toolCallHistory: [],
  stepIndex: 0,
  environmentVars: {},
};

function mockClient(content: string): OpenAI {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
  } as unknown as OpenAI;
}

function throwingClient(message: string): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error(message);
        },
      },
    },
  } as unknown as OpenAI;
}

function llmJson(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    error_classification: "RECOVERABLE",
    root_cause: "rc",
    confidence: "MEDIUM",
    fix_applied: "f",
    validation_result: "PENDING",
    escalate: false,
    user_message: "human summary",
    ...over,
  });
}

function ctx(client: OpenAI, attemptNumber = 1): RepairContext {
  return {
    error: { errorClass: "RECOVERABLE", message: "boom", sourceLayer: "tool" } as unknown as TaggedError,
    agentState: AGENT_STATE,
    attemptNumber,
    model: "test-model",
    openaiClient: client,
  };
}

describe("runRepairAgent", () => {
  it("escalates when the LLM call throws", async () => {
    const r = await runRepairAgent(ctx(throwingClient("network down")));
    expect(r).toMatchObject({ success: false, escalate: true });
    expect(r.userMessage).toMatch(/LLM call failed.*network down/);
    expect(r.snapshotId).toMatch(/^snap-/);
  });

  it("escalates on an unparseable response", async () => {
    const r = await runRepairAgent(ctx(mockClient("sorry, no JSON for you")));
    expect(r).toMatchObject({ success: false, escalate: true });
    expect(r.userMessage).toMatch(/unparseable/);
  });

  it("auto-applies a HIGH-confidence non-escalating fix", async () => {
    const r = await runRepairAgent(ctx(mockClient(llmJson({ confidence: "HIGH", escalate: false, user_message: "patched it" }))));
    expect(r).toMatchObject({ success: true, escalate: false, userMessage: "patched it" });
  });

  it("escalates when the LLM sets escalate=true", async () => {
    const r = await runRepairAgent(ctx(mockClient(llmJson({ confidence: "LOW", escalate: true }))));
    expect(r).toMatchObject({ success: false, escalate: true });
  });

  it("escalates after the final attempt even without a HIGH fix", async () => {
    const r = await runRepairAgent(ctx(mockClient(llmJson({ confidence: "MEDIUM", escalate: false })), 3));
    expect(r).toMatchObject({ success: false, escalate: true });
  });

  it("returns a retryable result for a low-confidence early attempt", async () => {
    const r = await runRepairAgent(ctx(mockClient(llmJson({ confidence: "MEDIUM", escalate: false })), 1));
    expect(r).toMatchObject({ success: false, escalate: false });
  });
});
