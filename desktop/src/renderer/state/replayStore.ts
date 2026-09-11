/**
 * Replay hook: plays a flight-recorder log into a read-only transcript by
 * running the same `applyEnvelope` reducer over a synthetic session view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcResult, ReplayEventEnvelope, ReplayStatus, SessionSnapshot } from "@shared/ipc";
import type { SessionView, TranscriptBlock } from "./types";
import { applyEnvelope, emptySessionView } from "./transcript";

export interface ReplayHandle {
  status: ReplayStatus | null;
  blocks: TranscriptBlock[];
  start(path: string, speed: number): Promise<IpcResult<ReplayStatus>>;
  stop(): Promise<void>;
}

/** Minimal fake snapshot: only `id` and `ledger.turnCount` matter to the reducer. */
function replayView(replayId: string, path: string): SessionView {
  const now = Date.now();
  const snapshot: SessionSnapshot = {
    id: replayId,
    workDir: path,
    model: "",
    backendName: "embedded",
    backendDescription: "replay",
    baseURL: "",
    hasNativeRouter: false,
    status: "idle",
    createdAt: now,
    turnStartedAt: null,
    ledger: {
      sessionStartedAt: now,
      turnCount: 0,
      completedTurnCount: 0,
      goal: null,
      goalActive: false,
      lastOutcome: null,
      tokens: { prompt: 0, completion: 0, total: 0 },
      filesTouched: 0,
      commandsRun: 0,
      turns: [],
    },
    sandbox: { kind: "unavailable", label: "none" },
    pending: null,
    quiet: false,
    teamMode: false,
    maxIterations: 0,
    toolConcurrency: 1,
    allowSkillInstall: false,
    keepReports: false,
    lastReportPath: null,
    warnings: [],
    lastError: null,
  };
  return emptySessionView(snapshot);
}

export function useReplay(): ReplayHandle {
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [blocks, setBlocks] = useState<TranscriptBlock[]>([]);
  const view = useRef<SessionView | null>(null);
  const statusRef = useRef<ReplayStatus | null>(null);
  // Main may push events before `replays.start` resolves with the replayId;
  // buffer them until we know which replay we are watching.
  const starting = useRef(false);
  const early = useRef<ReplayEventEnvelope[]>([]);

  const pushStatus = (s: ReplayStatus): void => {
    statusRef.current = s;
    setStatus(s);
  };

  const apply = (e: ReplayEventEnvelope): void => {
    const v = view.current;
    if (!v || v.snapshot.id !== e.replayId) return;
    view.current = applyEnvelope(v, { sessionId: e.replayId, seq: e.seq, ts: Date.now(), event: e.event });
    setBlocks(view.current.blocks);
  };

  useEffect(() => {
    const api = window.ninerh;
    const unsubs = [
      api.events.onReplayEvent((e) => {
        if (starting.current) early.current.push(e);
        else apply(e);
      }),
      api.events.onReplayStatus((s) => {
        if (starting.current || view.current?.snapshot.id === s.replayId) pushStatus(s);
      }),
    ];
    return () => {
      for (const u of unsubs) u();
      // Nobody is listening once the page unmounts; stop the playback in main.
      const s = statusRef.current;
      if (s && s.state === "playing") void api.replays.stop(s.replayId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async (path: string, speed: number): Promise<IpcResult<ReplayStatus>> => {
    starting.current = true;
    early.current = [];
    view.current = null;
    setBlocks([]);
    const res = await window.ninerh.replays.start({ path, speed });
    starting.current = false;
    if (res.ok) {
      view.current = replayView(res.value.replayId, path);
      if (statusRef.current?.replayId !== res.value.replayId) pushStatus(res.value);
      for (const e of early.current) apply(e);
    }
    early.current = [];
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    const id = view.current?.snapshot.id ?? statusRef.current?.replayId;
    if (id) await window.ninerh.replays.stop(id);
  }, []);

  return { status, blocks, start, stop };
}
