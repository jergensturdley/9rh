/**
 * IPC handlers for every invoke channel in `CH`. `buildHandlers` is pure
 * (no Electron calls) so tests can drive it with fake services;
 * `registerIpc` binds the same map onto `ipcMain`.
 *
 * Every handler resolves to an `IpcResult`: thrown errors become
 * `{ ok: false, error }`, never a rejected invoke. Arguments arrive from the
 * renderer as `unknown` and are checked before they reach a service.
 */

import { BrowserWindow, ipcMain } from "electron";
import { readUserConfig, shouldSuggestTeam, updateUserConfig } from "9rh";
import type { UserConfig } from "9rh";
import { CH, fail, ok } from "@shared/ipc";
import type {
  AppState,
  BackendChoice,
  IpcResult,
  ReplayStartInput,
  RouterUpdateInput,
  RunTaskInput,
  SessionCreateInput,
} from "@shared/ipc";
import type { RouterComboInput } from "@shared/routerTypes";
import { readAppState, updateAppState } from "./appState";
import { listPresets, summarizeBackend } from "./backendService";
import type { ReplayService } from "./replayService";
import type { RouterClient } from "./routerClient";
import type { RouterProcess } from "./routerProcess";
import type { RouterUpdater } from "./routerUpdate";
import type { SessionRegistry } from "./sessionRegistry";
import * as shell from "./shell";

export interface IpcDeps {
  registry: SessionRegistry;
  router: RouterClient;
  routerProcess: RouterProcess;
  routerUpdater: RouterUpdater;
  replays: ReplayService;
  /** Push a payload to the renderer; must no-op when the window is gone. */
  send: (channel: string, payload: unknown) => void;
}

export type Handler = (...args: unknown[]) => Promise<IpcResult<unknown>>;

// ---------------------------------------------------------------------------
// Argument checks. Minimal on purpose: shape errors surface as fail() and
// the services re-validate anything that matters (paths, ids).
// ---------------------------------------------------------------------------

function bad(name: string): never {
  throw new Error(`bad argument ${name}`);
}

function str(v: unknown, name: string): string {
  return typeof v === "string" && v.length > 0 ? v : bad(name);
}

function num(v: unknown, name: string): number {
  return typeof v === "number" && Number.isFinite(v) ? v : bad(name);
}

function bool(v: unknown, name: string): boolean {
  return typeof v === "boolean" ? v : bad(name);
}

function optStr(v: unknown, name: string): string | undefined {
  return v === undefined ? undefined : str(v, name);
}

function optNum(v: unknown, name: string): number | undefined {
  return v === undefined ? undefined : num(v, name);
}

/** Plain object check plus a cast; the services own deeper validation. */
function rec<T extends object>(v: unknown, name: string): T {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as T) : bad(name);
}

function comboInput(v: unknown): RouterComboInput {
  const input = rec<RouterComboInput>(v, "input");
  str(input.name, "name");
  if (!Array.isArray(input.models) || !input.models.every((m) => typeof m === "string" && m)) bad("models");
  return input;
}

