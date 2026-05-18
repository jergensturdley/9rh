import { describe, it, expect, beforeEach } from "@jest/globals";
import { writeFile, readFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { EventLogger } from "../eventLogger.js";
import { readEventLog } from "../eventLogger.js";

describe("EventLogger", () => {
  const TEST_DIR = "/tmp/9rh-replay-test";

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
    try { await mkdir(TEST_DIR, { recursive: true }); } catch {}
  });

  it("writes JSON Lines to disk", async () => {
    const logger = new EventLogger({ runId: "run1", branchId: "b1", logDir: TEST_DIR });
    await logger.init();
    logger.log({ type: "step_start", payload: {} });
    logger.log({ type: "step_end", payload: {} });
    const path = logger.getLogPath();
    await logger.finalize("run1", "test");
    const events = await readEventLog(path);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("step_start");
    expect(events[1].type).toBe("step_end");
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it("writes .meta.json on finalize", async () => {
    const logger = new EventLogger({ runId: "run2", branchId: "b2", logDir: TEST_DIR });
    await logger.init();
    logger.log({ type: "run_start", payload: { runId: "run2", model: "test", workDir: TEST_DIR, timestamp: new Date().toISOString() } });
    const path = await logger.finalize("run2", "completed");
    expect(path).toMatch(/run-run2\.jsonl$/);
    const metaPath = path.replace(/\.jsonl$/, ".meta.json");
    const raw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw);
    expect(meta.runId).toBe("run2");
    expect(meta.eventCount).toBe(1);
  });

  it("assigns monotonic seq numbers", async () => {
    const logger = new EventLogger({ runId: "run3", branchId: "b3", logDir: TEST_DIR });
    await logger.init();
    for (let i = 0; i < 5; i++) logger.log({ type: "step_start", payload: {} });
    const path = logger.getLogPath();
    await logger.finalize("run3", "done");
    const events = await readEventLog(path);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });
});
