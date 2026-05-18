import { readFile, writeFile, mkdir } from "fs/promises";
export class BranchManager {
    branchDir;
    indexPath;
    branches = new Map();
    constructor(config) {
        this.branchDir = config.branchDir;
        this.indexPath = `${this.branchDir}/index.json`;
    }
    async init() {
        try {
            await mkdir(this.branchDir, { recursive: true });
        }
        catch { }
        await this.loadIndex();
    }
    async loadIndex() {
        try {
            const raw = await readFile(this.indexPath, "utf-8");
            const list = JSON.parse(raw);
            for (const b of list) {
                this.branches.set(b.id, b);
            }
        }
        catch {
            this.branches.clear();
        }
    }
    async saveIndex() {
        try {
            await writeFile(this.indexPath, JSON.stringify(Array.from(this.branches.values()), null, 2), "utf-8");
        }
        catch { }
    }
    createBranch(params) {
        const branch = {
            id: params.newBranchId,
            runId: params.runId,
            parentRunId: params.parentRunId,
            parentStep: params.parentStep,
            branchReason: params.branchReason,
            createdAt: Date.now(),
            eventLogPath: params.eventLogPath,
            status: "active",
            tag: params.tag,
        };
        this.branches.set(params.newBranchId, branch);
        this.saveIndex();
        return branch;
    }
    getBranch(branchId) {
        return this.branches.get(branchId);
    }
    getBranchesForRun(runId) {
        return Array.from(this.branches.values()).filter((b) => b.runId === runId || b.parentRunId === runId);
    }
    getLineage(branchId) {
        const lineage = [];
        let current = this.branches.get(branchId);
        while (current) {
            lineage.unshift(current);
            current = current.parentRunId ? this.branches.get(current.parentRunId) : undefined;
        }
        return lineage;
    }
    archiveBranch(branchId) {
        const b = this.branches.get(branchId);
        if (b) {
            b.status = "archived";
            this.saveIndex();
        }
    }
    listActive() {
        return Array.from(this.branches.values()).filter((b) => b.status === "active");
    }
    tagBranch(branchId, tag) {
        const b = this.branches.get(branchId);
        if (b) {
            b.tag = tag;
            this.saveIndex();
        }
    }
}
//# sourceMappingURL=branchManager.js.map