import OpenAI from "openai";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
const DEFAULT_SYSTEM = `You are a skilled coding agent. You help with coding tasks by reading, writing, and modifying files, running commands, and solving problems step by step.

Guidelines:
- Break complex tasks into steps
- Read files before modifying them
- Run tests after making changes
- Be concise in explanations
- When done, summarize what you accomplished`;
export class Agent {
    client;
    config;
    messages = [];
    constructor(config) {
        this.config = config;
        this.client = new OpenAI({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
        });
    }
    emit(event) {
        this.config.onEvent?.(event);
    }
    async run(task) {
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
        for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
            this.emit({ type: "iteration", current: iteration, max: this.config.maxIterations });
            const { text, toolCalls } = await this.streamCompletion();
            if (text)
                finalResponse = text;
            if (!toolCalls || toolCalls.length === 0) {
                this.emit({ type: "done", text });
                return text;
            }
            this.messages.push({
                role: "assistant",
                content: text || null,
                tool_calls: toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.argsRaw },
                })),
            });
            for (const tc of toolCalls) {
                let args;
                let parseError;
                try {
                    args = JSON.parse(tc.argsRaw);
                }
                catch {
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
    async streamCompletion() {
        const stream = await this.client.chat.completions.create({
            model: this.config.model,
            messages: this.messages,
            tools: TOOL_DEFINITIONS,
            tool_choice: "auto",
            stream: true,
        });
        let text = "";
        const toolCallAccumulators = new Map();
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
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
        return { text, toolCalls };
    }
}
//# sourceMappingURL=agent.js.map