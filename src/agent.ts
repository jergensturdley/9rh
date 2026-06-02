import OpenAI from "openai";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { dirname, join, resolve as resolvePath } from "path";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from "openai/resources/chat/completions.js";
import type { Stream } from "openai/streaming.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { compressToolResultForContext } from "./contextCompression.js";
import { buildLongHorizonMemory, renderLongHorizonMemory } from "./longHorizonMemory.js";
import { CircuitBreaker } from "./repair/circuitBreaker.js";
import {
  withErrorInterception,
  captureSnapshot,
  restoreSnapshot,
  runRepairAgent,
  logIncident,
  type AgentState,
  type TaggedError,
  ErrorClass,
} from "./repair/index.js";
import { EventLogger, type EventLoggerConfig } from "./replay/eventLogger.js";
import type {
  RunMetadata,
  ReplayEvent,
  ToolCallEvent,
  ToolResultEvent,
  LLMResponseEvent,
} from "./replay/eventSchema.js";
import { Reasoner } from "./reasoner/reasoner.js";
import { createExecutor, ObservabilityCollector, isSandboxAvailable } from "./sandbox/index.js";
import type { SandboxProvider } from "./sandbox/index.js";
import { formatSpecDrivenPrompt, shouldUseSpecDrivenTesting } from "./spec/specDrivenTesting.js";
import { renderRunReport, type RunReportData, type RunStatus } from "./reports/index.js";

const execFileAsync = promisify(execFile);

export interface AgentConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  workDir: string;
  systemPrompt?: string;
  onEvent?: (event: AgentEvent) => void;
  compactAfter?: number;
  replay?: ReplayConfig;
  specDrivenTesting?: boolean;
  continuationPolicy?: ContinuationPolicy;
  /** Maximum wall-clock time in milliseconds for a single `run()` call. Exceeding it aborts gracefully. */
  timeoutMs?: number;
  /**
   * If set, the agent writes a self-contained HTML report at this path on
   * the `done` event. Default: `~/.9rh/last-run.html`. The directory is
   * created if missing. Set to `false` to disable reports. If `keepReports`
   * is true, the default becomes `~/.9rh/reports/run-<runId>.html`.
   */
  reportPath?: string | false;
  /**
   * If true, the report filename includes the runId so each turn is preserved
   * instead of overwritten. Default false (last run only).
   */
  keepReports?: boolean;
}

export interface ContinuationPolicy {
  maxContinuations: number;
  iterationsPerContinuation?: number;
  modelSwitch?: ContinuationModelSwitch;
}

export interface ContinuationModelSwitch {
  toModel: string;
  afterContinuations?: number;
}

export interface ReplayConfig {
  enabled: boolean;
  runId?: string;
  branchId?: string;
  logDir?: string;
  checkpointDir?: string;
  onReplayEvent?: (event: ReplayEvent) => void;
}

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string; error?: string }
  | { type: "done"; text: string; reportPath?: string }
  | { type: "error"; message: string; reportPath?: string }
  | { type: "iteration"; current: number; max: number }
  | { type: "compact"; summary: string }
  | { type: "continuation"; count: number; max: number }
  | { type: "model_switch"; from: string; to: string; reason: "continuation" }
  | { type: "repair_start"; message: string; attempt: number }
  | { type: "repair_success"; message: string }
  | { type: "escalate"; message: string }
  | { type: "circuit_open" }
  | { type: "replay_event"; event: ReplayEvent }
  | { type: "spec_plan"; summary: string }
  | { type: "step_inspect"; stepId: string; params?: string; output?: string; diff?: string; trace?: string; policy?: string }
  | { type: "partial_output"; stepId: string; text: string }
  | { type: "incident"; stepId: string; cause: string; repairAttempt?: number; circuitOpen?: boolean }
  | { type: "branch_create"; stepId: string; branchId: string; reason: string }
  | { type: "sandbox_health"; total: number; sandboxed: number; direct: number; timedOut: number };

