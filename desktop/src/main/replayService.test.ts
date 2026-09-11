import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ReplayEvent, ReplayRenderOptions } from "9rh";
import type { ReplayEventEnvelope, ReplayStatus } from "@shared/ipc";
import { ReplayService, type ReplayServiceDeps } from "./replayService";

const LOG_DIR = "/tmp/9rh-replay-test/runs";
const LOG = join(LOG_DIR, "run-abc.jsonl");
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Emits one thinking event per recorded event, yielding between them so stop() can land. */
async function fakeRender(
  events: ReplayEvent[],
  emit: (e: AgentEvent) => void,
  opts: ReplayRenderOptions = {},
): Promise<{ rendered: number; aborted: boolean }> {
  let rendered = 0;
  for (let i = 0; i < events.length; i++) {
    if (opts.shouldAbort?.()) return { rendered, aborted: true };
    emit({ type: "thinking", text: String(i) });
    rendered++;
    await tick();
  }
  return { rendered, aborted: false };
}

function setup(over: Partial<ReplayServiceDeps> = {}) {
  const emitted: ReplayEventEnvelope[] = [];
  const statuses: ReplayStatus[] = [];
  const listRunLogs = vi.fn(async () => [{ path: LOG, runId: "abc", mtimeMs: 1 }]);
  const readEventLog = vi.fn(async () => [{}, {}, {}] as unknown as ReplayEvent[]);
  const renderEventLog = vi.fn(fakeRender);
  const service = new ReplayService({
    logDir: LOG_DIR,
    emit: (e) => emitted.push(e),
    onStatus: (s) => statuses.push(s),
    listRunLogs,
    readEventLog,
    renderEventLog,
    ...over,
  });
  return { service, emitted, statuses, listRunLogs, readEventLog, renderEventLog };
}

async function settle(statuses: ReplayStatus[], count = 1): Promise<void> {
  for (let i = 0; i < 50 && statuses.length < count; i++) await tick();
}

describe("ReplayService", () => {
  it("list delegates to listRunLogs with the resolved log dir", async () => {
    const { service, listRunLogs } = setup();
    expect(await service.list()).toHaveLength(1);
    expect(listRunLogs).toHaveBeenCalledWith(LOG_DIR);
  });

  it("rejects paths outside the log dir or without .jsonl", async () => {
    const { service, readEventLog } = setup();
    await expect(service.start({ path: "/etc/passwd" })).rejects.toThrow(/under/);
    await expect(service.start({ path: join(LOG_DIR, "..", "run-x.jsonl") })).rejects.toThrow(/under/);
    await expect(service.start({ path: join(LOG_DIR, "run-x.meta.json") })).rejects.toThrow(/\.jsonl/);
    await expect(service.start({ path: `${LOG_DIR}-sibling/run-x.jsonl` })).rejects.toThrow(/under/);
    expect(readEventLog).not.toHaveBeenCalled();
  });

  it("returns playing immediately, then posts done with the rendered count", async () => {
    const { service, emitted, statuses, renderEventLog } = setup();
    const status = await service.start({ path: LOG, speed: 4 });
    expect(status).toMatchObject({ path: LOG, state: "playing", rendered: 0 });
    expect(statuses).toEqual([]);
    await settle(statuses);
    expect(statuses).toEqual([{ replayId: status.replayId, path: LOG, state: "done", rendered: 3 }]);
    expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(emitted.every((e) => e.replayId === status.replayId)).toBe(true);
    expect(emitted[0].event).toEqual({ type: "thinking", text: "0" });
    expect(renderEventLog.mock.calls[0][2]).toMatchObject({ speed: 4 });
  });

  it("defaults speed to 2", async () => {
    const { service, statuses, renderEventLog } = setup();
    await service.start({ path: LOG });
    await settle(statuses);
    expect(renderEventLog.mock.calls[0][2]).toMatchObject({ speed: 2 });
  });

  it("stop mid-way posts aborted with the partial count", async () => {
    const { service, emitted, statuses } = setup();
    const { replayId } = await service.start({ path: LOG });
    await tick();
    service.stop(replayId);
    await settle(statuses);
    expect(statuses[0].state).toBe("aborted");
    expect(statuses[0].rendered).toBeGreaterThan(0);
    expect(statuses[0].rendered).toBeLessThan(3);
    expect(emitted).toHaveLength(statuses[0].rendered);
  });

  it("starting a second playback aborts the first", async () => {
    const { service, statuses } = setup({
      readEventLog: async () => new Array(50).fill({}) as ReplayEvent[],
    });
    const first = await service.start({ path: LOG });
    await tick();
    const second = await service.start({ path: LOG });
    await settle(statuses, 2);
    const byId = Object.fromEntries(statuses.map((s) => [s.replayId, s]));
    expect(byId[first.replayId].state).toBe("aborted");
    expect(byId[second.replayId]).toMatchObject({ state: "done", rendered: 50 });
  });

  it("posts error when rendering throws", async () => {
    const { service, statuses } = setup({
      renderEventLog: async (_events, emit) => {
        emit({ type: "thinking", text: "partial" });
        throw new Error("bad log");
      },
    });
    const { replayId } = await service.start({ path: LOG });
    await settle(statuses);
    expect(statuses).toEqual([{ replayId, path: LOG, state: "error", rendered: 1, error: "bad log" }]);
  });

  it("stop on an unknown or finished id is a no-op", async () => {
    const { service, statuses } = setup();
    service.stop("nope");
    const { replayId } = await service.start({ path: LOG });
    await settle(statuses);
    service.stop(replayId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].state).toBe("done");
  });
});
