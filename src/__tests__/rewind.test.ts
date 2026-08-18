import { describe, it, expect } from "@jest/globals";
import { mkdtemp, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { planRewind, applyRewind } from "../rewind.js";
import type { LedgerTurn } from "../ledger.js";
import type { FileChangeRecord } from "../reports/runReportData.js";

function turn(index: number, records: FileChangeRecord[]): LedgerTurn {
  return {
    index,
    task: `task ${index}`,
    startedAt: 1000 * index,
    endedAt: 1000 * index + 500,
    status: "completed",
    digest: {
      task: `task ${index}`,
      status: "completed",
      durationMs: 500,
      steps: 1,
      files: [],
      commands: [],
      toolCounts: {},
      fileChangeRecords: records,
    },
  };
}

const rec = (path: string, before: string | undefined, after: string, extra: Partial<FileChangeRecord> = {}): FileChangeRecord => ({
  step: 1,
  path,
  operation: before === undefined ? "create" : "edit",
  before,
  after,
  ...extra,
});

describe("planRewind", () => {
  it("restores edits from the target turn and everything after, newest first", () => {
    const turns = [
      turn(1, [rec("a.txt", "v0", "v1")]),
      turn(2, [rec("a.txt", "v1", "v2"), rec("b.txt", undefined, "new")]),
    ];
    const plan = planRewind(turns, 1);
    // Turn 2's records (reversed) first, then turn 1's.
    expect(plan.actions.map((a) => [a.path, a.kind, a.content])).toEqual([
      ["b.txt", "delete", undefined],
      ["a.txt", "write", "v1"],
      ["a.txt", "write", "v0"],
    ]);
    expect(plan.skips).toHaveLength(0);
  });

  it("rewinding to a later turn leaves earlier turns untouched", () => {
    const turns = [
      turn(1, [rec("a.txt", "v0", "v1")]),
      turn(2, [rec("b.txt", "x", "y")]),
    ];
    const plan = planRewind(turns, 2);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].path).toBe("b.txt");
  });

  it("skips truncated records instead of corrupting files", () => {
    const turns = [turn(1, [rec("big.txt", "partial", "also partial", { beforeTruncated: true })])];
    const plan = planRewind(turns, 1);
    expect(plan.actions).toHaveLength(0);
    expect(plan.skips[0].reason).toMatch(/truncated/);
  });

  it("maps creations to deletions", () => {
    const plan = planRewind([turn(1, [rec("new.txt", undefined, "hello")])], 1);
    expect(plan.actions[0].kind).toBe("delete");
  });
});

describe("applyRewind", () => {
  it("restores, deletes, and refuses to clobber unrecorded edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rewind-"));
    const edited = join(dir, "edited.txt");
    const created = join(dir, "created.txt");
    const drifted = join(dir, "drifted.txt");
    await writeFile(edited, "after");
    await writeFile(created, "brand new");
    await writeFile(drifted, "user changed this since");
    const turns = [
      turn(1, [
        rec(edited, "before", "after"),
        rec(created, undefined, "brand new"),
        rec(drifted, "orig", "agent version"),
      ]),
    ];
    const result = await applyRewind(planRewind(turns, 1), dir);
    expect(await readFile(edited, "utf-8")).toBe("before");
    await expect(stat(created)).rejects.toThrow();
    expect(await readFile(drifted, "utf-8")).toBe("user changed this since");
    expect(result.restored).toEqual([edited]);
    expect(result.deleted).toEqual([created]);
    expect(result.skipped.map((s) => s.path)).toEqual([drifted]);
  });

  it("skips paths outside the workdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rewind-"));
    const outside = join(tmpdir(), "outside-rewind-test.txt");
    const turns = [turn(1, [rec(outside, "a", "b")])];
    const result = await applyRewind(planRewind(turns, 1), dir);
    expect(result.restored).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/outside/);
  });
});
