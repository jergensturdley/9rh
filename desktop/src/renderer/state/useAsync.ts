/**
 * Small async-resource hook over an `IpcResult` producer: initial fetch on
 * mount, optional polling while mounted and the document is visible, and a
 * manual `refresh`. Stale responses (from a previous deps generation) are
 * dropped.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcResult } from "@shared/ipc";

export interface AsyncOpts {
  pollMs?: number;
  enabled?: boolean;
}

export interface AsyncResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useAsync<T>(fn: () => Promise<IpcResult<T>>, deps: unknown[], opts?: AsyncOpts): AsyncResource<T> {
  const pollMs = opts?.pollMs ?? 0;
  const enabled = opts?.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Bumped on every effect teardown so in-flight calls from an older deps
  // generation cannot write stale data.
  const gen = useRef(0);

  const refresh = useCallback(async () => {
    const mine = gen.current;
    setLoading(true);
    let res: IpcResult<T>;
    try {
      res = await fnRef.current();
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (gen.current !== mine) return;
    if (res.ok) {
      setData(res.value);
      setError(null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onVisible = (): void => {
      if (!document.hidden) void refresh();
    };
    const timer = pollMs > 0 ? setInterval(onVisible, pollMs) : null;
    if (timer) document.addEventListener("visibilitychange", onVisible);
    return () => {
      gen.current++;
      if (timer) {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pollMs, refresh, ...deps]);

  return { data, error, loading, refresh };
}
