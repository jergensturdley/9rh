export interface SandboxConfig {
    workDir: string;
    allowedPaths?: string[];
    deniedPaths?: string[];
    networkEnabled?: boolean;
    maxMemoryMB?: number;
    maxCPUMs?: number;
    timeoutMs?: number;
    user?: string;
}
interface SpawnResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
}
export declare class Sandbox {
    private config;
    private profile;
    private platform;
    constructor(config: SandboxConfig);
    validatePath(filePath: string): Promise<string>;
    getProfile(): string;
    exec(command: string, options?: {
        timeoutMs?: number;
        env?: Record<string, string>;
    }): Promise<SpawnResult>;
    execWithRetry(command: string, options?: {
        timeoutMs?: number;
        maxRetries?: number;
    }): Promise<SpawnResult>;
    private execInSandbox;
}
export declare function isSandboxAvailable(): boolean;
export declare function getDefaultSandboxConfig(workDir: string): SandboxConfig;
export {};
