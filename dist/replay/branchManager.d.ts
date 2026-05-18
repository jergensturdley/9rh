export interface Branch {
    id: string;
    runId: string;
    parentRunId?: string;
    parentStep?: number;
    branchReason: string;
    createdAt: number;
    eventLogPath: string;
    status: "active" | "archived";
    tag?: string;
}
export interface BranchConfig {
    branchDir: string;
}
export declare class BranchManager {
    private branchDir;
    private indexPath;
    private branches;
    constructor(config: BranchConfig);
    init(): Promise<void>;
    private loadIndex;
    private saveIndex;
    createBranch(params: {
        newBranchId: string;
        runId: string;
        parentRunId?: string;
        parentStep?: number;
        branchReason: string;
        eventLogPath: string;
        tag?: string;
    }): Branch;
    getBranch(branchId: string): Branch | undefined;
    getBranchesForRun(runId: string): Branch[];
    getLineage(branchId: string): Branch[];
    archiveBranch(branchId: string): void;
    listActive(): Branch[];
    tagBranch(branchId: string, tag: string): void;
}
