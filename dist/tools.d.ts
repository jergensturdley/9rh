import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { SandboxProvider, ExecutionResult } from "./sandbox/index.js";
export declare const TOOL_DEFINITIONS: ChatCompletionTool[];
export interface ToolResult {
    output: string;
    error?: string;
}
export interface ExecuteToolOptions {
    executor?: SandboxProvider;
    onBashResult?: (result: ExecutionResult, command: string) => void;
}
export declare function executeTool(name: string, args: Record<string, unknown>, workDir: string, options?: ExecuteToolOptions): Promise<ToolResult>;
