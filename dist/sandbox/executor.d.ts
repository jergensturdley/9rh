import type { SandboxConfig } from "./sandboxer.js";
export interface ExecutionResult {
    output: string;
    error?: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
    sandboxUsed: boolean;
}
export interface SandboxProvider {
    exec(command: string, options?: {
        timeoutMs?: number;
    }): Promise<ExecutionResult>;
    validatePath(filePath: string): Promise<string>;
}
export declare class SandboxExecutor implements SandboxProvider {
    private sandbox;
    private config;
    constructor(workDir: string, sandboxConfig?: Partial<SandboxConfig>);
    exec(command: string, options?: {
        timeoutMs?: number;
    }): Promise<ExecutionResult>;
    validatePath(filePath: string): Promise<string>;
    getProfile(): string;
}
export declare class DirectExecutor implements SandboxProvider {
    private workDir;
    constructor(workDir: string);
    exec(command: string, options?: {
        timeoutMs?: number;
    }): Promise<ExecutionResult>;
    validatePath(_filePath: string): Promise<string>;
    getProfile(): string;
}
export declare class ObservabilityCollector {
    private executions;
    record(result: ExecutionResult, command: string): void;
    getHistory(): ExecutionRecord[];
    getSummary(): {
        total: number;
        sandboxed: number;
        direct: number;
        timedOut: number;
    };
    clear(): void;
}
interface ExecutionRecord extends ExecutionResult {
    timestamp: number;
    command: string;
}
export declare function createExecutor(workDir: string, opts?: {
    useSandbox?: boolean;
    sandboxConfig?: Partial<SandboxConfig>;
}): SandboxProvider;
export {};
