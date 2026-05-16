import { readFile, writeFile, mkdir, readdir } from "fs/promises";

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

export class BranchManager {
  private branchDir: string;
  private indexPath: string;
  private branches: Map<string, Branch> = new Map();

  constructor(config: BranchConfig) {
    this.branchDir = config.branchDir;
    this.indexPath = `${this.branchDir}/index.json`;
  }

  async init(): Promise<void> {
    try {
      await mkdir(this.branchDir, { recursive: true });
    } catch {}
    await this.loadIndex();
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      const list: Branch[] = JSON.parse(raw);
      for (const b of list) {
        this.branches.set(b.id, b);
      }
    } catch {
      this.branches.clear();
    }
  }

  private async saveIndex(): Promise<void> {
    try {
      await writeFile(this.indexPath, JSON.stringify(Array.from(this.branches.values()), null, 2), "utf-8");
    } catch {}
  }

  createBranch(params: {
    newBranchId: string;
    runId: string;
    parentRunId?: string;
    parentStep?: number;
    branchReason: string;
    eventLogPath: string;
    tag?: string;
  }): Branch {
    const branch: Branch = {
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

  getBranch(branchId: string): Branch | undefined {
    return this.branches.get(branchId);
  }

  getBranchesForRun(runId: string): Branch[] {
    return Array.from(this.branches.values()).filter((b) => b.runId === runId || b.parentRunId === runId);
  }

  getLineage(branchId: string): Branch[] {
    const lineage: Branch[] = [];
    let current = this.branches.get(branchId);
    while (current) {
      lineage.unshift(current);
      current = current.parentRunId ? this.branches.get(current.parentRunId) : undefined;
    }
    return lineage;
  }

  archiveBranch(branchId: string): void {
    const b = this.branches.get(branchId);
    if (b) {
      b.status = "archived";
      this.saveIndex();
    }
  }

  listActive(): Branch[] {
    return Array.from(this.branches.values()).filter((b) => b.status === "active");
  }

  tagBranch(branchId: string, tag: string): void {
    const b = this.branches.get(branchId);
    if (b) {
      b.tag = tag;
      this.saveIndex();
    }
  }
}
