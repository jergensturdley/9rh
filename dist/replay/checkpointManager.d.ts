import type { AgentState } from "../repair/snapshotManager.js";
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
export declare class CheckpointManager {
    private runId;
    private checkpointDir;
    private workDir;
    private compressAfterDays;
    private maxCheckpoints;
    constructor(config: CheckpointConfig);
    init(): Promise<void>;
    captureGitState(message: string): Promise<{
        commit: string;
        hash: string;
    }>;
    capture(agentState: AgentState, stepIndex: number, reason: string): Promise<Checkpoint>;
    restore(checkpoint: Checkpoint): Promise<void>;
    list(): Promise<Checkpoint[]>;
    listForRun(runId: string): Promise<Checkpoint[]>;
    private pruneOld;
}
