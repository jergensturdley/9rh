import OpenAI from "openai";
import type { AgentState } from "./snapshotManager.js";
import type { TaggedError } from "./errorTaxonomy.js";
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
export declare function runRepairAgent(ctx: RepairContext): Promise<RepairResult>;
