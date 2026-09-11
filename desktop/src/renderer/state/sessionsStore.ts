/**
 * Sessions store: a module singleton read through `useSyncExternalStore`.
 * Main pushes `SessionEventEnvelope`s and snapshots; this store folds them
 * with the pure reducers in transcript.ts. Actions call the bridge and let
 * the pushed events update the view (no optimistic writes except select()).
 *
 * `window.ninerh` is only touched inside functions so the module imports
 * cleanly in DOM-free unit tests.
 */

import { useSyncExternalStore } from "react";
import type {
  IpcResult,
  NinerhApi,
  RunTaskOutcome,
  SessionCreateInput,
  SessionEventEnvelope,
  SessionSnapshot,
} from "@shared/ipc";
import type { SessionsState, SessionView } from "./types";
import { applyEnvelope, emptySessionView } from "./transcript";

let state: SessionsState = { order: [], byId: {}, activeId: null, loaded: false };
const listeners = new Set<() => void>();

function setState(next: SessionsState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function bridge(): NinerhApi | null {
  return typeof window !== "undefined" && window.ninerh ? window.ninerh : null;
}

const NO_BRIDGE: IpcResult<never> = { ok: false, error: "9rh bridge unavailable" };

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useSessionsState(): SessionsState {
  return useSyncExternalStore(subscribe, () => state);
}

export function useSession(id: string | null): SessionView | null {
  return useSyncExternalStore(subscribe, () => (id ? (state.byId[id] ?? null) : null));
}

export function useActiveSession(): SessionView | null {
  return useSyncExternalStore(subscribe, () => (state.activeId ? (state.byId[state.activeId] ?? null) : null));
}

// ---------------------------------------------------------------------------
// Internal mutations
// ---------------------------------------------------------------------------

function upsertView(view: SessionView): void {
  const id = view.snapshot.id;
  const order = state.order.includes(id) ? state.order : [...state.order, id];
  setState({ ...state, order, byId: { ...state.byId, [id]: view } });
}

function mergeSnapshot(snapshot: SessionSnapshot): SessionView {
  const existing = state.byId[snapshot.id];
  return existing ? { ...existing, snapshot } : emptySessionView(snapshot);
}

function removeView(id: string): void {
  if (!state.byId[id]) return;
  const byId = { ...state.byId };
  delete byId[id];
  const order = state.order.filter((x) => x !== id);
  const activeId = state.activeId === id ? (order[0] ?? null) : state.activeId;
  setState({ ...state, order, byId, activeId });
}

/** Fold envelopes in order, skipping any already applied (seq <= lastSeq). */
function applyEnvelopes(id: string, envs: SessionEventEnvelope[]): void {
  let view = state.byId[id];
  if (!view) return;
  let changed = false;
  for (const env of envs) {
    if (env.seq > view.lastSeq) {
      view = applyEnvelope(view, env);
      changed = true;
    }
  }
  if (changed) setState({ ...state, byId: { ...state.byId, [id]: view } });
}

// One history fetch per session at a time; later requests chain behind it so
// envelopes never apply out of order.
const catchUps = new Map<string, Promise<void>>();

function catchUp(id: string, pending?: SessionEventEnvelope): Promise<void> {
  const prev = catchUps.get(id) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const api = bridge();
      const view = state.byId[id];
      if (!api || !view) return;
      if (pending && pending.seq <= view.lastSeq + 1) {
        applyEnvelopes(id, [pending]);
        return;
      }
      const res = await api.sessions.history(id, view.lastSeq);
      // Leave lastSeq where it is on failure so the next envelope retries the
      // gap instead of skipping it for good.
      if (!res.ok) return;
      applyEnvelopes(id, pending ? [...res.value, pending] : res.value);
    })
    .finally(() => {
      if (catchUps.get(id) === next) catchUps.delete(id);
    });
  catchUps.set(id, next);
  return next;
}

