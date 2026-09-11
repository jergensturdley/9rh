/**
 * Replays page: pick a flight-recorder log from ~/.9rh/runs and play it into
 * a read-only transcript. Main streams the recorded events at the chosen
 * speed; the same transcript reducer the live workbench uses renders them.
 */

import { useState } from "react";
import type { RunLogInfo } from "9rh";
import { Transcript } from "@renderer/components/Transcript";
import { Badge, Button, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui";
import { useReplay } from "@renderer/state/replayStore";
import { useAsync } from "@renderer/state/useAsync";
import "./ReplaysPage.css";

const SPEEDS = [1, 2, 5, 10];

function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function reasonTone(reason: string): "ok" | "warn" | "err" | "muted" {
  if (reason === "completed") return "ok";
  if (reason === "error") return "err";
  if (reason === "aborted" || reason === "stopped" || reason === "max_iterations") return "warn";
  return "muted";
}

export function ReplaysPage() {
  const logs = useAsync(() => window.ninerh.replays.list(), []);
  const replay = useReplay();
  const [selected, setSelected] = useState<string | null>(null);
  const [speed, setSpeed] = useState(2);
  const [startError, setStartError] = useState<string | null>(null);
  const playing = replay.status?.state === "playing";

  const play = async (): Promise<void> => {
    if (!selected) return;
    setStartError(null);
    const res = await replay.start(selected, speed);
    if (!res.ok) setStartError(res.error);
  };

  return (
    <div className="replays">
      <aside className="replays-list">
        <header className="replays-list-header">
          <h2>Replays</h2>
          <Button size="sm" variant="ghost" disabled={logs.loading} onClick={() => void logs.refresh()}>
            Refresh
          </Button>
        </header>
        <p className="replays-intro">
          A replay renders the recorded event log of a past run. Nothing executes; the transcript is rebuilt from the
          flight recorder at the chosen speed.
        </p>
        {logs.error ? <ErrorNote message={logs.error} onRetry={() => void logs.refresh()} /> : null}
        {logs.data === null && !logs.error ? <Spinner /> : null}
        {logs.data && logs.data.length === 0 ? (
          <EmptyState title="No recorded runs" hint="Run logs land in ~/.9rh/runs after each agent turn." />
        ) : null}
        {logs.data && logs.data.length > 0 ? (
          <ul role="listbox" aria-label="recorded runs">
            {logs.data.map((log) => (
              <LogItem key={log.path} log={log} active={log.path === selected} onSelect={() => setSelected(log.path)} />
            ))}
          </ul>
        ) : null}
      </aside>
      <section className="replays-player">
        <div className="replays-controls">
          <label>
            Speed{" "}
            <select value={speed} disabled={playing} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
          {playing ? (
            <Button variant="danger" onClick={() => void replay.stop()}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" disabled={!selected} onClick={() => void play()}>
              Play
            </Button>
          )}
          <span className="replays-status">
            {replay.status ? (
              <>
                <Badge tone={replay.status.state === "playing" ? "accent" : replay.status.state === "done" ? "ok" : replay.status.state === "error" ? "err" : "warn"}>
                  {replay.status.state}
                </Badge>{" "}
                {replay.status.rendered} rendered
                {replay.status.error ? <span className="replays-error"> {replay.status.error}</span> : null}
              </>
            ) : selected ? (
              "ready"
            ) : (
              "select a run"
            )}
          </span>
        </div>
        {startError ? <ErrorNote message={startError} /> : null}
        <div className="replays-transcript">
          {replay.blocks.length === 0 && !playing ? (
            <EmptyState title="Nothing playing" hint="Pick a run on the left and press Play." />
          ) : (
            <Transcript blocks={replay.blocks} quiet={false} />
          )}
        </div>
      </section>
    </div>
  );
}

function LogItem({ log, active, onSelect }: { log: RunLogInfo; active: boolean; onSelect: () => void }) {
  return (
    <li
      role="option"
      aria-selected={active}
      tabIndex={0}
      className={active ? "replays-item is-active" : "replays-item"}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="replays-item-id" title={log.path}>
        {log.runId}
      </span>
      <span className="replays-item-meta">
        {relativeTime(log.mtimeMs)}
        {log.eventCount !== undefined ? ` · ${log.eventCount} events` : ""}
      </span>
      {log.reason ? <Badge tone={reasonTone(log.reason)}>{log.reason}</Badge> : null}
    </li>
  );
}
