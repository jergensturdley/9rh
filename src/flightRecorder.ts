/**
 * /replay: the flight recorder. Re-renders a past run's event log through the
 * live TUI renderer at adjustable speed. Pure re-render: no tools are
 * executed, no LLM is called; the recorded events are mapped back onto the
 * AgentEvent vocabulary the renderer already understands.
 */

import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";
import type { ReplayEvent } from "./replay/eventSchema.js";
import { readEventLog } from "./replay/eventLogger.js";
import type { AgentEvent } from "./agent.js";

export interface RunLogInfo {
  path: string;
  runId: string;
  mtimeMs: number;
  /** From the .meta.json sidecar when the run finalized cleanly. */
  eventCount?: number;
  reason?: string;
}

/** List recorded run logs (newest first). */
export async function listRunLogs(logDir: string): Promise<RunLogInfo[]> {
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return [];
  }
  const logs: RunLogInfo[] = [];
  for (const f of files) {
    const m = /^run-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    const path = join(logDir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    const info: RunLogInfo = { path, runId: m[1], mtimeMs };
    try {
      const meta = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf-8")) as {
        eventCount?: number;
        reason?: string;
      };
      info.eventCount = meta.eventCount;
      info.reason = meta.reason;
    } catch {}
    logs.push(info);
  }
  return logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Map one recorded replay event onto the AgentEvent(s) the TUI renders.
 * Events with no visual meaning (checkpoints, reasoning telemetry, run
 * bookends) map to nothing. Pure; exported for tests.
 */
export function mapReplayEvent(event: ReplayEvent): AgentEvent[] {
  switch (event.type) {
    case "step_start":
      return [{ type: "iteration", current: event.step.stepIndex, max: 0 }];
    case "llm_response": {
      const text = event.payload.text;
      return text ? [{ type: "thinking", text }] : [];
    }
    case "tool_call":
      return [{ type: "tool_call", name: event.payload.toolName, args: event.payload.args }];
    case "tool_result":
      return [
        {
          type: "tool_result",
          name: event.payload.toolName,
          output: event.payload.output,
          error: event.payload.error,
        },
      ];
    case "compact":
      return [{ type: "compact", summary: event.payload.summary }];
    case "spec_plan":
      return [{ type: "spec_plan", summary: event.payload.summary }];
    default:
      return [];
  }
}

export interface ReplayRenderOptions {
  /** Playback speed multiplier (2 = twice as fast). */
  speed?: number;
  /** Hard cap on any single inter-event pause, in ms. */
  gapCapMs?: number;
  /** Checked before each event; return true to stop playback. */
  shouldAbort?: () => boolean;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Feed a recorded event log through an AgentEvent sink, pacing playback by
 * the recorded timestamps (scaled by `speed`, capped by `gapCapMs`).
 * Returns the number of events rendered.
 */
export async function renderEventLog(
  events: ReplayEvent[],
  emit: (e: AgentEvent) => void,
  opts: ReplayRenderOptions = {},
): Promise<{ rendered: number; aborted: boolean }> {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 2;
  const gapCap = opts.gapCapMs ?? 400;
  const sleep = opts.sleep ?? defaultSleep;
  let rendered = 0;
  let prevTs: number | null = null;
  for (const event of events) {
    if (opts.shouldAbort?.()) return { rendered, aborted: true };
    const mapped = mapReplayEvent(event);
    if (mapped.length === 0) continue;
    if (prevTs !== null) {
      const gap = Math.min(gapCap, Math.max(0, (event.ts - prevTs) / speed));
      if (gap > 0) await sleep(gap);
    }
    prevTs = event.ts;
    for (const e of mapped) emit(e);
    rendered += mapped.length;
  }
  return { rendered, aborted: false };
}

export { readEventLog };
