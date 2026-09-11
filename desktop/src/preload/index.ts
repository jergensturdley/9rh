/**
 * Preload bridge: builds `window.ninerh` from the channel table in
 * `@shared/ipc`. Every invoke method forwards its arguments to
 * `ipcRenderer.invoke(channel, ...args)`; every push subscription returns an
 * unsubscribe that removes exactly the listener it added.
 *
 * `satisfies NinerhApi` makes a missing method a typecheck error, and the
 * groups are derived from `CH`, so the bridge cannot drift from the contract.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { CH } from "@shared/ipc";
import type { NinerhApi, Unsubscribe } from "@shared/ipc";

type Invoker = (...args: unknown[]) => Promise<any>;

function invokeGroup<G extends Record<string, string>>(channels: G): { [K in keyof G]: Invoker } {
  const out = {} as { [K in keyof G]: Invoker };
  for (const key of Object.keys(channels) as Array<keyof G>) {
    const channel = channels[key];
    out[key] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
  }
  return out;
}

function subscribe<T>(channel: string): (cb: (payload: T) => void) => Unsubscribe {
  return (cb) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const api = {
  sessions: invokeGroup(CH.sessions),
  router: invokeGroup(CH.router),
  replays: invokeGroup(CH.replays),
  backend: invokeGroup(CH.backend),
  config: invokeGroup(CH.config),
  shell: invokeGroup(CH.shell),
  events: {
    onSessionEvent: subscribe(CH.push.sessionEvent),
    onSessionChanged: subscribe(CH.push.sessionChanged),
    onSessionRemoved: subscribe(CH.push.sessionRemoved),
    onReplayEvent: subscribe(CH.push.replayEvent),
    onReplayStatus: subscribe(CH.push.replayStatus),
    onRouterUsage: subscribe(CH.push.routerUsage),
  },
} satisfies NinerhApi;

contextBridge.exposeInMainWorld("ninerh", api);
