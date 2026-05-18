import { describe, it, expect } from "@jest/globals";
import { ReplayEngine } from "../replayEngine.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
const TEST_DIR = "/tmp/9rh-replay-engine-test";
async function makeLog(events) {
    try {
        await mkdir(TEST_DIR, { recursive: true });
    }
    catch { }
    const path = join(TEST_DIR, "test-run.jsonl");
    const lines = events.map((e, i) => JSON.stringify({ ...e, seq: i + 1, ts: Date.now() }));
    await writeFile(path, lines.join("\n"), "utf-8");
    return path;
}
describe("ReplayEngine", () => {
    const TEST_DIR = "/tmp/9rh-replay-engine-test";
    beforeEach(async () => {
        try {
            await rm(TEST_DIR, { recursive: true, force: true });
        }
        catch { }
        try {
            await mkdir(TEST_DIR, { recursive: true });
        }
        catch { }
    });
    it("loads events from jsonl", async () => {
        const path = join(TEST_DIR, "load-test.jsonl");
        await writeFile(path, [
            JSON.stringify({ type: "run_start", seq: 1, ts: 0, payload: {} }),
            JSON.stringify({ type: "step_start", seq: 2, ts: 0, step: { stepIndex: 1, iteration: 1, compactCount: 0 }, payload: {} }),
            JSON.stringify({ type: "step_end", seq: 3, ts: 0, step: { stepIndex: 1, iteration: 1, compactCount: 0 }, payload: {} }),
        ].join("\n"), "utf-8");
        const engine = new ReplayEngine({ eventLogPath: path, workDir: "/tmp" });
        await engine.load();
        expect(engine.getEventCount()).toBe(3);
    });
    it("loads and counts events correctly", async () => {
        const path = join(TEST_DIR, "load-test.jsonl");
        await writeFile(path, [
            JSON.stringify({ type: "run_start", seq: 1, ts: 0, payload: {} }),
            JSON.stringify({ type: "step_start", seq: 2, ts: 0, step: { stepIndex: 1, iteration: 1, compactCount: 0 }, payload: {} }),
            JSON.stringify({ type: "step_end", seq: 3, ts: 0, step: { stepIndex: 1, iteration: 1, compactCount: 0 }, payload: {} }),
        ].join("\n"), "utf-8");
        const engine = new ReplayEngine({ eventLogPath: path, workDir: "/tmp" });
        await engine.load();
        expect(engine.getEventCount()).toBe(3);
        expect(engine.isDiverged()).toBe(false);
        const result = await engine.replay();
        expect(result.eventCount).toBe(0);
    });
});
//# sourceMappingURL=replayEngine.test.js.map