export function buildHandlers(deps: IpcDeps): Record<string, Handler> {
  const { registry, router, routerProcess, routerUpdater, replays, send } = deps;
  const host = (id: unknown) => registry.host(str(id, "id"));
  // ponytail: one app-wide SSE subscription with no refcount; start is
  // idempotent and stop ends it for everyone. Add a subscriber count if two
  // renderer panels ever need independent lifetimes.
  let usage: AbortController | null = null;

  const raw: Record<string, (...args: unknown[]) => unknown> = {
    // sessions
    [CH.sessions.create]: (input) => {
      const i = rec<SessionCreateInput>(input, "input");
      str(i.workDir, "workDir");
      return registry.create(i);
    },
    [CH.sessions.list]: () => registry.list(),
    [CH.sessions.get]: (id) => registry.get(str(id, "id")),
    [CH.sessions.remove]: (id) => registry.remove(str(id, "id")),
    [CH.sessions.run]: (id, input) => {
      const i = rec<RunTaskInput>(input, "input");
      str(i.task, "task");
      if (i.team !== undefined) bool(i.team, "team");
      return host(id).run(i);
    },
    [CH.sessions.stop]: (id) => host(id).stop(),
    [CH.sessions.abort]: (id) => host(id).abort(),
    [CH.sessions.answerAsk]: (id, requestId, answer) =>
      host(id).answerAsk(str(requestId, "requestId"), typeof answer === "string" ? answer : bad("answer")),
    [CH.sessions.decideApproval]: (id, requestId, approved, reason) =>
      host(id).decideApproval(str(requestId, "requestId"), bool(approved, "approved"), optStr(reason, "reason")),
    [CH.sessions.setQuiet]: (id, quiet) => host(id).setQuiet(bool(quiet, "quiet")),
    [CH.sessions.setTeamMode]: (id, teamMode) => host(id).setTeamMode(bool(teamMode, "teamMode")),
    [CH.sessions.setModel]: (id, model) => host(id).setModel(str(model, "model")),
    [CH.sessions.setWorkDir]: (id, workDir) => host(id).setWorkDir(str(workDir, "workDir")),
    [CH.sessions.listModels]: (id, filter) => host(id).listModels(optStr(filter, "filter")),
    [CH.sessions.history]: (id, sinceSeq) => host(id).history(optNum(sinceSeq, "sinceSeq")),
    [CH.sessions.recentToolResults]: (id) => host(id).recentToolResults(),
    [CH.sessions.suggestTeam]: (task) => shouldSuggestTeam(str(task, "task")),
    [CH.sessions.rewindPlan]: (id, turn) => host(id).rewindPlan(num(turn, "targetTurnIndex")),
    [CH.sessions.rewindApply]: (id, turn) => host(id).rewindApply(num(turn, "targetTurnIndex")),
    [CH.sessions.diff]: (id, turn, path) => host(id).diff(num(turn, "turnIndex"), str(path, "path")),
    [CH.sessions.skills]: (id) => host(id).skills(),

    // router
    [CH.router.status]: () => router.statusBundle(),
    [CH.router.start]: () => routerProcess.start(),
    [CH.router.stop]: () => routerProcess.stop(),
    [CH.router.restart]: () => routerProcess.restart(),
    [CH.router.settings]: () => router.settings(),
    [CH.router.providers]: () => router.providers(),
    [CH.router.testProvider]: (id) => router.testProvider(str(id, "id")),
    [CH.router.setProviderActive]: (id, isActive) => router.setProviderActive(str(id, "id"), bool(isActive, "isActive")),
    [CH.router.deleteProvider]: (id) => router.deleteProvider(str(id, "id")),
    [CH.router.combos]: () => router.combos(),
    [CH.router.createCombo]: (input) => router.createCombo(comboInput(input)),
    [CH.router.updateCombo]: (id, input) => router.updateCombo(str(id, "id"), comboInput(input)),
    [CH.router.deleteCombo]: (id) => router.deleteCombo(str(id, "id")),
    [CH.router.keys]: () => router.keys(),
    [CH.router.createKey]: (name) => router.createKey(str(name, "name")),
    [CH.router.deleteKey]: (id) => router.deleteKey(str(id, "id")),
    [CH.router.models]: () => router.models(),
    [CH.router.availability]: () => router.availability(),
    [CH.router.usageStats]: () => router.usageStats(),
    [CH.router.usageChart]: () => router.usageChart(),
    [CH.router.usageLogs]: (limit) => router.usageLogs(optNum(limit, "limit")),
    [CH.router.usageStreamStart]: () => {
      if (usage) return;
      usage = new AbortController();
      void router.usageStream((stats) => send(CH.push.routerUsage, stats), usage.signal);
    },
    [CH.router.usageStreamStop]: () => {
      usage?.abort();
      usage = null;
    },
    [CH.router.dashboardUrl]: () => router.dashboardUrl(),
    [CH.router.updateInfo]: () => routerUpdater.inspect(),
    [CH.router.update]: (input) =>
      routerUpdater.update(input === undefined ? {} : rec<RouterUpdateInput>(input, "input"), (p) => send(CH.push.routerUpdateProgress, p)),

    // replays
    [CH.replays.list]: () => replays.list(),
    [CH.replays.start]: (input) => {
      const i = rec<ReplayStartInput>(input, "input");
      str(i.path, "path");
      optNum(i.speed, "speed");
      return replays.start(i);
    },
    [CH.replays.stop]: (replayId) => replays.stop(str(replayId, "replayId")),

    // backend
    [CH.backend.detect]: (choice) => summarizeBackend(rec<BackendChoice>(choice, "choice")),
    [CH.backend.presets]: () => listPresets(),

    // config
    [CH.config.get]: () => readUserConfig(),
    [CH.config.set]: (patch) => updateUserConfig(rec<UserConfig>(patch, "patch")),
    [CH.config.appState]: () => readAppState(),
    [CH.config.setAppState]: (patch) => updateAppState(rec<Partial<AppState>>(patch, "patch")),

    // shell
    [CH.shell.pickDirectory]: () =>
      shell.pickDirectory(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null),
    [CH.shell.openPath]: (path) => shell.openPath(str(path, "path")),
    [CH.shell.openExternal]: (url) => shell.openExternal(str(url, "url")),
    [CH.shell.readReport]: (path) => shell.readReport(str(path, "path")),
    [CH.shell.platform]: () => shell.platform(),
  };

  const handlers: Record<string, Handler> = {};
  for (const [channel, fn] of Object.entries(raw)) {
    handlers[channel] = async (...args) => {
      try {
        return ok(await fn(...args));
      } catch (err) {
        return fail(err);
      }
    };
  }
  return handlers;
}

/** Bind every handler to ipcMain and return the map (the smoke test and shutdown use it directly). */
export function registerIpc(deps: IpcDeps): Record<string, Handler> {
  const handlers = buildHandlers(deps);
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => fn(...args));
  }
  return handlers;
}
