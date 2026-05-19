import { execFile } from "child_process";
import { promisify } from "util";
import { Sandbox, isSandboxAvailable, getDefaultSandboxConfig } from "./sandboxer.js";
const execFileAsync = promisify(execFile);
export class SandboxExecutor {
    sandbox;
    config;
    pathValidationCache = new Map();
    constructor(workDir, sandboxConfig) {
        const cfg = getDefaultSandboxConfig(workDir);
        if (sandboxConfig)
            Object.assign(cfg, sandboxConfig);
        this.config = cfg;
        this.sandbox = new Sandbox(cfg);
    }
    async exec(command, options) {
        const result = await this.sandbox.exec(command, { timeoutMs: options?.timeoutMs });
        return {
            output: result.stdout,
            error: result.exitCode !== 0 ? `exit ${result.exitCode}` : undefined,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            sandboxUsed: true,
        };
    }
    async validatePath(filePath) {
        const cached = this.pathValidationCache.get(filePath);
        if (cached)
            return cached;
        const validated = await this.sandbox.validatePath(filePath);
        this.pathValidationCache.set(filePath, validated);
        return validated;
    }
    getProfile() {
        return this.sandbox.getProfile();
    }
}
export class DirectExecutor {
    workDir;
    pathValidationCache = new Map();
    constructor(workDir) {
        this.workDir = workDir;
    }
    async exec(command, options) {
        const startMs = Date.now();
        const timeoutMs = Math.min(options?.timeoutMs ?? 60_000, 120_000);
        try {
            const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
                cwd: this.workDir,
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024 * 4,
            });
            const out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
            return {
                output: out || "(no output)",
                exitCode: 0,
                timedOut: false,
                durationMs: Date.now() - startMs,
                sandboxUsed: false,
            };
        }
        catch (err) {
            const e = err;
            const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
            return {
                output: combined || "(command failed)",
                error: "exit non-zero",
                exitCode: e.code ?? -1,
                timedOut: false,
                durationMs: Date.now() - startMs,
                sandboxUsed: false,
            };
        }
    }
    async validatePath(_filePath) {
        const cached = this.pathValidationCache.get(_filePath);
        if (cached)
            return cached;
        this.pathValidationCache.set(_filePath, _filePath);
        return _filePath;
    }
    getProfile() {
        return "# no sandbox profile (direct execution)";
    }
}
export class ObservabilityCollector {
    executions = [];
    record(result, command) {
        this.executions.push({
            timestamp: Date.now(),
            command,
            ...result,
        });
    }
    getHistory() {
        return [...this.executions];
    }
    getSummary() {
        return this.executions.reduce((acc, e) => ({
            total: acc.total + 1,
            sandboxed: acc.sandboxed + (e.sandboxUsed ? 1 : 0),
            direct: acc.direct + (e.sandboxUsed ? 0 : 1),
            timedOut: acc.timedOut + (e.timedOut ? 1 : 0),
        }), { total: 0, sandboxed: 0, direct: 0, timedOut: 0 });
    }
    clear() {
        this.executions = [];
    }
}
export function createExecutor(workDir, opts = {}) {
    if (opts.useSandbox && isSandboxAvailable()) {
        return new SandboxExecutor(workDir, opts.sandboxConfig);
    }
    return new DirectExecutor(workDir);
}
//# sourceMappingURL=executor.js.map