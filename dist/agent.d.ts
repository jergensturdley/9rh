export interface AgentConfig {
    baseURL: string;
    apiKey: string;
    model: string;
    maxIterations: number;
    workDir: string;
    systemPrompt?: string;
    onEvent?: (event: AgentEvent) => void;
}
export type AgentEvent = {
    type: "thinking";
    text: string;
} | {
    type: "tool_call";
    name: string;
    args: Record<string, unknown>;
} | {
    type: "tool_result";
    name: string;
    output: string;
    error?: string;
} | {
    type: "done";
    text: string;
} | {
    type: "error";
    message: string;
} | {
    type: "iteration";
    current: number;
    max: number;
};
export declare class Agent {
    private client;
    private config;
    private messages;
    constructor(config: AgentConfig);
    private emit;
    run(task: string): Promise<string>;
    private streamCompletion;
}
