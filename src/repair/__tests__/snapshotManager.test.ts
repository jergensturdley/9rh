import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { captureSnapshot, restoreSnapshot, listSnapshots, type AgentState } from "../snapshotManager.js";
import { readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Snapshots live under NINE_RH_HOME (default ~/.9rh); point the app home at
// a tmpdir so the test never touches the real one (and never the cwd).
let home: string;
let prevHome: string | undefined;

beforeAll(async () => {
  prevHome = process.env.NINE_RH_HOME;
  home = await mkdtemp(join(tmpdir(), "ninerh-home-"));
  process.env.NINE_RH_HOME = home;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.NINE_RH_HOME;
  else process.env.NINE_RH_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("snapshotManager", () => {
  it("captureSnapshot returns an id and writes a json file under the app home", async () => {
    const state: AgentState = { currentTask: "test task", memory: {}, toolCallHistory: [], stepIndex: 1, environmentVars: {} };
    const id = await captureSnapshot(state);
    expect(id).toMatch(/^snap-/);
    const raw = await readFile(join(home, "snapshots", `${id}.json`), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(id);
    expect(parsed.state.currentTask).toBe("test task");
  });

  it("restoreSnapshot returns the saved state", async () => {
    const state: AgentState = { currentTask: "restore test", memory: { foo: "bar" }, toolCallHistory: [], stepIndex: 5, environmentVars: { PATH: "/usr/bin" } };
    const id = await captureSnapshot(state);
    const restored = await restoreSnapshot(id);
    expect(restored?.currentTask).toBe("restore test");
    expect(restored?.stepIndex).toBe(5);
  });

  it("restoreSnapshot returns null for unknown id", async () => {
    const result = await restoreSnapshot("snap-nonexistent-12345");
    expect(result).toBeNull();
  });

  it("listSnapshots returns snapshots sorted newest-first", async () => {
    const s1: AgentState = { currentTask: "old", memory: {}, toolCallHistory: [], stepIndex: 1, environmentVars: {} };
    const s2: AgentState = { currentTask: "new", memory: {}, toolCallHistory: [], stepIndex: 2, environmentVars: {} };
    await captureSnapshot(s1);
    await new Promise((r) => setTimeout(r, 10));
    await captureSnapshot(s2);
    const snaps = await listSnapshots();
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps[0].state.currentTask).toBe("new");
  });
});
