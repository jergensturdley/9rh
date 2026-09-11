/**
 * Right-hand HUD: GOAL, NOW, SESSION, LAST, TEAM (when lanes exist) and the
 * recent tool list. Pure read of a SessionView; elapsed counters tick once
 * a second while a turn runs.
 */

import type { SessionView } from "@renderer/state/types";
import { Badge, formatElapsed, formatTokens, useNow } from "./ui";
import "./Hud.css";

export function Hud(props: { view: SessionView }) {
  const { snapshot, hud } = props.view;
  const running = snapshot.status === "running" || snapshot.status === "waiting";
  const now = useNow(running);
  const ledger = snapshot.ledger;
  const elapsed = snapshot.turnStartedAt ? formatElapsed(now - snapshot.turnStartedAt) : null;

  return (
    <aside className="hud" aria-label="session HUD">
      <Panel title="goal" pulse={ledger.goalActive}>
        <div className="hud-goal">{ledger.goal ?? <span className="muted">none yet</span>}</div>
      </Panel>

      <Panel title="now">
        <Row k="activity">
          <span className={`hud-activity hud-activity-${hud.activity}`}>{hud.activity}</span>
        </Row>
        {hud.currentTool ? (
          <Row k="tool">
            <span className="mono ellipsis" title={hud.currentToolTarget ?? undefined}>
              {hud.currentTool}
              {hud.currentToolTarget ? <span className="muted"> {hud.currentToolTarget}</span> : null}
            </span>
          </Row>
        ) : null}
        {hud.iterMax > 0 ? (
          <Row k="iteration">
            {hud.iterCurrent}/{hud.iterMax}
          </Row>
        ) : null}
        {elapsed ? <Row k="elapsed">{elapsed}</Row> : null}
        {hud.thinkingChars > 0 ? (
          <Row k="thinking">
            <span title={hud.thinkingPreview}>{formatTokens(hud.thinkingChars)} chars</span>
          </Row>
        ) : null}
        {hud.continuation ? (
          <Row k="continuation">
            {hud.continuation.count}/{hud.continuation.max}
          </Row>
        ) : null}
        {hud.turnTokens ? (
          <Row k="turn tokens">
            <span className="mono">
              {formatTokens(hud.turnTokens.prompt)} / {formatTokens(hud.turnTokens.completion)}
            </span>
          </Row>
        ) : null}
      </Panel>

      <Panel title="session">
        <Row k="turns">
          {ledger.completedTurnCount}/{ledger.turnCount}
        </Row>
        <Row k="files">{ledger.filesTouched}</Row>
        <Row k="commands">{ledger.commandsRun}</Row>
        <Row k="tokens">
          <span className="mono" title="prompt / completion">
            {formatTokens(ledger.tokens.prompt)} / {formatTokens(ledger.tokens.completion)}
          </span>
        </Row>
        <Row k="model">
          <span className="mono ellipsis" title={snapshot.model}>
            {snapshot.model}
          </span>
        </Row>
        <Row k="backend">
          <span className="ellipsis" title={snapshot.backendDescription}>
            {snapshot.backendDescription}
          </span>
        </Row>
        <Row k="sandbox">
          <span title={snapshot.sandbox.detail ?? snapshot.sandbox.label}>
            <Badge tone={snapshot.sandbox.kind === "available" ? "ok" : "warn"}>{snapshot.sandbox.label}</Badge>
          </span>
        </Row>
      </Panel>

      <Panel title="last">
        <div className="hud-last">{ledger.lastOutcome ?? <span className="muted">no completed turn</span>}</div>
      </Panel>

      {hud.teamLanes.length > 0 ? (
        <Panel title="team">
          <ul className="hud-lanes">
            {hud.teamLanes.map((l) => {
              const end = l.endedAt ?? now;
              return (
                <li key={l.role} className={`hud-lane hud-lane-${l.status}`}>
                  <span className="hud-lane-role">{l.role}</span>
                  <span className="hud-lane-status">{l.status}</span>
                  <span className="muted mono">{l.startedAt ? formatElapsed(end - l.startedAt) : ""}</span>
                  <span className="muted mono">{l.tokens !== undefined ? `${formatTokens(l.tokens)} tok` : ""}</span>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      {hud.toolHistory.length > 0 ? (
        <Panel title="recent tools">
          <ul className="hud-tools">
            {hud.toolHistory.map((t, i) => (
              <li key={i} className={`hud-tool hud-tool-${t.status}`}>
                <span className="hud-tool-dot" aria-label={t.status} />
                <span className="mono">{t.name}</span>
                <span className="muted mono ellipsis" title={t.target}>
                  {t.target}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </aside>
  );
}

function Panel(props: { title: string; pulse?: boolean; children: React.ReactNode }) {
  return (
    <section className="hud-panel">
      <h3 className="hud-title">
        {props.title}
        {props.pulse ? <span className="hud-pulse" aria-label="active" /> : null}
      </h3>
      {props.children}
    </section>
  );
}

function Row(props: { k: string; children: React.ReactNode }) {
  return (
    <div className="hud-row">
      <span className="hud-k">{props.k}</span>
      <span className="hud-v">{props.children}</span>
    </div>
  );
}