const DEFAULT_SYSTEM = `You are a skilled coding agent. You help with coding tasks by reading, writing, and modifying files, running commands, and solving problems step by step.

Guidelines:
- Break complex tasks into steps
- Read files before modifying them
- Run tests after making changes
- Be concise in explanations
- If CodeGraph tools are available, prefer codegraph_context/codegraph_search/codegraph_files for codebase discovery before broad grep/list/read exploration
- When done, summarize what you accomplished`;

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && err.message?.includes("Interrupted by user")) return true;
  return false;
}

export class Agent {
  private client: OpenAI;
  private config: AgentConfig;
  private messages: ChatCompletionMessageParam[] = [];
  private compactThreshold: number;
  private circuitBreaker: CircuitBreaker;
  private currentTask: string = "";
  private stepIndex: number = 0;
  private compactCount: number = 0;
  private replay: ReplayConfig;
  private eventLogger: EventLogger | null = null;
  private reasoner: Reasoner;
  private executor: SandboxProvider;
  private observer: ObservabilityCollector;
  private activeModel: string | undefined;
  private toolArgsJsonCache = new WeakMap<Record<string, unknown>, string>();
  private recentToolHistory: string[] = [];
  private abortController: AbortController = new AbortController();
  private stopFlag: boolean = false;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private replayFinalized: boolean = false;
  // Report-data collection (built incrementally; written to disk on done).
  private report: RunReportData | null = null;
  private reportStartMs: number = 0;
  private tokenUsage: { prompt: number; completion: number; total: number } | undefined = undefined;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    this.compactThreshold = config.compactAfter ?? 20;
    this.circuitBreaker = new CircuitBreaker(3, 60_000);
    this.replay = config.replay ?? { enabled: false };
    this.reasoner = new Reasoner({
      emitPlans: true,
      emitSummaries: true,
      onReasoningEvent: (event) => this.eventLogger?.log(event as Omit<ReplayEvent, "seq" | "ts">),
    });
    this.executor = createExecutor(config.workDir, { useSandbox: true });
    this.observer = new ObservabilityCollector();
  }

  /** Abort current run immediately — cancels in-flight stream, breaks loop. */
  abort(): void {
    this.stopFlag = true;
    this.abortController.abort(new Error("Interrupted by user"));
  }

  /** Request graceful stop after current tool call completes. */
  requestStop(): void {
    this.stopFlag = true;
  }

  private emit(event: AgentEvent): void {
    this.config.onEvent?.(event);
  }

  private currentModel(): string {
    return this.activeModel ?? this.config.model;
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

    const memory = buildLongHorizonMemory(historyText, `agent-run:${this.currentTask.slice(0, 48) || "unknown"}`);
    const memorySummary = renderLongHorizonMemory(memory);

    const repoState = await this.collectRepoState();
    const recentToolHistory = this.recentToolHistory.length > 0
      ? this.recentToolHistory.join("\n")
      : "No tool calls recorded yet.";

    const compactPrompt =
      `Compress the conversation for a long-running coding agent into a structured continuation packet. Preserve exact file names, function names, schema terms, API routes, decisions, unresolved blockers, and test status. Do not rely on vague phrasing like "continue work". If any fact is uncertain, mark it for reconfirmation rather than stating it as fact.\n\nReturn markdown with exactly these sections:\n# Continuation Packet\n## Original task\n## Current objective\n## Completed steps\n## Pending steps\n## Files modified or inspected\n## Commands and tests run\n## Known failures or blockers\n## Important exact outputs\n## Repository state\n## Recent tool history\n## Next action\n\nRepository state captured from disk:\n${repoState}\n\nRecent tool history captured by harness:\n${recentToolHistory}\n\nConversation history to compress:\n${historyText}\n\nStructured continuation packet:`;

    const response = await this.client.chat.completions.create(
      {
        model: this.currentModel(),
        messages: [{ role: "user", content: compactPrompt }],
      },
      { signal: this.abortController.signal },
    );

    const llmSummary = response.choices[0]?.message?.content ?? "Work in progress";
    return `${llmSummary}\n\n## Long-horizon memory\n${memorySummary}`;
  }

  private async collectRepoState(): Promise<string> {
    const commands: Array<{ label: string; args: string[] }> = [
      { label: "git status --short", args: ["status", "--short"] },
      { label: "git diff --stat", args: ["diff", "--stat"] },
      { label: "git diff --name-only", args: ["diff", "--name-only"] },
    ];
    const sections: string[] = [];
    for (const command of commands) {
      try {
        const { stdout, stderr } = await execFileAsync("git", command.args, {
          cwd: this.config.workDir,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
        const output = `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
        sections.push(`### ${command.label}\n${output || "(clean / no output)"}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sections.push(`### ${command.label}\n(unavailable: ${message})`);
      }
    }
    return sections.join("\n\n");
  }

  private rememberToolHistory(line: string): void {
    const normalized = line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line;
    this.recentToolHistory.push(normalized);
    this.recentToolHistory = this.recentToolHistory.slice(-30);
  }

  private resetForContinuation(summary: string, originalTask: string): void {
    this.messages = [
      {
        role: "system",
        content: this.config.systemPrompt ?? DEFAULT_SYSTEM,
      },
      {
        role: "user",
        content: `Continue the original task using this structured continuation packet as authoritative state. Reconfirm uncertain facts from the repository before acting.\n\n${summary}\n\nOriginal task: ${originalTask}`,
      },
    ];
  }

  private applyContinuationModelSwitch(continuationCount: number): void {
    const modelSwitch = this.config.continuationPolicy?.modelSwitch;
    if (!modelSwitch) return;
    const triggerCount = modelSwitch.afterContinuations ?? 1;
    if (continuationCount < triggerCount) return;
    const from = this.currentModel();
    if (from === modelSwitch.toModel) return;
    this.activeModel = modelSwitch.toModel;
    this.emit({ type: "model_switch", from, to: modelSwitch.toModel, reason: "continuation" });
  }

  private buildAgentState(): AgentState {
    return {
      currentTask: this.currentTask,
      memory: {},
      toolCallHistory: [],
      stepIndex: this.stepIndex,
      environmentVars: {},
    };
  }

  private stepContext() {
    return { stepIndex: this.stepIndex, iteration: this.stepIndex, compactCount: this.compactCount };
  }

  private stringifyToolArgs(args: Record<string, unknown>): string {
    const cached = this.toolArgsJsonCache.get(args);
    if (cached) return cached;
    const value = JSON.stringify(args);
    this.toolArgsJsonCache.set(args, value);
    return value;
  }

  private async initReplay(task: string): Promise<void> {
    if (!this.replay.enabled) return;
    const runId = this.replay.runId ?? generateId();
    const branchId = this.replay.branchId ?? generateId();
    const cfg: EventLoggerConfig = {
      runId,
      branchId,
      logDir: this.replay.logDir ?? "./logs/runs",
    };
    this.eventLogger = new EventLogger(cfg);
    await this.eventLogger.init();
    const meta: RunMetadata = {
      runId,
      branchId,
      model: this.currentModel(),
      modelParams: { temperature: 0.3 },
      workDir: this.config.workDir,
      environmentVars: {},
      nodeVersion: process.version,
      packageVersions: {},
      timestamp: Date.now(),
    };
    this.eventLogger.log({ type: "run_start", payload: meta });
  }

  private logReplay(event: {
    type: string;
    step?: { stepIndex: number; iteration: number; compactCount: number };
    payload: Record<string, unknown>;
  }): void {
    this.eventLogger?.log(event as Omit<ReplayEvent, "seq" | "ts">);
    this.emit({ type: "replay_event", event: event as unknown as ReplayEvent });
  }

  /**
   * Render the run report to HTML and write it to disk. Returns the absolute
   * path written, or undefined if reports are disabled or the write failed.
   *
   * Best-effort: errors during write are swallowed (logged via stderr) so
   * the agent run is never blocked by a report problem.
   */
  private async writeRunReport(status: RunStatus): Promise<string | undefined> {
    if (!this.report) return undefined;
    if (this.config.reportPath === false || this.config.reportPath === "") return undefined;

    // Determine the final path. If keepReports is true, embed the runId.
    const defaultPath = `~/.9rh/last-run.html`.replace("~", homedir());
    let finalPath: string;
    if (this.config.reportPath) {
      finalPath = this.config.reportPath;
    } else if (this.config.keepReports) {
      const dir = join(homedir(), ".9rh", "reports");
      finalPath = join(dir, `run-${this.report.runId}.html`);
    } else {
      finalPath = defaultPath;
    }
    finalPath = finalPath.replace(/^~/, homedir());

    // Finalize the report data.
    this.report.endedAt = Date.now();
    this.report.durationMs = this.report.endedAt - this.reportStartMs;
    this.report.steps = this.stepIndex;
    this.report.compactionCount = this.compactCount;
    this.report.status = status;
    if (this.tokenUsage) this.report.tokenUsage = this.tokenUsage;
    if (this.replay.enabled) {
      this.report.replayLogPath = this.replay.logDir
        ? join(this.replay.logDir, this.replay.runId ?? this.report.runId, "events.jsonl")
        : undefined;
    }

    try {
      await mkdir(dirname(finalPath), { recursive: true });
      const html = renderRunReport(this.report);
      const { writeFile } = await import("fs/promises");
      await writeFile(finalPath, html, "utf-8");
      return finalPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[9rh] failed to write run report: ${msg}\n`);
      return undefined;
    }
  }

  private async finalizeReplay(reason: string): Promise<void> {
    if (this.replayFinalized) return;
    this.replayFinalized = true;
    if (!this.eventLogger) return;
    const runId = this.replay.runId ?? "";
    await this.eventLogger.finalize(runId, reason);
  }

  private async runRepair(
    tagged: TaggedError,
    attempt: number,
    toolName?: string,
    toolInput?: Record<string, unknown>,
    toolOutput?: string
  ): Promise<{ escalate: boolean; userMessage: string }> {
    const agentState = this.buildAgentState();
    const ctx = {
      error: tagged,
      agentState,
      attemptNumber: attempt,
      toolName,
      toolInput,
      toolOutput,
      lastSuccessfulStep: this.stepIndex,
      previousAttempts: [],
      openaiClient: this.client,
      model: this.currentModel(),
    };

    const startMs = Date.now();
    const result = await runRepairAgent(ctx);
    const durationMs = Date.now() - startMs;

    if (result.success) {
      const outcome = result.escalate ? "ESCALATED" : "REPAIRED";
      await logIncident(tagged, attempt, outcome, durationMs, result.userMessage);
      this.emit({ type: "repair_success", message: result.userMessage });
      if (this.report) {
        this.report.repairs.push({
          step: this.stepIndex,
          attempt,
          outcome: outcome === "REPAIRED" ? "REPAIRED" : "ESCALATED",
          message: result.userMessage,
          timestamp: Date.now(),
        });
      }
      return { escalate: false, userMessage: result.userMessage };
    }

    await logIncident(tagged, attempt, "ESCALATED", durationMs, result.userMessage);
    this.emit({ type: "escalate", message: result.userMessage });
    if (this.report) {
      this.report.repairs.push({
        step: this.stepIndex,
        attempt,
        outcome: "ESCALATED",
        message: result.userMessage,
        timestamp: Date.now(),
      });
    }
    return { escalate: true, userMessage: result.userMessage };
  }

  private async executeToolWithRepair(
    name: string,
    args: Record<string, unknown>,
    callId: string
  ): Promise<{ output: string; error?: string }> {
    const executor = this.executor;
    const observer = this.observer;
    const startMs = Date.now();

    // For write_file, capture the file's content before the call so the
    // run report can show a real before/after diff. Failures here must
    // not block the tool — the snapshot is best-effort.
    let beforeSnapshot: string | null = null;
    let beforePath: string | null = null;
    if (name === "write_file" && typeof args.path === "string") {
      beforePath = await this.safeResolveInsideWorkDir(args.path);
      if (beforePath) {
        beforeSnapshot = await this.tryReadFile(beforePath);
      }
    }

    const wrapped = async () => {
      return executeTool(name, args, this.config.workDir, {
        executor,
        onBashResult: (result, command) => observer.record(result, command),
      });
    };

    const result = await withErrorInterception(wrapped, {
      sourceLayer: "tool",
      onRepairTriggered: async (tagged, attempt) => {
        this.emit({ type: "repair_start", message: tagged.message, attempt });
        const { escalate, userMessage } = await this.runRepair(
          tagged,
          attempt,
          name,
          args
        );
        if (escalate) {
          this.emit({ type: "escalate", message: userMessage });
          throw new Error(`[repair] ${userMessage}`);
        }
      },
      repairAgent: async (tagged, attempt) => {
        this.emit({ type: "repair_start", message: tagged.message, attempt });
        const repairResult = await this.runRepair(tagged, attempt, name, args);
        if (repairResult.escalate) {
          return { success: false, snapshotId: undefined, userMessage: repairResult.userMessage, escalate: true };
        }
        return { success: true, snapshotId: undefined, userMessage: repairResult.userMessage, escalate: false };
      },
      circuitBreaker: {
        isOpen: () => this.circuitBreaker.isOpen(),
        recordFailure: (ec) => this.circuitBreaker.recordFailure(ec),
        recordSuccess: () => this.circuitBreaker.recordSuccess(),
      },
    });

    // Record the file change (after the tool ran) for the report.
    if (name === "write_file" && beforePath && !result.error) {
      const after = await this.tryReadFile(beforePath);
      if (after !== null) {
        this.recordFileChange({
          step: this.stepIndex,
          path: beforePath,
          operation: beforeSnapshot === null ? "create" : "edit",
          before: beforeSnapshot ?? undefined,
          after,
        });
      }
    }

    return result;
  }

  /**
   * Resolve a relative path against the workDir and verify it doesn't escape.
   * Returns null if the path can't be safely resolved. This is intentionally
   * permissive — we never *block* a tool call based on this; the real
   * sandboxing happens inside `tools.ts`.
   */
  private async safeResolveInsideWorkDir(p: string): Promise<string | null> {
    try {
      const workDir = resolvePath(this.config.workDir);
      const abs = resolvePath(workDir, p);
      // Light sanity check: must start with workDir + "/"
      if (!abs.startsWith(workDir + "/") && abs !== workDir) return null;
      return abs;
    } catch {
      return null;
    }
  }

  private async tryReadFile(absPath: string): Promise<string | null> {
    try {
      return await readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  private recordFileChange(c: {
    step: number;
    path: string;
    operation: "create" | "edit";
    before?: string;
    after: string;
  }): void {
    if (!this.report) return;
    const MAX_FIELD = 32_000; // ~32KB per field
    let before = c.before;
    let after = c.after;
    let beforeTruncated: boolean | undefined;
    let afterTruncated: boolean | undefined;
    if (before !== undefined && before.length > MAX_FIELD) {
      before = before.slice(0, MAX_FIELD);
      beforeTruncated = true;
    }
    if (after.length > MAX_FIELD) {
      after = after.slice(0, MAX_FIELD);
      afterTruncated = true;
    }
    this.report.fileChanges.push({
      step: c.step,
      path: c.path,
      operation: c.operation,
      before,
      after,
      beforeTruncated,
      afterTruncated,
    });
  }

  async run(task: string): Promise<string> {
    // Reset abort controller and stop flag for each run
    this.abortController = new AbortController();
    this.stopFlag = false;
    this.replayFinalized = false;
    this.timeoutTimer = null;
    this.tokenUsage = undefined;

    const useSpecDrivenTesting = this.config.specDrivenTesting !== false && shouldUseSpecDrivenTesting(task);
    const taskForAgent = useSpecDrivenTesting ? formatSpecDrivenPrompt(task) : task;

    this.currentTask = task;
    this.activeModel = this.config.model;
    this.stepIndex = 0;
    this.compactCount = 0;
    this.recentToolHistory = [];
    this.messages = [];
    this.reasoner.reset();
    this.reportStartMs = Date.now();
    this.report = {
      runId: this.replay.runId ?? generateId(),
      task,
      startedAt: this.reportStartMs,
      endedAt: 0,
      durationMs: 0,
      model: this.config.model,
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

    // Set up wall-clock timeout
    if (this.config.timeoutMs && this.config.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        this.emit({ type: "error", message: `Agent timed out after ${this.config.timeoutMs}ms` });
        this.abortController.abort(new Error(`Agent timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
    }

    let finalResponse = "";

    try {
      await this.initReplay(task);

      if (useSpecDrivenTesting) {
        this.emit({ type: "spec_plan", summary: taskForAgent });
        this.logReplay({
          type: "spec_plan",
          step: this.stepContext(),
          payload: {
            originalTask: task,
            summary: taskForAgent,
          },
        });
      }

      this.messages = [
        {
          role: "system",
          content: this.config.systemPrompt ?? DEFAULT_SYSTEM,
        },
        {
          role: "user",
          content: taskForAgent,
        },
      ];

      let continuationCount = 0;
      const maxContinuations = this.config.continuationPolicy?.maxContinuations ?? 0;

      while (true) {
        const iterLimit =
          continuationCount === 0
            ? this.config.maxIterations
            : (this.config.continuationPolicy?.iterationsPerContinuation ?? this.config.maxIterations);

        for (let iteration = 1; iteration <= iterLimit; iteration++) {
          // Check for graceful stop request between iterations
          if (this.stopFlag) {
            this.emit({ type: "done", text: finalResponse || "Stopped by user request" });
            this.logReplay({
              type: "run_end",
              payload: { runId: this.replay.runId ?? "", reason: "stopped" },
            });
            await this.finalizeReplay("stopped");
            return finalResponse || "Stopped by user request";
          }

          if (this.circuitBreaker.isOpen()) {
            this.emit({ type: "circuit_open" });
            throw new Error("Circuit breaker is OPEN — halting agent loop");
          }

          this.stepIndex++;

          this.logReplay({
            type: "step_start",
            step: this.stepContext(),
            payload: {},
          });

          const snapshotId = await captureSnapshot(this.buildAgentState());
          this.logReplay({
            type: "checkpoint",
            step: this.stepContext(),
            payload: {
              snapshotId,
              workDirGitCommit: "",
              workDirGitHash: "",
              messageCount: this.messages.length,
              reason: "periodic",
            },
          });

          this.emit({ type: "iteration", current: iteration, max: iterLimit });
          this.emit({ type: "sandbox_health", ...this.observer.getSummary() });

          if (this.shouldCompact()) {
            const summary = await this.compactContext();
            this.compactCount++;
            if (this.report) {
              this.report.compactions.push({
                step: this.stepIndex,
                summary: summary.replace(/\s+/g, " ").trim().slice(0, 280),
                timestamp: Date.now(),
              });
            }
            this.emit({ type: "compact", summary });
            this.resetForContinuation(summary, taskForAgent);
            this.logReplay({
              type: "compact",
              step: this.stepContext(),
              payload: {
                messageCountBefore: this.messages.length + 1,
                messageCountAfter: 2,
                summary,
              },
            });
          }

          const { text, toolCalls } = await this.streamCompletionWithReplay();

          if (text) finalResponse = text;
          // Record the model's reasoning text for the report.
          if (text && this.report) {
            this.report.reasoning.push({ step: this.stepIndex, text, timestamp: Date.now() });
          }

          if (!toolCalls || toolCalls.length === 0) {
            const reportPath = await this.writeRunReport("completed");
            this.emit({ type: "done", text, reportPath });
            this.logReplay({
              type: "step_end",
              step: this.stepContext(),
              payload: { stepIndex: this.stepIndex },
            });
            this.logReplay({
              type: "run_end",
              payload: { runId: this.replay.runId ?? "", reason: "completed" },
            });
            await this.finalizeReplay("completed");
            return text;
          }

          const parsedToolCalls = toolCalls.map((tc) => {
            let args: Record<string, unknown> = {};
            let parseError: string | undefined;
            try {
              const parsed = JSON.parse(tc.argsRaw) as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              } else {
                parseError = `Tool arguments must be a JSON object: ${tc.argsRaw}`;
              }
            } catch {
              parseError = `Invalid tool arguments JSON: ${tc.argsRaw}`;
            }
            return { ...tc, args, parseError };
          });

          this.messages.push({
            role: "assistant",
            content: text || null,
            tool_calls: parsedToolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.parseError ? "{}" : this.stringifyToolArgs(tc.args) },
            })),
          });

          for (const tc of parsedToolCalls) {
            if (tc.parseError) {
              this.emit({ type: "tool_result", name: tc.name, output: "", error: tc.parseError });
              if (this.report) {
                this.report.toolCalls.push({
                  step: this.stepIndex,
                  name: tc.name,
                  args: {},
                  error: tc.parseError,
                  timestamp: Date.now(),
                });
              }
              this.messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: `ERROR: ${tc.parseError}`,
              });
              continue;
            }

            const callTimestamp = Date.now();
            this.emit({ type: "tool_call", name: tc.name, args: tc.args });
            this.rememberToolHistory(`CALL ${tc.name} ${this.stringifyToolArgs(tc.args)}`);

            const tcEvent: Omit<ToolCallEvent, "seq" | "ts"> = {
              type: "tool_call",
              step: this.stepContext(),
              payload: { toolName: tc.name, args: tc.args, callId: tc.id },
            };
            this.logReplay(tcEvent as ToolCallEvent);

            this.reasoner.plan({
              callId: tc.id,
              toolName: tc.name,
              args: tc.args,
              goal: this.currentTask,
              currentStep: `Step ${this.stepIndex}: call ${tc.name}`,
              assumptions: [],
              expectedOutcome: `execute ${tc.name} with provided args`,
              stepContext: this.stepContext(),
            });

            const startMs = Date.now();
            const result = await this.executeToolWithRepair(tc.name, tc.args, tc.id);
            const durationMs = Date.now() - startMs;
            const resultPreview = result.error ? `ERROR: ${result.error}` : result.output;
            this.rememberToolHistory(`RESULT ${tc.name} (${durationMs}ms) ${resultPreview}`);

            // Record the tool call + result for the report.
            if (this.report) {
              this.report.toolCalls.push({
                step: this.stepIndex,
                name: tc.name,
                args: tc.args,
                output: result.error ? undefined : result.output,
                error: result.error,
                durationMs,
                timestamp: callTimestamp,
              });
            }

            this.emit({
              type: "tool_result",
              name: tc.name,
              output: result.output,
              error: result.error,
            });

            this.reasoner.summarize({
              callId: tc.id,
              observedOutcome: result.error ? `ERROR: ${result.error}` : result.output,
              nextAction: `Continue to next step or finish`,
              corrected: false,
              stepContext: this.stepContext(),
            });

            const trEvent: Omit<ToolResultEvent, "seq" | "ts"> = {
              type: "tool_result",
              step: this.stepContext(),
              payload: {
                toolName: tc.name,
                callId: tc.id,
                output: result.output,
                error: result.error,
                durationMs,
              },
            };
            this.logReplay(trEvent as ToolResultEvent);

            const contextResult = compressToolResultForContext(tc.name, result.output, result.error);
            if (contextResult.changed) {
              this.emit({
                type: "compact",
                summary: `tool result ${tc.name} compacted for context: ${contextResult.originalChars.toLocaleString()} → ${contextResult.text.length.toLocaleString()} chars`,
              });
            }

            this.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: contextResult.text,
            });
          }

          this.logReplay({
            type: "step_end",
            step: this.stepContext(),
            payload: { stepIndex: this.stepIndex },
          });
        }

        if (continuationCount >= maxContinuations) {
          const suffix = continuationCount > 0 ? ` after ${continuationCount} continuation(s)` : "";
          const exhaustedMsg = `Reached max iterations (${this.config.maxIterations})${suffix}`;
          if (this.report) {
            this.report.errors.push({ step: this.stepIndex, message: exhaustedMsg, timestamp: Date.now() });
          }
          const reportPath = await this.writeRunReport("max_iterations");
          this.emit({ type: "error", message: exhaustedMsg, reportPath });
          this.logReplay({
            type: "run_end",
            payload: { runId: this.replay.runId ?? "", reason: "max_iterations" },
          });
          await this.finalizeReplay("max_iterations");
          throw new Error(exhaustedMsg);
        }

        continuationCount++;
        this.applyContinuationModelSwitch(continuationCount);
        const contSummary = await this.compactContext();
        this.compactCount++;
        if (this.report) {
          this.report.compactions.push({
            step: this.stepIndex,
            summary: contSummary.replace(/\s+/g, " ").trim().slice(0, 280),
            timestamp: Date.now(),
          });
        }
        this.emit({ type: "compact", summary: contSummary });
        this.emit({ type: "continuation", count: continuationCount, max: maxContinuations });
        this.resetForContinuation(contSummary, taskForAgent);
        this.logReplay({
          type: "compact",
          step: this.stepContext(),
          payload: {
            messageCountBefore: this.messages.length + 1,
            messageCountAfter: 2,
            summary: contSummary,
          },
        });
      }
    } catch (err: unknown) {
      // Distinguish abort/timeout from other errors for cleaner messaging
      if (isAbortError(err)) {
        const msg = this.abortController.signal.reason instanceof Error
          ? this.abortController.signal.reason.message
          : "Aborted by user";
        if (this.report) {
          this.report.errors.push({ step: this.stepIndex, message: msg, timestamp: Date.now() });
        }
        const reportPath = await this.writeRunReport("aborted");
        this.emit({ type: "error", message: msg, reportPath });
        this.emit({ type: "done", text: finalResponse || msg, reportPath });
        this.logReplay({
          type: "run_end",
          payload: { runId: this.replay.runId ?? "", reason: "aborted" },
        });
        await this.finalizeReplay("aborted");
        return finalResponse || msg;
      }

      // Ensure error event is always emitted before re-throwing
      const message = err instanceof Error ? err.message : String(err);
      if (this.report) {
        this.report.errors.push({ step: this.stepIndex, message, timestamp: Date.now() });
      }
      const reportPath = await this.writeRunReport("error");
      this.emit({ type: "error", message, reportPath });
      this.logReplay({
        type: "run_end",
        payload: { runId: this.replay.runId ?? "", reason: "error" },
      });
      await this.finalizeReplay("error");
      throw err;
    } finally {
      if (this.timeoutTimer !== null) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }
    }
  }

  private async streamCompletionWithReplay(): Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; argsRaw: string }> | null;
  }> {
    const maxRetries = 3;
    let lastError: string = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (this.abortController.signal.aborted) {
          throw new DOMException("Aborted by user", "AbortError");
        }
        const stream: Stream<ChatCompletionChunk> =
          await this.client.chat.completions.create(
            {
              model: this.currentModel(),
              messages: this.messages,
              tools: TOOL_DEFINITIONS as ChatCompletionTool[],
              tool_choice: "auto",
              stream: true,
              stream_options: { include_usage: true },
            },
            { signal: this.abortController.signal },
          );

        let text = "";
        const toolCallAccumulators: Map<
          number,
          { id: string; name: string; argsRaw: string }
        > = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
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

          // Token usage arrives in the final chunk (when stream_options.include_usage
          // is set, which we do above). Capture it for the run report.
          if (chunk.usage) {
            const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            this.tokenUsage = {
              prompt: u.prompt_tokens ?? 0,
              completion: u.completion_tokens ?? 0,
              total: u.total_tokens ?? 0,
            };
          }
        }

        const toolCalls =
          toolCallAccumulators.size > 0
            ? Array.from(toolCallAccumulators.entries())
                .sort(([a], [b]) => a - b)
                .map(([, v]) => v)
            : null;

        if (toolCalls) {
          this.logReplay({
            type: "llm_response",
            step: this.stepContext(),
            payload: {
              text,
              toolCalls,
              finishReason: "tool_calls",
            },
          });
        }

        return { text, toolCalls };

      } catch (err) {
        const error = err as { message?: string; code?: string };
        const errorMsg = error.message || String(err);
        lastError = errorMsg;

        // Abort/timeout must propagate immediately — never retry
        if (isAbortError(err)) {
          throw err;
        }

        const isRetryable =
          errorMsg.includes("500") ||
          errorMsg.includes("502") ||
          errorMsg.includes("503") ||
          errorMsg.includes("rate limit") ||
          errorMsg.includes("socket") ||
          errorMsg.includes("ECONNRESET") ||
          errorMsg.includes("ECONNREFUSED") ||
          errorMsg.includes("network") ||
          errorMsg.includes("premature close") ||
          errorMsg.includes("other side closed") ||
          errorMsg.includes("UND_ERR_PRE_CLOSE");

        const isProviderFunctionGone =
          errorMsg.includes("function") && (errorMsg.includes("not found") || errorMsg.includes("404"));

        if (isProviderFunctionGone) {
          this.emit({
            type: "error",
            message: `Provider function registry error: ${errorMsg}. The tool definition may be stale — try removing and re-adding the provider in 9router.`,
          });
          throw new Error(`Provider function error: ${errorMsg}`);
        }

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
