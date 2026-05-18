import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, mkdir, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { captureSnapshot as captureAgentSnapshot } from "../repair/snapshotManager.js";
const execAsync = promisify(execFile);
export class CheckpointManager {
    runId;
    checkpointDir;
    workDir;
    compressAfterDays;
    maxCheckpoints;
    constructor(config) {
        this.runId = config.runId;
        this.checkpointDir = config.checkpointDir;
        this.workDir = config.workDir;
        this.compressAfterDays = config.compressAfterDays ?? 30;
        this.maxCheckpoints = config.maxCheckpoints ?? 50;
    }
    async init() {
        try {
            await mkdir(this.checkpointDir, { recursive: true });
        }
        catch { }
        try {
            await mkdir(join(this.checkpointDir, "git-snapshots"), { recursive: true });
        }
        catch { }
    }
    async captureGitState(message) {
        try {
            await execAsync("git", ["add", "-A"], { cwd: this.workDir });
            const { stdout } = await execAsync("git", ["commit", "-m", message], { cwd: this.workDir });
            const hash = stdout.trim().split("\n").pop()?.split(" ")[1] ?? "";
            return { commit: hash, hash: `git:${hash}` };
        }
        catch {
            return { commit: "", hash: "git:dirty" };
        }
    }
    async capture(agentState, stepIndex, reason) {
        const id = `cp-${this.runId}-${stepIndex}`;
        const git = await this.captureGitState(`checkpoint: step ${stepIndex} — ${reason}`);
        const snapshotId = await captureAgentSnapshot(agentState);
        const checkpoint = {
            id,
            runId: this.runId,
            stepIndex,
            timestamp: Date.now(),
            workDirGitCommit: git.commit,
            workDirGitHash: git.hash,
            agentSnapshotId: snapshotId,
            reason,
            compressed: false,
        };
        const path = join(this.checkpointDir, `${id}.json`);
        try {
            await writeFile(path, JSON.stringify(checkpoint), "utf-8");
        }
        catch { }
        await this.pruneOld();
        return checkpoint;
    }
    async restore(checkpoint) {
        if (checkpoint.workDirGitHash.startsWith("git:")) {
            const hash = checkpoint.workDirGitHash.replace("git:", "");
            try {
                await execAsync("git", ["checkout", hash], { cwd: this.workDir });
            }
            catch { }
        }
    }
    async list() {
        try {
            const files = await readdir(this.checkpointDir);
            const checkpoints = [];
            for (const f of files) {
                if (!f.endsWith(".json") || f.includes(".meta"))
                    continue;
                try {
                    const raw = await readFile(join(this.checkpointDir, f), "utf-8");
                    checkpoints.push(JSON.parse(raw));
                }
                catch { }
            }
            return checkpoints.sort((a, b) => b.stepIndex - a.stepIndex);
        }
        catch {
            return [];
        }
    }
    async listForRun(runId) {
        const all = await this.list();
        return all.filter((c) => c.runId === runId);
    }
    async pruneOld() {
        const all = await this.list();
        if (all.length <= this.maxCheckpoints)
            return;
        const toDelete = all.slice(this.maxCheckpoints);
        for (const cp of toDelete) {
            try {
                await rm(join(this.checkpointDir, `${cp.id}.json`));
            }
            catch { }
        }
    }
}
//# sourceMappingURL=checkpointManager.js.map