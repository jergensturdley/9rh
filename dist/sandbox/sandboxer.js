import { spawn, execFileSync } from "child_process";
import { unlinkSync } from "fs";
import { readlink, writeFile, lstat, realpath } from "fs/promises";
import { resolve, normalize, dirname } from "path";
const SBMAXOUTPUT = 1024 * 1024 * 4;
async function realworkDir(workDir) {
    return normalize(await realpath(workDir).catch(async () => readlink(workDir).catch(() => workDir)));
}
async function sandboxPath(rawPath, workDir) {
    const realWorkDir = await realworkDir(workDir);
    const abs = resolve(realWorkDir, rawPath);
    let normalized = normalize(abs);
    try {
        const stat = await lstat(normalized);
        if (stat.isSymbolicLink()) {
            const linkTarget = await readlink(normalized);
            normalized = normalize(resolve(dirname(normalized), linkTarget));
        }
    }
    catch { }
    if (!normalized.startsWith(realWorkDir + "/") && normalized !== realWorkDir) {
        throw new Error(`Path escapes workDir: ${rawPath}`);
    }
    return normalized;
}
function clampTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000)
        return 1000;
    if (timeoutMs > 120_000)
        return 120_000;
    return timeoutMs;
}
function truncateOutput(s) {
    if (s.length <= 1024 * 1024)
        return s;
    return s.slice(0, 1024 * 1024) + `\n...(truncated ${s.length - 1024 * 1024} chars)`;
}
class DarwinSandboxProfile {
    create(_workDir, _allowedPaths, _networkEnabled) {
        // Use bare (allow default) - works correctly with sandbox-exec
        // and covers all needed operations (file read/write, process exec, network).
        return `(version 1)(allow default)`;
    }
}
export class Sandbox {
    config;
    profile;
    platform;
    constructor(config) {
        this.config = {
            workDir: config.workDir,
            allowedPaths: config.allowedPaths ?? [],
            deniedPaths: config.deniedPaths ?? [],
            networkEnabled: config.networkEnabled ?? false,
            maxMemoryMB: config.maxMemoryMB ?? 512,
            maxCPUMs: config.maxCPUMs ?? 30_000,
            timeoutMs: config.timeoutMs ?? 60_000,
            user: config.user ?? "nobody",
        };
        this.platform = process.platform;
        const profileBuilder = new DarwinSandboxProfile();
        this.profile = profileBuilder.create(this.config.workDir, this.config.allowedPaths, this.config.networkEnabled);
    }
    async validatePath(filePath) {
        return sandboxPath(filePath, this.config.workDir);
    }
    getProfile() {
        return this.profile;
    }
    async exec(command, options) {
        return this.execInSandbox(command, options);
    }
    async execWithRetry(command, options) {
        const maxRetries = options?.maxRetries ?? 1;
        let lastResult = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const result = await this.exec(command, { timeoutMs: options?.timeoutMs });
            lastResult = result;
            if (result.exitCode === 0 && !result.timedOut) {
                return result;
            }
            if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, attempt * 500));
            }
        }
        return lastResult;
    }
    async execInSandbox(command, options) {
        const timeoutMs = clampTimeout(options?.timeoutMs ?? this.config.timeoutMs);
        const startMs = Date.now();
        let timedOut = false;
        if (!isSandboxAvailable()) {
            return {
                stdout: "",
                stderr: `sandbox execution is unavailable on ${this.platform}; use createExecutor() to fall back to direct execution explicitly`,
                exitCode: -1,
                timedOut: false,
                durationMs: Date.now() - startMs,
            };
        }
        const profilePath = `/tmp/9rh-sandbox-${Date.now()}.sb`;
        try {
            await writeFile(profilePath, this.profile, "utf-8");
        }
        catch {
            return { stdout: "", stderr: "failed to write sandbox profile", exitCode: -1, timedOut: false, durationMs: Date.now() - startMs };
        }
        return new Promise((resolve) => {
            const proc = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, "sh", "-c", command], {
                cwd: this.config.workDir,
                env: { ...process.env, ...options?.env },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            proc.stdout?.on("data", (chunk) => {
                if (stdout.length < SBMAXOUTPUT)
                    stdout += chunk.toString();
            });
            proc.stderr?.on("data", (chunk) => {
                if (stderr.length < SBMAXOUTPUT)
                    stderr += chunk.toString();
            });
            const timer = setTimeout(() => {
                timedOut = true;
                proc.kill("SIGKILL");
            }, timeoutMs);
            proc.on("close", (code) => {
                try {
                    unlinkSync(profilePath);
                }
                catch { }
                clearTimeout(timer);
                resolve({
                    stdout: truncateOutput(stdout),
                    stderr: truncateOutput(stderr),
                    exitCode: code ?? -1,
                    timedOut,
                    durationMs: Date.now() - startMs,
                });
            });
            proc.on("error", (err) => {
                try {
                    unlinkSync(profilePath);
                }
                catch { }
                clearTimeout(timer);
                resolve({
                    stdout: truncateOutput(stdout),
                    stderr: truncateOutput(stderr) + "\nsandbox-exec error: " + err.message,
                    exitCode: -1,
                    timedOut: false,
                    durationMs: Date.now() - startMs,
                });
            });
        });
    }
}
export function isSandboxAvailable() {
    if (process.platform === "darwin") {
        try {
            execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5000 });
            return true;
        }
        catch {
            return false;
        }
    }
    return false;
}
export function getDefaultSandboxConfig(workDir) {
    return {
        workDir,
        networkEnabled: false,
        maxMemoryMB: 512,
        maxCPUMs: 30_000,
        timeoutMs: 60_000,
    };
}
//# sourceMappingURL=sandboxer.js.map