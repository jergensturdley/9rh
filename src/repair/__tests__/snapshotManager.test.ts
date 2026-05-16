import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { captureSnapshot, restoreSnapshot, listSnapshots } from "../snapshotManager.js";
import { readFile, readdir, mkdir, rm } from "fs/promises";
import { join } from "path";

describe("snapshotManager", () => {
  beforeEach(async () => {
    try { await mkdir("./snapshots", { recursive: true }); } catch {}
  });

  afterEach(async () => {
    try {
      const files = await readdir("./snapshots");
      for (const f of files) {
        if (f !== ".gitkeep") await rm(join("./snapshots", f));
      }
    } catch {}
  });

  it("captureSnapshot returns an id and writes a json file", async () => {
    const state = { currentTask: "test task", memory: {}, toolCallHistory: [], stepIndex: 1, environmentVars: {} };
    const id = await captureSnapshot(state as any);
    expect(id).toMatch(/^snap-/);
    const raw = await readFile(join("./snapshots", `${id}.json`), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(id);
    expect(parsed.state.currentTask).toBe("test task");
  });

  it("restoreSnapshot returns the saved state", async () => {
    const state = { currentTask: "restore test", memory: { foo: "bar" }, toolCallHistory: [], stepIndex: 5, environmentVars: { PATH: "/usr/bin" } };
    const id = await captureSnapshot(state as any);
    const restored = await restoreSnapshot(id);
    expect(restored?.currentTask).toBe("restore test");
    expect(restored?.stepIndex).toBe(5);
  });

  it("restoreSnapshot returns null for unknown id", async () => {
    const result = await restoreSnapshot("snap-nonexistent-12345");
    expect(result).toBeNull();
  });

  it("listSnapshots returns snapshots sorted newest-first", async () => {
    const s1 = { currentTask: "old", memory: {}, toolCallHistory: [], stepIndex: 1, environmentVars: {} };
    const s2 = { currentTask: "new", memory: {}, toolCallHistory: [], stepIndex: 2, environmentVars: {} };
    await captureSnapshot(s1 as any);
    await new Promise((r) => setTimeout(r, 10));
    await captureSnapshot(s2 as any);
    const snaps = await listSnapshots();
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps[0].state.currentTask).toBe("new");
  });
});
