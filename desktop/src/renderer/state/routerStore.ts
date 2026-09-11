/**
 * 9router console hooks: polled resources over `window.ninerh.router` plus
 * the SSE usage stream. Polling runs only while the hook is mounted and the
 * document is visible (see useAsync).
 */

import { useEffect, useState } from "react";
import type { IpcResult, RouterApi, RouterStatusBundle } from "@shared/ipc";
import type { RouterUsageStats } from "@shared/routerTypes";
import { useAsync, type AsyncOpts, type AsyncResource } from "./useAsync";

const DEFAULT_POLL_MS = 15000;

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

export function useRouterStatus(pollMs = DEFAULT_POLL_MS): AsyncResource<RouterStatusBundle> {
  return useAsync<RouterStatusBundle>(() => window.ninerh.router.status(), [], { pollMs });
}

export function useRouterResource<K extends RouterResourceKind>(kind: K, opts?: AsyncOpts): AsyncResource<RouterResourceValue<K>> {
  return useAsync<RouterResourceValue<K>>(
    () => {
      const router = window.ninerh.router;
      return router[kind]() as Promise<IpcResult<RouterResourceValue<K>>>;
    },
    [kind],
    { pollMs: opts?.pollMs ?? DEFAULT_POLL_MS, enabled: opts?.enabled },
  );
}

export function useRouterLogs(limit: number, opts?: AsyncOpts): AsyncResource<string[]> {
  return useAsync<string[]>(() => window.ninerh.router.usageLogs(limit), [limit], {
    pollMs: opts?.pollMs ?? DEFAULT_POLL_MS,
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
