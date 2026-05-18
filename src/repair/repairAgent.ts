import OpenAI from "openai";
import { readFile } from "fs/promises";
import type { AgentState } from "./snapshotManager.js";
import type { TaggedError } from "./errorTaxonomy.js";
import { captureSnapshot } from "./snapshotManager.js";

const PLAYBOOK_PATH = "./src/repair/repairPlaybook.json";

export interface PlaybookEntry {
  id: string;
  pattern: string;
  errorClass: string;
  suggestedFix: string;
  autoApply: boolean;
}

export interface RepairContext {
  error: TaggedError;
  agentState: AgentState;
  attemptNumber: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  lastSuccessfulStep?: number;
  previousAttempts?: string[];
  openaiClient: OpenAI;
  model: string;
}

export interface RepairResult {
  success: boolean;
  snapshotId?: string;
  userMessage: string;
  escalate: boolean;
}

async function loadPlaybook(): Promise<PlaybookEntry[]> {
  try {
    const raw = await readFile(PLAYBOOK_PATH, "utf-8");
    return JSON.parse(raw) as PlaybookEntry[];
  } catch {
    return [];
  }
}

function matchPlaybook(msg: string, entries: PlaybookEntry[]): PlaybookEntry | null {
  const lower = msg.toLowerCase();
  for (const entry of entries) {
    if (lower.includes(entry.pattern.toLowerCase())) {
      return entry;
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are a Repair Agent operating inside a coding agent harness. 
Your sole responsibility is to diagnose and fix harness-level errors. 
You are NOT here to complete the original task.

Rules:
1. Never modify the main agent's memory or task context
2. Never attempt more than ONE fix per repair cycle
3. Always check the harness before blaming user code
4. Explain reasoning before applying a fix
5. If ambiguous, ask ONE clarifying question
6. After 3 failed attempts, escalate

Always respond in this exact JSON format:
{
  "error_classification": "<RECOVERABLE|AGENT_ERROR|ENVIRONMENT_ERROR|FATAL>",
  "root_cause": "<one sentence>",
  "confidence": "<HIGH|MEDIUM|LOW>",
  "fix_applied": "<exact description>",
  "validation_result": "<PASSED|FAILED|PENDING>",
  "escalate": <true|false>,
  "user_message": "<plain language summary>"
}"`;

function buildUserPrompt(ctx: RepairContext, playbookMatch: PlaybookEntry | null): string {
  return `Error Type: ${ctx.error.errorClass}
Error Message: ${ctx.error.message}
Source Layer: ${ctx.error.sourceLayer}
Attempt: ${ctx.attemptNumber} of 3
Failed Tool: ${ctx.toolName ?? "N/A"}
Tool Input: ${ctx.toolInput ? JSON.stringify(ctx.toolInput) : "N/A"}
Tool Output: ${ctx.toolOutput ?? "N/A"}
Current Task: ${ctx.agentState.currentTask}
Last Good Step: ${ctx.lastSuccessfulStep ?? "unknown"}
Memory Usage: ${JSON.stringify(ctx.agentState.memory).slice(0, 200)}
Playbook Match: ${playbookMatch ? `${playbookMatch.pattern} → ${playbookMatch.suggestedFix}` : "none"}
Suggested Fix: ${playbookMatch?.suggestedFix ?? "none"}
Previous Attempts: ${ctx.previousAttempts?.join("; ") ?? "none"}`;
}

interface LLMResponse {
  error_classification: string;
  root_cause: string;
  confidence: string;
  fix_applied: string;
  validation_result: string;
  escalate: boolean;
  user_message: string;
}

function extractJSON(raw: string): LLMResponse | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as LLMResponse;
  } catch {
    return null;
  }
}

export async function runRepairAgent(ctx: RepairContext): Promise<RepairResult> {
  const playbook = await loadPlaybook();
  const playbookMatch = matchPlaybook(ctx.error.message, playbook);

  const snapshotId = await captureSnapshot(ctx.agentState);

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserPrompt(ctx, playbookMatch) },
  ];

  let llmResult: LLMResponse | null = null;

  try {
    const response = await ctx.openaiClient.chat.completions.create({
      model: ctx.model,
      messages,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    llmResult = extractJSON(raw);
  } catch (err) {
    return {
      success: false,
      snapshotId,
      userMessage: `Repair agent LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      escalate: true,
    };
  }

  if (!llmResult) {
    return {
      success: false,
      snapshotId,
      userMessage: "Repair agent returned unparseable response",
      escalate: true,
    };
  }

  const autoApply =
    (playbookMatch?.autoApply ?? false) || llmResult.confidence === "HIGH";

  if (autoApply && llmResult.escalate === false) {
    return {
      success: true,
      snapshotId,
      userMessage: llmResult.user_message,
      escalate: false,
    };
  }

  if (llmResult.escalate || ctx.attemptNumber >= 3) {
    return {
      success: false,
      snapshotId,
      userMessage: llmResult.user_message,
      escalate: true,
    };
  }

  return {
    success: false,
    snapshotId,
    userMessage: llmResult.user_message,
    escalate: false,
  };
}
