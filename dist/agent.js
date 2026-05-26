import OpenAI from "openai";
import { execFile } from "child_process";
import { promisify } from "util";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { compressToolResultForContext } from "./contextCompression.js";
import { buildLongHorizonMemory, renderLongHorizonMemory } from "./longHorizonMemory.js";
import { CircuitBreaker } from "./repair/circuitBreaker.js";
import { withErrorInterception, captureSnapshot, runRepairAgent, logIncident, } from "./repair/index.js";
import { EventLogger } from "./replay/eventLogger.js";
import { Reasoner } from "./reasoner/reasoner.js";
import { createExecutor, ObservabilityCollector } from "./sandbox/index.js";
import { formatSpecDrivenPrompt, shouldUseSpecDrivenTesting } from "./spec/specDrivenTesting.js";
const execFileAsync = promisify(execFile);
const DEFAULT_SYSTEM = `You are a skilled coding agent. You help with coding tasks by reading, writing, and modifying files, running commands, and solving problems step by step.

Guidelines:
- Break complex tasks into steps
- Read files before modifying them
- Run tests after making changes
- Be concise in explanations
- If CodeGraph tools are available, prefer codegraph_context/codegraph_search/codegraph_files for codebase discovery before broad grep/list/read exploration
- When done, summarize what you accomplished`;
function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function isAbortError(err) {
    if (err instanceof DOMException && err.name === "AbortError")
        return true;
    if (err instanceof Error && err.name === "AbortError")
        return true;
    if (err instanceof Error && err.message?.includes("Interrupted by user"))
        return true;
    return false;
}
export class Agent {
    client;
    config;
    messages = [];
    compactThreshold;
    circuitBreaker;
    currentTask = "";
    stepIndex = 0;
    compactCount = 0;
    replay;
    eventLogger = null;
    reasoner;
    executor;
    observer;
    activeModel;
    toolArgsJsonCache = new WeakMap();
    recentToolHistory = [];
    abortController = new AbortController();
    stopFlag = false;
    timeoutTimer = null;
    replayFinalized = false;
    constructor(config) {
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
            onReasoningEvent: (event) => this.eventLogger?.log(event),
        });
        this.executor = createExecutor(config.workDir, { useSandbox: true });
        this.observer = new ObservabilityCollector();
    }
    /** Abort current run immediately — cancels in-flight stream, breaks loop. */
    abort() {
        this.stopFlag = true;
        this.abortController.abort(new Error("Interrupted by user"));
    }
    /** Request graceful stop after current tool call completes. */
    requestStop() {
        this.stopFlag = true;
    }
    emit(event) {
        this.config.onEvent?.(event);
    }
    currentModel() {
        return this.activeModel ?? this.config.model;
    }
    shouldCompact() {
        return this.messages.length > this.compactThreshold;
    }
    async compactContext() {
        const historyText = this.messages
            .slice(1)
            .map((m) => {
            if (m.role === "user")
                return `User: ${m.content}`;
            if (m.role === "assistant") {
                const tc = m.tool_calls;
                if (tc?.length) {
                    return `Assistant: called tools ${tc.map((t) => t.function.name).join(", ")}`;
                }
                return `Assistant: ${m.content ?? ""}`;
            }
            if (m.role === "tool")
                return `Tool result: ${m.content ?? ""}`;
            return "";
        })
            .join("\n");
        const memory = buildLongHorizonMemory(historyText, `agent-run:${this.currentTask.slice(0, 48) || "unknown"}`);
        const memorySummary = renderLongHorizonMemory(memory);
        const repoState = await this.collectRepoState();
        const recentToolHistory = this.recentToolHistory.length > 0
            ? this.recentToolHistory.join("\n")
            : "No tool calls recorded yet.";
        const compactPrompt = `Compress the conversation for a long-running coding agent into a structured continuation packet. Preserve exact file names, function names, schema terms, API routes, decisions, unresolved blockers, and test status. Do not rely on vague phrasing like "continue work". If any fact is uncertain, mark it for reconfirmation rather than stating it as fact.\n\nReturn markdown with exactly these sections:\n# Continuation Packet\n## Original task\n## Current objective\n## Completed steps\n## Pending steps\n## Files modified or inspected\n## Commands and tests run\n## Known failures or blockers\n## Important exact outputs\n## Repository state\n## Recent tool history\n## Next action\n\nRepository state captured from disk:\n${repoState}\n\nRecent tool history captured by harness:\n${recentToolHistory}\n\nConversation history to compress:\n${historyText}\n\nStructured continuation packet:`;
        const response = await this.client.chat.completions.create({
            model: this.currentModel(),
            messages: [{ role: "user", content: compactPrompt }],
        }, { signal: this.abortController.signal });
        const llmSummary = response.choices[0]?.message?.content ?? "Work in progress";
        return `${llmSummary}\n\n## Long-horizon memory\n${memorySummary}`;
    }
    async collectRepoState() {
        const commands = [
            { label: "git status --short", args: ["status", "--short"] },
            { label: "git diff --stat", args: ["diff", "--stat"] },
            { label: "git diff --name-only", args: ["diff", "--name-only"] },
        ];
        const sections = [];
        for (const command of commands) {
            try {
                const { stdout, stderr } = await execFileAsync("git", command.args, {
                    cwd: this.config.workDir,
                    timeout: 5_000,
                    maxBuffer: 64 * 1024,
                });
                const output = `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
                sections.push(`### ${command.label}\n${output || "(clean / no output)"}`);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                sections.push(`### ${command.label}\n(unavailable: ${message})`);
            }
        }
        return sections.join("\n\n");
    }
    rememberToolHistory(line) {
        const normalized = line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line;
        this.recentToolHistory.push(normalized);
        this.recentToolHistory = this.recentToolHistory.slice(-30);
    }
    resetForContinuation(summary, originalTask) {
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
    applyContinuationModelSwitch(continuationCount) {
        const modelSwitch = this.config.continuationPolicy?.modelSwitch;
        if (!modelSwitch)
            return;
        const triggerCount = modelSwitch.afterContinuations ?? 1;
        if (continuationCount < triggerCount)
            return;
        const from = this.currentModel();
        if (from === modelSwitch.toModel)
            return;
        this.activeModel = modelSwitch.toModel;
        this.emit({ type: "model_switch", from, to: modelSwitch.toModel, reason: "continuation" });
    }
    buildAgentState() {
        return {
            currentTask: this.currentTask,
            memory: {},
            toolCallHistory: [],
            stepIndex: this.stepIndex,
            environmentVars: {},
        };
    }
    stepContext() {
        return { stepIndex: this.stepIndex, iteration: this.stepIndex, compactCount: this.compactCount };
    }
    stringifyToolArgs(args) {
        const cached = this.toolArgsJsonCache.get(args);
        if (cached)
            return cached;
        const value = JSON.stringify(args);
        this.toolArgsJsonCache.set(args, value);
        return value;
    }
    async initReplay(task) {
        if (!this.replay.enabled)
            return;
        const runId = this.replay.runId ?? generateId();
        const branchId = this.replay.branchId ?? generateId();
        const cfg = {
            runId,
            branchId,
            logDir: this.replay.logDir ?? "./logs/runs",
        };
        this.eventLogger = new EventLogger(cfg);
        await this.eventLogger.init();
        const meta = {
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
    logReplay(event) {
        this.eventLogger?.log(event);
        this.emit({ type: "replay_event", event: event });
    }
    async finalizeReplay(reason) {
        if (this.replayFinalized)
            return;
        this.replayFinalized = true;
        if (!this.eventLogger)
            return;
        const runId = this.replay.runId ?? "";
        await this.eventLogger.finalize(runId, reason);
    }
    async runRepair(tagged, attempt, toolName, toolInput, toolOutput) {
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
            return { escalate: false, userMessage: result.userMessage };
        }
        await logIncident(tagged, attempt, "ESCALATED", durationMs, result.userMessage);
        this.emit({ type: "escalate", message: result.userMessage });
        return { escalate: true, userMessage: result.userMessage };
    }
    async executeToolWithRepair(name, args, callId) {
        const executor = this.executor;
        const observer = this.observer;
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
                const { escalate, userMessage } = await this.runRepair(tagged, attempt, name, args);
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
        return result;
    }
    async run(task) {
        // Reset abort controller and stop flag for each run
        this.abortController = new AbortController();
        this.stopFlag = false;
        this.replayFinalized = false;
        this.timeoutTimer = null;
        const useSpecDrivenTesting = this.config.specDrivenTesting !== false && shouldUseSpecDrivenTesting(task);
        const taskForAgent = useSpecDrivenTesting ? formatSpecDrivenPrompt(task) : task;
        this.currentTask = task;
        this.activeModel = this.config.model;
        this.stepIndex = 0;
        this.compactCount = 0;
        this.recentToolHistory = [];
        this.messages = [];
        this.reasoner.reset();
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
                const iterLimit = continuationCount === 0
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
                    if (text)
                        finalResponse = text;
                    if (!toolCalls || toolCalls.length === 0) {
                        this.emit({ type: "done", text });
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
                        let args = {};
                        let parseError;
                        try {
                            const parsed = JSON.parse(tc.argsRaw);
                            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                                args = parsed;
                            }
                            else {
                                parseError = `Tool arguments must be a JSON object: ${tc.argsRaw}`;
                            }
                        }
                        catch {
                            parseError = `Invalid tool arguments JSON: ${tc.argsRaw}`;
                        }
                        return { ...tc, args, parseError };
                    });
                    this.messages.push({
                        role: "assistant",
                        content: text || null,
                        tool_calls: parsedToolCalls.map((tc) => ({
                            id: tc.id,
                            type: "function",
                            function: { name: tc.name, arguments: tc.parseError ? "{}" : this.stringifyToolArgs(tc.args) },
                        })),
                    });
                    for (const tc of parsedToolCalls) {
                        if (tc.parseError) {
                            this.emit({ type: "tool_result", name: tc.name, output: "", error: tc.parseError });
                            this.messages.push({
                                role: "tool",
                                tool_call_id: tc.id,
                                content: `ERROR: ${tc.parseError}`,
                            });
                            continue;
                        }
                        this.emit({ type: "tool_call", name: tc.name, args: tc.args });
                        this.rememberToolHistory(`CALL ${tc.name} ${this.stringifyToolArgs(tc.args)}`);
                        const tcEvent = {
                            type: "tool_call",
                            step: this.stepContext(),
                            payload: { toolName: tc.name, args: tc.args, callId: tc.id },
                        };
                        this.logReplay(tcEvent);
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
                        const trEvent = {
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
                        this.logReplay(trEvent);
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
                    this.emit({ type: "error", message: exhaustedMsg });
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
        }
        catch (err) {
            // Distinguish abort/timeout from other errors for cleaner messaging
            if (isAbortError(err)) {
                const msg = this.abortController.signal.reason instanceof Error
                    ? this.abortController.signal.reason.message
                    : "Aborted by user";
                this.emit({ type: "error", message: msg });
                this.emit({ type: "done", text: finalResponse || msg });
                this.logReplay({
                    type: "run_end",
                    payload: { runId: this.replay.runId ?? "", reason: "aborted" },
                });
                await this.finalizeReplay("aborted");
                return finalResponse || msg;
            }
            // Ensure error event is always emitted before re-throwing
            const message = err instanceof Error ? err.message : String(err);
            this.emit({ type: "error", message });
            this.logReplay({
                type: "run_end",
                payload: { runId: this.replay.runId ?? "", reason: "error" },
            });
            await this.finalizeReplay("error");
            throw err;
        }
        finally {
            if (this.timeoutTimer !== null) {
                clearTimeout(this.timeoutTimer);
                this.timeoutTimer = null;
            }
        }
    }
    async streamCompletionWithReplay() {
        const maxRetries = 3;
        let lastError = "";
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (this.abortController.signal.aborted) {
                    throw new DOMException("Aborted by user", "AbortError");
                }
                const stream = await this.client.chat.completions.create({
                    model: this.currentModel(),
                    messages: this.messages,
                    tools: TOOL_DEFINITIONS,
                    tool_choice: "auto",
                    stream: true,
                    stream_options: { include_usage: true },
                }, { signal: this.abortController.signal });
                let text = "";
                const toolCallAccumulators = new Map();
                for await (const chunk of stream) {
                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta)
                        continue;
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
                            const acc = toolCallAccumulators.get(idx);
                            if (tc.id)
                                acc.id = tc.id;
                            if (tc.function?.name)
                                acc.name = tc.function.name;
                            if (tc.function?.arguments)
                                acc.argsRaw += tc.function.arguments;
                        }
                    }
                }
                const toolCalls = toolCallAccumulators.size > 0
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
            }
            catch (err) {
                const error = err;
                const errorMsg = error.message || String(err);
                lastError = errorMsg;
                // Abort/timeout must propagate immediately — never retry
                if (isAbortError(err)) {
                    throw err;
                }
                const isRetryable = errorMsg.includes("500") ||
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
                const isProviderFunctionGone = errorMsg.includes("function") && (errorMsg.includes("not found") || errorMsg.includes("404"));
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
//# sourceMappingURL=agent.js.map