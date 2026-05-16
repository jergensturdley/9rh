import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, mkdir, writeFile, readFile, rm } from "fs/promises";
import { join, dirname } from "path";
import type { AgentState } from "../repair/snapshotManager.js";
import { captureSnapshot as captureAgentSnapshot, restoreSnapshot as restoreAgentSnapshot } from "../repair/snapshotManager.js";

const execAsync = promisify(execFile);

export interface Checkpoint {
  id: string;
  runId: string;
  stepIndex: number;
  timestamp: number;
  workDirGitCommit: string;
  workDirGitHash: string;
  agentSnapshotId: string;
  reason: string;
  compressed: boolean;
}

export interface CheckpointConfig {
  runId: string;
  checkpointDir: string;
  workDir: string;
  compressAfterDays?: number;
  maxCheckpoints?: number;
}

export class CheckpointManager {
  private runId: string;
  private checkpointDir: string;
  private workDir: string;
  private compressAfterDays: number;
  private maxCheckpoints: number;

  constructor(config: CheckpointConfig) {
    this.runId = config.runId;
    this.checkpointDir = config.checkpointDir;
    this.workDir = config.workDir;
    this.compressAfterDays = config.compressAfterDays ?? 30;
    this.maxCheckpoints = config.maxCheckpoints ?? 50;
  }

  async init(): Promise<void> {
    try {
      await mkdir(this.checkpointDir, { recursive: true });
    } catch {}
    try {
      await mkdir(join(this.checkpointDir, "git-snapshots"), { recursive: true });
    } catch {}
  }

  async captureGitState(message: string): Promise<{ commit: string; hash: string }> {
    try {
      await execAsync("git", ["add", "-A"], { cwd: this.workDir });
      const { stdout } = await execAsync("git", ["commit", "-m", message], { cwd: this.workDir });
      const hash = stdout.trim().split("\n").pop()?.split(" ")[1] ?? "";
      return { commit: hash, hash: `git:${hash}` };
    } catch {
      return { commit: "", hash: "git:dirty" };
    }
  }

  async capture(agentState: AgentState, stepIndex: number, reason: string): Promise<Checkpoint> {
    const id = `cp-${this.runId}-${stepIndex}`;
    const git = await this.captureGitState(`checkpoint: step ${stepIndex} — ${reason}`);
    const snapshotId = await captureAgentSnapshot(agentState);

    const checkpoint: Checkpoint = {
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
    } catch {}

    await this.pruneOld();

    return checkpoint;
  }

  async restore(checkpoint: Checkpoint): Promise<void> {
    if (checkpoint.workDirGitHash.startsWith("git:")) {
      const hash = checkpoint.workDirGitHash.replace("git:", "");
      try {
        await execAsync("git", ["checkout", hash], { cwd: this.workDir });
      } catch {}
    }
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const files = await readdir(this.checkpointDir);
      const checkpoints: Checkpoint[] = [];
      for (const f of files) {
        if (!f.endsWith(".json") || f.includes(".meta")) continue;
        try {
          const raw = await readFile(join(this.checkpointDir, f), "utf-8");
          checkpoints.push(JSON.parse(raw) as Checkpoint);
        } catch {}
      }
      return checkpoints.sort((a, b) => b.stepIndex - a.stepIndex);
    } catch {
      return [];
    }
  }

  async listForRun(runId: string): Promise<Checkpoint[]> {
    const all = await this.list();
    return all.filter((c) => c.runId === runId);
  }

  private async pruneOld(): Promise<void> {
    const all = await this.list();
    if (all.length <= this.maxCheckpoints) return;
    const toDelete = all.slice(this.maxCheckpoints);
    for (const cp of toDelete) {
      try {
        await rm(join(this.checkpointDir, `${cp.id}.json`));
      } catch {}
    }
  }
}
