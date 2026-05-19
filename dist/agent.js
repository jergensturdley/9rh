import OpenAI from "openai";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { compressToolResultForContext } from "./contextCompression.js";
import { CircuitBreaker } from "./repair/circuitBreaker.js";
import { withErrorInterception, captureSnapshot, runRepairAgent, logIncident, } from "./repair/index.js";
import { EventLogger } from "./replay/eventLogger.js";
import { Reasoner } from "./reasoner/reasoner.js";
import { createExecutor, ObservabilityCollector } from "./sandbox/index.js";
import { formatSpecDrivenPrompt, shouldUseSpecDrivenTesting } from "./spec/specDrivenTesting.js";
const DEFAULT_SYSTEM = `You are a skilled coding agent. You help with coding tasks by reading, writing, and modifying files, running commands, and solving problems step by step.

Guidelines:
- Break complex tasks into steps
- Read files before modifying them
- Run tests after making changes
- Be concise in explanations
- When done, summarize what you accomplished`;
function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
        const compactPrompt = `Summarize the conversation in 2-3 sentences. What task, what done, what next.\n\n${historyText}\n\nSummary:`;
        const response = await this.client.chat.completions.create({
            model: this.currentModel(),
            messages: [{ role: "user", content: compactPrompt }],
        });
        return response.choices[0]?.message?.content ?? "Work in progress";
    }
    resetForContinuation(summary, originalTask) {
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
        const useSpecDrivenTesting = this.config.specDrivenTesting !== false && shouldUseSpecDrivenTesting(task);
        const taskForAgent = useSpecDrivenTesting ? formatSpecDrivenPrompt(task) : task;
        this.currentTask = task;
        this.activeModel = this.config.model;
        this.stepIndex = 0;
        this.compactCount = 0;
        this.messages = [];
        this.reasoner.reset();
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
        let finalResponse = "";
        let continuationCount = 0;
        const maxContinuations = this.config.continuationPolicy?.maxContinuations ?? 0;
        while (true) {
            const iterLimit = continuationCount === 0
                ? this.config.maxIterations
                : (this.config.continuationPolicy?.iterationsPerContinuation ?? this.config.maxIterations);
            for (let iteration = 1; iteration <= iterLimit; iteration++) {
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
                        function: { name: tc.name, arguments: tc.parseError ? "{}" : JSON.stringify(tc.args) },
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
    async streamCompletionWithReplay() {
        const maxRetries = 3;
        let lastError = "";
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const stream = await this.client.chat.completions.create({
                    model: this.currentModel(),
                    messages: this.messages,
                    tools: TOOL_DEFINITIONS,
                    tool_choice: "auto",
                    stream: true,
                    stream_options: { include_usage: true },
                });
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