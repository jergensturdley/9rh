import { describe, expect, it, vi } from "vitest";
import { join } from "path";
import { ninerhHome } from "9rh";
import { CH } from "@shared/ipc";
import { buildHandlers, registerIpc } from "./ipc";
import type { IpcDeps } from "./ipc";

const handleMock = vi.fn();
vi.mock("electron", () => ({
  ipcMain: { handle: (...args: unknown[]) => handleMock(...args) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  app: { getVersion: () => "0.0.0-test" },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => "", openExternal: async () => undefined },
}));

function fakeDeps() {
  const sent: Array<[string, unknown]> = [];
  const hostRun = vi.fn(async () => ({ status: "completed" as const, durationMs: 5 }));
  const host = { run: hostRun, stop: vi.fn(), rewindPlan: vi.fn(() => ({ targetTurnIndex: 1, writes: [], deletes: [], skips: [] })) };
  const registry = {
    list: vi.fn(() => [{ id: "s1" }]),
    get: vi.fn((id: string) => {
      if (id !== "s1") throw new Error(`unknown session ${id}`);
      return { id };
    }),
    host: vi.fn((id: string) => {
      if (id !== "s1") throw new Error(`unknown session ${id}`);
      return host;
    }),
  };
  const usageStream = vi.fn(
    (_onStats: (s: unknown) => void, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  );
  const router = { usageStream, dashboardUrl: () => "http://127.0.0.1:20128/dashboard", usageLogs: vi.fn(async () => []) };
  const deps = {
    registry,
    router,
    routerProcess: {},
    routerUpdater: {
      inspect: vi.fn(async () => ({ installs: [], diagnosis: [], canUpdate: true })),
      update: vi.fn(async (_input: unknown, onProgress?: (p: unknown) => void) => {
        onProgress?.({ phase: "install", line: "npm i -g 9router@latest" });
        return { ok: true, updatedInstalls: [], log: [] };
      }),
    },
    replays: { stop: vi.fn() },
    send: (channel: string, payload: unknown) => sent.push([channel, payload]),
  } as unknown as IpcDeps;
  return { deps, sent, registry, host, hostRun, usageStream };
}

const allInvokeChannels = (): string[] =>
  Object.entries(CH)
    .filter(([group]) => group !== "push")
    .flatMap(([, channels]) => Object.values(channels));

describe("buildHandlers", () => {
  it("has a handler for every invoke channel and nothing else", () => {
    const handlers = buildHandlers(fakeDeps().deps);
    const expected = allInvokeChannels();
    for (const ch of expected) expect(typeof handlers[ch], ch).toBe("function");
    expect(Object.keys(handlers).sort()).toEqual([...expected].sort());
    for (const ch of Object.values(CH.push)) expect(handlers[ch]).toBeUndefined();
  });

  it("wraps results in ok()", async () => {
    const handlers = buildHandlers(fakeDeps().deps);
    expect(await handlers[CH.sessions.list]!()).toEqual({ ok: true, value: [{ id: "s1" }] });
    expect(await handlers[CH.router.dashboardUrl]!()).toEqual({ ok: true, value: "http://127.0.0.1:20128/dashboard" });
  });

  it("wraps thrown errors in fail() instead of rejecting", async () => {
    const handlers = buildHandlers(fakeDeps().deps);
    expect(await handlers[CH.sessions.get]!("nope")).toEqual({ ok: false, error: "unknown session nope" });
  });

  it("forwards session calls to the host and resolves run with the outcome", async () => {
    const { deps, hostRun } = fakeDeps();
    const handlers = buildHandlers(deps);
    expect(await handlers[CH.sessions.run]!("s1", { task: "hi" })).toEqual({
      ok: true,
      value: { status: "completed", durationMs: 5 },
    });
    expect(hostRun).toHaveBeenCalledWith({ task: "hi" });
    expect(await handlers[CH.sessions.rewindPlan]!("s1", 1)).toMatchObject({ ok: true, value: { targetTurnIndex: 1 } });
  });

  it("validates ids, paths, numbers, and booleans", async () => {
    const handlers = buildHandlers(fakeDeps().deps);
    const cases: Array<[string, unknown[], string]> = [
      [CH.sessions.get, [""], "id"],
      [CH.sessions.get, [42], "id"],
      [CH.sessions.run, ["s1", { task: "" }], "task"],
      [CH.sessions.run, ["s1", "not an object"], "input"],
      [CH.sessions.decideApproval, ["s1", "r1", "yes"], "approved"],
      [CH.sessions.rewindPlan, ["s1", Number.NaN], "targetTurnIndex"],
      [CH.sessions.rewindPlan, ["s1", "1"], "targetTurnIndex"],
      [CH.sessions.diff, ["s1", 1, ""], "path"],
      [CH.sessions.suggestTeam, [""], "task"],
      [CH.router.usageLogs, ["ten"], "limit"],
      [CH.router.createCombo, [{ name: "c", models: [1] }], "models"],
      [CH.replays.start, [{ path: "" }], "path"],
      [CH.replays.stop, [undefined], "replayId"],
      [CH.shell.readReport, [""], "path"],
      [CH.config.set, ["oops"], "patch"],
    ];
    for (const [ch, args, name] of cases) {
      expect(await handlers[ch]!(...args), `${ch} ${JSON.stringify(args)}`).toEqual({ ok: false, error: `bad argument ${name}` });
    }
    // optional arguments stay optional
    expect(await handlers[CH.router.usageLogs]!()).toEqual({ ok: true, value: [] });
  });

  it("suggestTeam answers with a boolean from the engine heuristic", async () => {
    const handlers = buildHandlers(fakeDeps().deps);
    const r = await handlers[CH.sessions.suggestTeam]!("fix the typo in README");
    expect(r.ok).toBe(true);
    expect(typeof (r as { value: unknown }).value).toBe("boolean");
  });

  it("keeps one usage stream: start is idempotent, stop aborts, restart reopens", async () => {
    const { deps, usageStream, sent } = fakeDeps();
    const handlers = buildHandlers(deps);
    expect(await handlers[CH.router.usageStreamStart]!()).toEqual({ ok: true, value: undefined });
    expect(await handlers[CH.router.usageStreamStart]!()).toEqual({ ok: true, value: undefined });
    expect(usageStream).toHaveBeenCalledTimes(1);

    const [onStats, signal] = usageStream.mock.calls[0]! as unknown as [(s: unknown) => void, AbortSignal];
    onStats({ totalRequests: 1 });
    expect(sent).toEqual([[CH.push.routerUsage, { totalRequests: 1 }]]);
    expect(signal.aborted).toBe(false);

    expect(await handlers[CH.router.usageStreamStop]!()).toEqual({ ok: true, value: undefined });
    expect(signal.aborted).toBe(true);
    expect(await handlers[CH.router.usageStreamStop]!()).toEqual({ ok: true, value: undefined });

    await handlers[CH.router.usageStreamStart]!();
    expect(usageStream).toHaveBeenCalledTimes(2);
    await handlers[CH.router.usageStreamStop]!();
  });

  it("router update: forwards the force flag and pushes progress to the renderer", async () => {
    const { deps, sent } = fakeDeps();
    const handlers = buildHandlers(deps);
    expect(await handlers[CH.router.updateInfo]!()).toEqual({ ok: true, value: { installs: [], diagnosis: [], canUpdate: true } });

    const res = await handlers[CH.router.update]!({ force: true });
    expect(res).toEqual({ ok: true, value: { ok: true, updatedInstalls: [], log: [] } });
    expect((deps.routerUpdater.update as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ force: true });
    expect(sent.filter(([ch]) => ch === CH.push.routerUpdateProgress)).toEqual([
      [CH.push.routerUpdateProgress, { phase: "install", line: "npm i -g 9router@latest" }],
    ]);

    // No argument means a default (non-forced) update; a non-object is refused.
    await handlers[CH.router.update]!();
    expect((deps.routerUpdater.update as ReturnType<typeof vi.fn>).mock.calls[1][0]).toEqual({});
    expect(await handlers[CH.router.update]!("force")).toEqual({ ok: false, error: "bad argument input" });
  });

  it("shell guards: blocked schemes and out-of-home reports fail cleanly", async () => {
    const handlers = buildHandlers(fakeDeps().deps);
    expect(await handlers[CH.shell.openExternal]!("javascript:alert(1)")).toEqual({ ok: false, error: "blocked url scheme" });
    expect(await handlers[CH.shell.openExternal]!("https://example.com")).toEqual({ ok: true, value: undefined });
    // openPath is confined to run reports under the 9rh home, like readReport.
    expect((await handlers[CH.shell.openPath]!("relative/path")).ok).toBe(false);
    expect((await handlers[CH.shell.openPath]!("/Applications/Calculator.app")).ok).toBe(false);
    expect(await handlers[CH.shell.openExternal]!("file:///Applications/Calculator.app")).toEqual({ ok: false, error: "blocked url scheme" });
    const outside = await handlers[CH.shell.readReport]!("/etc/hosts");
    expect(outside.ok).toBe(false);
    const wrongExt = await handlers[CH.shell.readReport]!(join(ninerhHome(), "report.txt"));
    expect(wrongExt.ok).toBe(false);
    expect(await handlers[CH.shell.platform]!()).toEqual({
      ok: true,
      value: { platform: process.platform, home: ninerhHome(), version: "0.0.0-test" },
    });
  });
});

describe("registerIpc", () => {
  it("binds every handler to ipcMain.handle and drops the event argument", async () => {
    handleMock.mockClear();
    const handlers = registerIpc(fakeDeps().deps);
    const channels = allInvokeChannels();
    expect(handleMock).toHaveBeenCalledTimes(channels.length);
    expect(handleMock.mock.calls.map((c) => c[0]).sort()).toEqual([...channels].sort());
    const bound = handleMock.mock.calls.find((c) => c[0] === CH.sessions.get)![1] as (...a: unknown[]) => Promise<unknown>;
    expect(await bound({ sender: "fake event" }, "s1")).toEqual({ ok: true, value: { id: "s1" } });
    expect(Object.keys(handlers)).toHaveLength(channels.length);
  });
});
