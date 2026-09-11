/**
 * 9router console hooks: polled resources over `window.ninerh.router` plus
 * the SSE usage stream. Polling runs only while the hook is mounted and the
 * document is visible (see useAsync). The default poll interval comes from
 * the app settings (`routerPollMs` in ~/.9rh/desktop.json).
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { IpcResult, RouterApi, RouterStatusBundle } from "@shared/ipc";
import type { RouterUsageStats } from "@shared/routerTypes";
import { useAsync, type AsyncOpts, type AsyncResource } from "./useAsync";

const DEFAULT_POLL_MS = 15000;
const MIN_POLL_MS = 1000;

// ---------------------------------------------------------------------------
// Poll interval default (module store, loaded once from app state)
// ---------------------------------------------------------------------------

let pollDefault = DEFAULT_POLL_MS;
let pollLoaded = false;
const pollListeners = new Set<() => void>();

function subscribePoll(l: () => void): () => void {
  pollListeners.add(l);
  return () => {
    pollListeners.delete(l);
  };
}

/** Set by the settings page after a save so the change applies without a reload. */
export function setPollDefault(ms: number | undefined): void {
  pollDefault = ms && ms >= MIN_POLL_MS ? ms : DEFAULT_POLL_MS;
  for (const l of pollListeners) l();
}

function loadPollDefault(): void {
  if (pollLoaded || typeof window === "undefined" || !window.ninerh) return;
  pollLoaded = true;
  void window.ninerh.config.appState().then((res) => {
    if (res.ok) setPollDefault(res.value.routerPollMs);
  });
}

export function usePollDefault(): number {
  useEffect(loadPollDefault, []);
  return useSyncExternalStore(subscribePoll, () => pollDefault);
}

// ---------------------------------------------------------------------------
// Console notice (results of router actions started outside the Router page)
// ---------------------------------------------------------------------------

export interface RouterNotice {
  message: string | null;
  /** Bumped on every set so the status card can refresh even for a cleared message. */
  nonce: number;
}

let notice: RouterNotice = { message: null, nonce: 0 };
const noticeListeners = new Set<() => void>();

function subscribeNotice(l: () => void): () => void {
  noticeListeners.add(l);
  return () => {
    noticeListeners.delete(l);
  };
}

export function setRouterNotice(message: string | null): void {
  notice = { message, nonce: notice.nonce + 1 };
  for (const l of noticeListeners) l();
}

export function useRouterNotice(): RouterNotice {
  return useSyncExternalStore(subscribeNotice, () => notice);
}

/** Run a router process action from anywhere; the outcome lands in the notice. */
export async function runRouterAction(action: "start" | "stop" | "restart"): Promise<void> {
  const api = window.ninerh.router;
  if (action === "stop") {
    const res = await api.stop();
    setRouterNotice(res.ok ? null : res.error);
    return;
  }
  const res = action === "start" ? await api.start() : await api.restart();
  if (!res.ok) {
    setRouterNotice(res.error);
    return;
  }
  if (res.value.error) {
    setRouterNotice(res.value.error);
    return;
  }
  if (!res.value.reachable) {
    setRouterNotice(`9router did not come up at ${res.value.baseURL}`);
    return;
  }
  setRouterNotice(null);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export type RouterResourceKind =
  | "providers"
  | "combos"
  | "keys"
  | "models"
  | "availability"
  | "usageStats"
  | "usageChart"
  | "settings";

/** The `ok` payload type of a zero-argument RouterApi method. */
export type RouterResourceValue<K extends keyof RouterApi> = Extract<Awaited<ReturnType<RouterApi[K]>>, { ok: true }>["value"];

export function useRouterStatus(pollMs?: number): AsyncResource<RouterStatusBundle> {
  const def = usePollDefault();
  return useAsync<RouterStatusBundle>(() => window.ninerh.router.status(), [], { pollMs: pollMs ?? def });
}

export function useRouterResource<K extends RouterResourceKind>(kind: K, opts?: AsyncOpts): AsyncResource<RouterResourceValue<K>> {
  const def = usePollDefault();
  return useAsync<RouterResourceValue<K>>(
    () => {
      const router = window.ninerh.router;
      return router[kind]() as Promise<IpcResult<RouterResourceValue<K>>>;
    },
    [kind],
    { pollMs: opts?.pollMs ?? def, enabled: opts?.enabled },
  );
}

export function useRouterLogs(limit: number, opts?: AsyncOpts): AsyncResource<string[]> {
  const def = usePollDefault();
  return useAsync<string[]>(() => window.ninerh.router.usageLogs(limit), [limit], {
    pollMs: opts?.pollMs ?? def,
    enabled: opts?.enabled,
  });
}

/**
 * Live usage totals from the router's SSE stream. Starts the stream on mount
 * and stops it on unmount.
 * ponytail: one consumer at a time; the last unmount stops the stream for
 * everyone. Add a module-level refcount if two panels ever subscribe at once.
 */
export function useRouterUsageStream(enabled = true): RouterUsageStats | null {
  const [stats, setStats] = useState<RouterUsageStats | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const api = window.ninerh;
    const unsubscribe = api.events.onRouterUsage(setStats);
    void api.router.usageStreamStart();
    return () => {
      unsubscribe();
      void api.router.usageStreamStop();
    };
  }, [enabled]);
  return stats;
}
