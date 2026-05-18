export interface AgentState {
    currentTask: string;
    memory: Record<string, unknown>;
    toolCallHistory: Array<{
        name: string;
        args: Record<string, unknown>;
        result: string;
    }>;
    stepIndex: number;
    environmentVars: Record<string, string>;
}
export interface Snapshot {
    id: string;
    timestamp: number;
    state: AgentState;
}
export declare function captureSnapshot(agentState: AgentState): Promise<string>;
export declare function restoreSnapshot(snapshotId: string): Promise<AgentState | null>;
export declare function listSnapshots(): Promise<Snapshot[]>;
