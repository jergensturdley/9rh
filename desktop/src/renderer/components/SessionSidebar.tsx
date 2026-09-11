/**
 * Session list: status dot, workdir basename, model, elapsed while running,
 * a New button, and per-row remove with an inline confirm.
 */

import { useState } from "react";
import { sessionsActions, useSessionsState } from "@renderer/state/sessionsStore";
import type { SessionView } from "@renderer/state/types";
import { Button, basename, formatElapsed, useNow } from "./ui";
import "./SessionSidebar.css";

export function SessionSidebar(props: { onNew: () => void }) {
  const state = useSessionsState();
  const anyRunning = state.order.some((id) => state.byId[id]?.snapshot.status === "running");
  const now = useNow(anyRunning);
  return (
    <nav className="sidebar" aria-label="sessions">
      <div className="sidebar-head">
        <span className="sidebar-title">sessions</span>
        <Button size="sm" variant="primary" onClick={props.onNew}>
          New
        </Button>
      </div>
      <ul className="sidebar-list">
        {state.order.map((id) => {
          const view = state.byId[id];
          return view ? <Row key={id} view={view} active={id === state.activeId} now={now} /> : null;
        })}
      </ul>
      {state.loaded && state.order.length === 0 ? <p className="sidebar-empty muted">No sessions.</p> : null}
    </nav>
  );
}

function Row(props: { view: SessionView; active: boolean; now: number }) {
  const { snapshot } = props.view;
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const elapsed = snapshot.status === "running" && snapshot.turnStartedAt ? formatElapsed(props.now - snapshot.turnStartedAt) : null;

  const remove = async (): Promise<void> => {
    const res = await sessionsActions.remove(snapshot.id);
    if (!res.ok) {
      setError(res.error);
      setConfirm(false);
    }
  };

  return (
    <li className={props.active ? "sb-row is-active" : "sb-row"}>
      <button
        type="button"
        className="sb-main"
        onClick={() => sessionsActions.select(snapshot.id)}
        aria-current={props.active ? "true" : undefined}
        title={snapshot.workDir}
      >
        <span className={`sb-dot sb-dot-${snapshot.status}`} aria-label={snapshot.status} />
        <span className="sb-text">
          <span className="sb-name ellipsis">{basename(snapshot.workDir) || snapshot.workDir}</span>
          <span className="sb-meta muted ellipsis">
            {elapsed ? <span className="sb-elapsed mono">{elapsed} </span> : null}
            {snapshot.teamMode ? "team · " : ""}
            {snapshot.model}
          </span>
        </span>
      </button>
      {confirm ? (
        <span className="sb-confirm">
          <Button size="sm" variant="danger" onClick={() => void remove()}>
            Remove
          </Button>
          <Button size="sm" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <button type="button" className="sb-remove" aria-label={`remove session ${basename(snapshot.workDir)}`} onClick={() => setConfirm(true)}>
          &times;
        </button>
      )}
      {error ? (
        <span className="sb-error" role="alert">
          {error}
        </span>
      ) : null}
    </li>
  );
}
