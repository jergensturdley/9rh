import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from "openai/resources/chat/completions.js";
import type { Stream } from "openai/streaming.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";

export interface AgentConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  workDir: string;
  systemPrompt?: string;
  onEvent?: (event: AgentEvent) => void;
  compactAfter?: number;
}

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string; error?: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string }
  | { type: "iteration"; current: number; max: number }
  | { type: "compact"; summary: string };

const DEFAULT_SYSTEM = `You are a skilled coding agent. You help with coding tasks by reading, writing, and modifying files, running commands, and solving problems step by step.

Guidelines:
- Break complex tasks into steps
- Read files before modifying them
- Run tests after making changes
- Be concise in explanations
- When done, summarize what you accomplished`;

export class Agent {
  private client: OpenAI;
  private config: AgentConfig;
  private messages: ChatCompletionMessageParam[] = [];
  private compactThreshold: number;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    this.compactThreshold = config.compactAfter ?? 20;
  }

  private emit(event: AgentEvent): void {
    this.config.onEvent?.(event);
  }

  private shouldCompact(): boolean {
    return this.messages.length > this.compactThreshold;
  }

  private async compactContext(): Promise<string> {
    const historyText = this.messages
      .slice(1)
      .map((m) => {
        if (m.role === "user") return `User: ${m.content}`;
        if (m.role === "assistant") {
          const tc = (m as { tool_calls?: unknown[] }).tool_calls;
          if (tc?.length) {
            return `Assistant: called tools ${tc.map((t: unknown) => (t as { function: { name: string } }).function.name).join(", ")}`;
          }
          return `Assistant: ${(m.content as string) ?? ""}`;
        }
        if (m.role === "tool") return `Tool result: ${(m.content as string) ?? ""}`;
        return "";
      })
      .join("\n");

    const compactPrompt =
      `Summarize the conversation in 2-3 sentences. What task, what done, what next.\n\n${historyText}\n\nSummary:`;

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: [{ role: "user", content: compactPrompt }],
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content ?? "Work in progress";
  }

  private resetForContinuation(summary: string, originalTask: string): void {
    this.messages = [
      {
        role: "system",
        content: this.config.systemPrompt ?? DEFAULT_SYSTEM,
      },
      {
        role: "user",
        content: `RESUME: ${summary}\n\nOriginal task: ${originalTask}`,
      },
    ];
  }

  async run(task: string): Promise<string> {
    this.messages = [
      {
        role: "system",
        content: this.config.systemPrompt ?? DEFAULT_SYSTEM,
      },
      {
        role: "user",
        content: task,
      },
    ];

    let finalResponse = "";
    let compactCount = 0;

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      this.emit({ type: "iteration", current: iteration, max: this.config.maxIterations });

      if (this.shouldCompact()) {
        const summary = await this.compactContext();
        compactCount++;
        this.emit({ type: "compact", summary });
        this.resetForContinuation(summary, task);
      }

      const { text, toolCalls } = await this.streamCompletion();

      if (text) finalResponse = text;

      if (!toolCalls || toolCalls.length === 0) {
        this.emit({ type: "done", text });
        return text;
      }

      this.messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argsRaw },
        })),
      });

      for (const tc of toolCalls) {
        let args: Record<string, unknown>;
        let parseError: string | undefined;
        try {
          args = JSON.parse(tc.argsRaw) as Record<string, unknown>;
        } catch {
          parseError = `Invalid tool arguments JSON: ${tc.argsRaw}`;
          args = {};
        }

        if (parseError) {
          this.emit({ type: "tool_result", name: tc.name, output: "", error: parseError });
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `ERROR: ${parseError}`,
          });
          continue;
        }

        this.emit({ type: "tool_call", name: tc.name, args });

        const result = await executeTool(tc.name, args, this.config.workDir);

        this.emit({
          type: "tool_result",
          name: tc.name,
          output: result.output,
          error: result.error,
        });

        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.error
            ? `ERROR: ${result.error}\n${result.output}`
            : result.output,
        });
      }
    }

    const exhaustedMsg = `Reached max iterations (${this.config.maxIterations})`;
    this.emit({ type: "error", message: exhaustedMsg });
    throw new Error(exhaustedMsg);
  }

  private async streamCompletion(): Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; argsRaw: string }> | null;
  }> {
    const maxRetries = 3;
    let lastError: string = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const stream: Stream<ChatCompletionChunk> =
          await this.client.chat.completions.create({
            model: this.config.model,
            messages: this.messages,
            tools: TOOL_DEFINITIONS as ChatCompletionTool[],
            tool_choice: "auto",
            stream: true,
          });

        let text = "";
        const toolCallAccumulators: Map<
          number,
          { id: string; name: string; argsRaw: string }
        > = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            this.emit({ type: "thinking", text: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, {
                  id: tc.id ?? "",
                  name: "",
                  argsRaw: "",
                });
              }
              const acc = toolCallAccumulators.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.argsRaw += tc.function.arguments;
            }
          }
        }

        const toolCalls =
          toolCallAccumulators.size > 0
            ? Array.from(toolCallAccumulators.entries())
                .sort(([a], [b]) => a - b)
                .map(([, v]) => v)
            : null;

        return { text, toolCalls };

      } catch (err) {
        const error = err as { message?: string; code?: string };
        const errorMsg = error.message || String(err);
        lastError = errorMsg;

        const isRetryable =
          errorMsg.includes("500") ||
          errorMsg.includes("502") ||
          errorMsg.includes("503") ||
          errorMsg.includes("rate limit") ||
          errorMsg.includes("socket") ||
          errorMsg.includes("ECONNRESET") ||
          errorMsg.includes("ECONNREFUSED") ||
          errorMsg.includes("network");

        if (isRetryable && attempt < maxRetries) {
          const delayMs = attempt * 1000;
          this.emit({
            type: "tool_result",
            name: "openai_request",
            output: "",
            error: `API error (attempt ${attempt}/${maxRetries}): ${errorMsg}. Retrying in ${delayMs}ms...`,
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        this.emit({
          type: "error",
          message: `OpenAI API error: ${errorMsg}`,
        });
        throw new Error(`OpenAI API error: ${errorMsg}`);
      }
    }

    throw new Error(`OpenAI API error after ${maxRetries} retries: ${lastError}`);
  }
}
