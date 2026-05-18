import { describe, it, expect, beforeEach } from "@jest/globals";
import { mkdir } from "fs/promises";
import { BranchManager } from "../branchManager.js";
describe("BranchManager", () => {
    const TEST_DIR = "/tmp/9rh-branch-test";
    beforeEach(async () => {
        try {
            await mkdir(TEST_DIR, { recursive: true });
        }
        catch { }
    });
    it("creates and retrieves a branch", async () => {
        const bm = new BranchManager({ branchDir: TEST_DIR });
        await bm.init();
        const branch = bm.createBranch({
            newBranchId: "branch-1",
            runId: "run-0",
            parentRunId: "run-0",
            parentStep: 3,
            branchReason: "test branch",
            eventLogPath: "/logs/runs/run-0.jsonl",
        });
        expect(branch.id).toBe("branch-1");
        expect(branch.branchReason).toBe("test branch");
        expect(bm.getBranch("branch-1")?.id).toBe("branch-1");
    });
    it("builds correct lineage", async () => {
        const bm = new BranchManager({ branchDir: TEST_DIR });
        await bm.init();
        bm.createBranch({ newBranchId: "b1", runId: "b1", branchReason: "first", eventLogPath: "" });
        bm.createBranch({ newBranchId: "b2", runId: "b2", parentRunId: "b1", parentStep: 2, branchReason: "second", eventLogPath: "" });
        bm.createBranch({ newBranchId: "b3", runId: "b3", parentRunId: "b2", parentStep: 5, branchReason: "third", eventLogPath: "" });
        const lineage = bm.getLineage("b3");
        expect(lineage.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    });
    it("archives a branch", async () => {
        const bm = new BranchManager({ branchDir: TEST_DIR });
        await bm.init();
        bm.createBranch({ newBranchId: "b1", runId: "run-0", branchReason: "orig", eventLogPath: "" });
        bm.archiveBranch("b1");
        expect(bm.getBranch("b1")?.status).toBe("archived");
    });
    it("lists all active branches", async () => {
        const bm = new BranchManager({ branchDir: TEST_DIR });
        await bm.init();
        bm.createBranch({ newBranchId: "b1", runId: "run-0", branchReason: "a", eventLogPath: "" });
        bm.createBranch({ newBranchId: "b2", runId: "run-0", branchReason: "b", eventLogPath: "" });
        bm.archiveBranch("b1");
        const active = bm.listActive();
        expect(active.map((b) => b.id)).toContain("b2");
        expect(active.map((b) => b.id)).not.toContain("b1");
    });
});
//# sourceMappingURL=branchManager.test.js.map