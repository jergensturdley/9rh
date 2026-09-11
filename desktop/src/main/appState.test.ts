import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "9rh-desktop-state-"));
process.env.NINE_RH_HOME = home;

const { appStatePath, readAppState, rememberWorkDir, updateAppState } = await import("./appState");

const filePath = join(home, "desktop.json");

beforeEach(() => {
  // Each test starts from a fresh file state; the directory itself may persist.
  if (existsSync(filePath)) writeFileSync(filePath, "");
});

describe("appState", () => {
  it("resolves under NINE_RH_HOME", () => {
    expect(appStatePath()).toBe(filePath);
  });

  it("returns defaults when the file is missing or corrupt", async () => {
    expect(await readAppState()).toEqual({ recentWorkDirs: [] });
    mkdirSync(home, { recursive: true });
    writeFileSync(filePath, "{not json");
    expect(await readAppState()).toEqual({ recentWorkDirs: [] });
    writeFileSync(filePath, JSON.stringify({ recentWorkDirs: "nope", lastModel: "m" }));
    expect(await readAppState()).toEqual({ recentWorkDirs: [], lastModel: "m" });
  });

  it("updateAppState shallow-merges and writes pretty JSON", async () => {
    const a = await updateAppState({ lastModel: "gpt", window: { width: 1, height: 2 } });
    expect(a).toEqual({ recentWorkDirs: [], lastModel: "gpt", window: { width: 1, height: 2 } });
    const b = await updateAppState({ quietByDefault: true });
    expect(b).toEqual({ recentWorkDirs: [], lastModel: "gpt", window: { width: 1, height: 2 }, quietByDefault: true });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toContain("\n  ");
    expect(JSON.parse(raw)).toEqual(b);
    expect(await readAppState()).toEqual(b);
  });

  it("rememberWorkDir dedupes, moves to front, caps at 10", async () => {
    await updateAppState({ recentWorkDirs: [] });
    for (let i = 0; i < 12; i++) await rememberWorkDir(`/w/${i}`);
    let state = await readAppState();
    expect(state.recentWorkDirs).toHaveLength(10);
    expect(state.recentWorkDirs[0]).toBe("/w/11");
    expect(state.recentWorkDirs).not.toContain("/w/0");
    expect(state.recentWorkDirs).not.toContain("/w/1");

    state = await rememberWorkDir("/w/5");
    expect(state.recentWorkDirs[0]).toBe("/w/5");
    expect(state.recentWorkDirs.filter((d) => d === "/w/5")).toHaveLength(1);
    expect(state.recentWorkDirs).toHaveLength(10);
  });
});
