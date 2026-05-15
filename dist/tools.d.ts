import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
export declare const TOOL_DEFINITIONS: ChatCompletionTool[];
export interface ToolResult {
    output: string;
    error?: string;
}
export declare function executeTool(name: string, args: Record<string, unknown>, workDir: string): Promise<ToolResult>;