function onEnvelope(env: SessionEventEnvelope): void {
  const view = state.byId[env.sessionId];
  // Unknown session: onSessionChanged creates the view and catches up history.
  if (!view || env.seq <= view.lastSeq) return;
  if (env.seq === view.lastSeq + 1 && !catchUps.has(env.sessionId)) {
    applyEnvelopes(env.sessionId, [env]);
    return;
  }
  void catchUp(env.sessionId, env);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function call<T>(fn: (api: NinerhApi) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const api = bridge();
  return api ? fn(api) : Promise.resolve(NO_BRIDGE);
}

export const sessionsActions = {
  async refresh(): Promise<void> {
    const api = bridge();
    if (!api) return;
    const res = await api.sessions.list();
    if (!res.ok) {
      setState({ ...state, loaded: true });
      return;
    }
    const byId: Record<string, SessionView> = {};
    const order: string[] = [];
    for (const snap of res.value) {
      byId[snap.id] = mergeSnapshot(snap);
      order.push(snap.id);
    }
    const activeId = state.activeId && byId[state.activeId] ? state.activeId : null;
    setState({ order, byId, activeId, loaded: true });
    await Promise.all(order.map((id) => catchUp(id)));
  },

  async create(input: SessionCreateInput): Promise<IpcResult<SessionSnapshot>> {
    const res = await call((api) => api.sessions.create(input));
    if (res.ok) {
      upsertView(mergeSnapshot(res.value));
      setState({ ...state, activeId: res.value.id });
    }
    return res;
  },

  async remove(id: string): Promise<IpcResult<void>> {
    const res = await call((api) => api.sessions.remove(id));
    if (res.ok) removeView(id);
    return res;
  },

  select(id: string | null): void {
    if (id !== state.activeId) setState({ ...state, activeId: id });
  },

  run(id: string, task: string, team?: boolean): Promise<IpcResult<RunTaskOutcome>> {
    return call((api) => api.sessions.run(id, team === undefined ? { task } : { task, team }));
  },
  stop(id: string): Promise<IpcResult<void>> {
    return call((api) => api.sessions.stop(id));
  },
  abort(id: string): Promise<IpcResult<void>> {
    return call((api) => api.sessions.abort(id));
  },
  answerAsk(id: string, requestId: string, answer: string): Promise<IpcResult<void>> {
    return call((api) => api.sessions.answerAsk(id, requestId, answer));
  },
  decideApproval(id: string, requestId: string, approved: boolean, reason?: string): Promise<IpcResult<void>> {
    return call((api) => api.sessions.decideApproval(id, requestId, approved, reason));
  },
  setQuiet(id: string, quiet: boolean): Promise<IpcResult<void>> {
    return call((api) => api.sessions.setQuiet(id, quiet));
  },
  setTeamMode(id: string, teamMode: boolean): Promise<IpcResult<void>> {
    return call((api) => api.sessions.setTeamMode(id, teamMode));
  },
  setModel(id: string, model: string): Promise<IpcResult<void>> {
    return call((api) => api.sessions.setModel(id, model));
  },
  setWorkDir(id: string, workDir: string): Promise<IpcResult<void>> {
    return call((api) => api.sessions.setWorkDir(id, workDir));
  },
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Subscribe to main's push events and load the session list. Returns an unsubscribe. */
export function initSessionsStore(): () => void {
  const api = bridge();
  if (!api) return () => {};
  const unsubs = [
    api.events.onSessionEvent(onEnvelope),
    api.events.onSessionChanged((snap) => {
      const isNew = !state.byId[snap.id];
      upsertView(mergeSnapshot(snap));
      if (isNew) void catchUp(snap.id);
    }),
    api.events.onSessionRemoved(removeView),
  ];
  void sessionsActions.refresh();
  return () => {
    for (const u of unsubs) u();
  };
}

// ponytail: every envelope triggers one setState and one React render pass.
// If thinking deltas ever flood the UI, coalesce envelopes per animation
// frame inside onEnvelope before calling applyEnvelopes.
