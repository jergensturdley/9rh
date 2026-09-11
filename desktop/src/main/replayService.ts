/**
 * Flight recorder playback for the desktop. Lists ~/.9rh/runs logs and plays
 * one back through 9rh's `renderEventLog`, forwarding each mapped
 * `AgentEvent` to the renderer as a `ReplayEventEnvelope`. Playback runs
 * detached from `start()`; the final state arrives on `onStatus`.
 */

import { randomUUID } from "crypto";
import { resolve, sep } from "path";
import {
  listRunLogs as listRunLogsDefault,
  ninerhDir,
  readEventLog as readEventLogDefault,
  renderEventLog as renderEventLogDefault,
} from "9rh";
import type { AgentEvent, ReplayEvent, ReplayRenderOptions, RunLogInfo } from "9rh";
import type { ReplayEventEnvelope, ReplayStartInput, ReplayStatus } from "@shared/ipc";

export interface ReplayServiceDeps {
  logDir?: string;
  emit: (e: ReplayEventEnvelope) => void;
  onStatus: (s: ReplayStatus) => void;
  listRunLogs?: (logDir: string) => Promise<RunLogInfo[]>;
  readEventLog?: (path: string) => Promise<ReplayEvent[]>;
  renderEventLog?: (
    events: ReplayEvent[],
    emit: (e: AgentEvent) => void,
    opts?: ReplayRenderOptions,
  ) => Promise<{ rendered: number; aborted: boolean }>;
}

export class ReplayService {
  private readonly logDir: string;
  private readonly emit: ReplayServiceDeps["emit"];
  private readonly onStatus: ReplayServiceDeps["onStatus"];
  private readonly listRunLogs: NonNullable<ReplayServiceDeps["listRunLogs"]>;
  private readonly readEventLog: NonNullable<ReplayServiceDeps["readEventLog"]>;
  private readonly renderEventLog: NonNullable<ReplayServiceDeps["renderEventLog"]>;
  private readonly aborted = new Set<string>();
  /** Only one playback at a time; starting another aborts this one. */
  private current: string | null = null;

  constructor(deps: ReplayServiceDeps) {
    this.logDir = resolve(deps.logDir ?? ninerhDir("runs"));
    this.emit = deps.emit;
    this.onStatus = deps.onStatus;
    this.listRunLogs = deps.listRunLogs ?? listRunLogsDefault;
    this.readEventLog = deps.readEventLog ?? readEventLogDefault;
    this.renderEventLog = deps.renderEventLog ?? renderEventLogDefault;
  }

  list(): Promise<RunLogInfo[]> {
    return this.listRunLogs(this.logDir);
  }

  async start(input: ReplayStartInput): Promise<ReplayStatus> {
    const path = resolve(input.path);
    if (!path.endsWith(".jsonl") || !path.startsWith(this.logDir + sep)) {
      throw new Error(`replay path must be a .jsonl file under ${this.logDir}`);
    }
    if (this.current) this.stop(this.current);
    const replayId = randomUUID();
    this.current = replayId;

    const events = await this.readEventLog(path);
    let seq = 0;
    void this.renderEventLog(events, (event) => this.emit({ replayId, seq: ++seq, event }), {
      speed: input.speed ?? 2,
      shouldAbort: () => this.aborted.has(replayId),
    })
      .then(({ rendered, aborted }) => this.onStatus({ replayId, path, state: aborted ? "aborted" : "done", rendered }))
      .catch((err: unknown) =>
        this.onStatus({ replayId, path, state: "error", rendered: seq, error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => {
        this.aborted.delete(replayId);
        if (this.current === replayId) this.current = null;
      });

    return { replayId, path, state: "playing", rendered: 0 };
  }

  stop(replayId: string): void {
    if (this.current === replayId) this.aborted.add(replayId);
  }
}
