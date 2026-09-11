/**
 * Session brief and usage in one view, read from the ledger snapshot main
 * pushes with every session change. Mirrors the CLI's /brief and /usage
 * renderers (src/ledger.ts renderBrief / renderUsage): goal line, totals,
 * one row per turn, and a nested per-role token table for team turns.
 */

import type { TokenUsage, TurnSummary } from "@shared/ipc";
import { useSession } from "@renderer/state/sessionsStore";
import { Badge, EmptyState, useNow } from "./ui";
import "./BriefView.css";

// Ports of ledger.ts fmtTokens / fmtDurationMs; the renderer cannot import 9rh.
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const secs = Math.floor(ms / 1000) % 60;
  const mins = Math.floor(ms / 60000) % 60;
  const hrs = Math.floor(ms / 3600000);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

const ZERO: TokenUsage = { prompt: 0, completion: 0, total: 0 };

export function BriefView({ sessionId }: { sessionId: string }) {
  const view = useSession(sessionId);
  const now = useNow(true);
  if (!view) return <EmptyState title="Unknown session" />;
  const ledger = view.snapshot.ledger;
  if (ledger.turnCount === 0) {
    return <EmptyState title="No turns yet" hint="Give the agent a task first; the brief fills in as turns complete." />;
  }
  return (
    <div className="brief">
      <p className="brief-goal">
        <span className="brief-goal-label">{ledger.goalActive ? "goal (active)" : "goal (last)"}</span>
        <span className="brief-goal-text" title={ledger.goal ?? ""}>
          {ledger.goal ?? ""}
        </span>
      </p>
      <dl className="brief-totals">
        <div>
          <dt>turns</dt>
          <dd>
            {ledger.turnCount} ({ledger.completedTurnCount} completed)
          </dd>
        </div>
        <div>
          <dt>files</dt>
          <dd>{ledger.filesTouched} touched</dd>
        </div>
        <div>
          <dt>commands</dt>
          <dd>{ledger.commandsRun} run</dd>
        </div>
        <div>
          <dt>tokens</dt>
          <dd>
            {fmtTokens(ledger.tokens.prompt)} in / {fmtTokens(ledger.tokens.completion)} out ({fmtTokens(ledger.tokens.total)} total)
          </dd>
        </div>
        <div>
          <dt>elapsed</dt>
          <dd>{fmtDurationMs(now - ledger.sessionStartedAt)}</dd>
        </div>
      </dl>
      <table className="brief-table">
        <thead>
          <tr>
            <th>#</th>
            <th className="brief-task">task</th>
            <th>status</th>
            <th>duration</th>
            <th className="num">in</th>
            <th className="num">out</th>
            <th className="num">total</th>
            <th className="num">files</th>
            <th className="num">cmds</th>
            <th className="num">assumed</th>
          </tr>
        </thead>
        <tbody>
          {ledger.turns.map((t) => (
            <TurnRows key={t.index} turn={t} now={now} />
          ))}
        </tbody>
      </table>
      <p className="brief-note">Counts come from provider stream metadata (tokens only; no cost estimates).</p>
    </div>
  );
}

function TurnRows({ turn: t, now }: { turn: TurnSummary; now: number }) {
  const running = t.endedAt === undefined;
  const u = t.tokens ?? ZERO;
  const roles = t.roleTokens ? Object.entries(t.roleTokens) : [];
  return (
    <>
      <tr className={running ? "brief-row is-running" : "brief-row"}>
        <td>{t.index}</td>
        <td className="brief-task" title={t.task}>
          {t.task.replace(/\s+/g, " ").trim()}
        </td>
        <td>
          {running ? (
            <Badge tone="accent">running</Badge>
          ) : t.status === "completed" ? (
            <Badge tone="ok">completed</Badge>
          ) : (
            <Badge tone="err">{t.status ?? "error"}</Badge>
          )}
        </td>
        <td>{fmtDurationMs((t.endedAt ?? now) - t.startedAt)}</td>
        <td className="num">{fmtTokens(u.prompt)}</td>
        <td className="num">{fmtTokens(u.completion)}</td>
        <td className="num">{fmtTokens(u.total)}</td>
        <td className="num">{t.digest?.files.length ?? 0}</td>
        <td className="num">{t.digest?.commands.length ?? 0}</td>
        <td className="num">{t.digest?.assumptions?.length ?? 0}</td>
      </tr>
      {roles.length > 0 ? (
        <tr className="brief-roles-row">
          <td />
          <td colSpan={9}>
            <table className="brief-roles">
              <tbody>
                {roles.map(([role, ru]) => (
                  <tr key={role}>
                    <td className="num">{fmtTokens(ru.prompt)}</td>
                    <td className="num">{fmtTokens(ru.completion)}</td>
                    <td className="num">{fmtTokens(ru.total)}</td>
                    <td className="brief-role">{role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}
