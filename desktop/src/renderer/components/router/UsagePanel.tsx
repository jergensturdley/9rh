import { useEffect } from "react";
import { parseRequestLogLine } from "@shared/routerTypes";
import { Badge, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui";
import { useRouterLogs, useRouterResource, useRouterUsageStream } from "@renderer/state/routerStore";
import { formatCost, formatTokens } from "./format";
import "./router.css";

const LOG_LIMIT = 50;

function logOk(status: string): boolean {
  return /^(2\d\d|ok|success)/i.test(status.trim());
}

export function UsagePanel(props: { refreshSignal?: number }) {
  const stats = useRouterResource("usageStats");
  const chart = useRouterResource("usageChart");
  const logs = useRouterLogs(LOG_LIMIT);
  const live = useRouterUsageStream(true);

  useEffect(() => {
    if (props.refreshSignal) {
      void stats.refresh();
      void chart.refresh();
      void logs.refresh();
    }
  }, [props.refreshSignal]);

  const totals = live ?? stats.data;
  const points = (chart.data ?? []).slice(-7);
  const maxTokens = Math.max(1, ...points.map((p) => p.tokens));
  const byProvider = Object.entries(totals?.byProvider ?? {}).sort((a, b) => b[1].requests - a[1].requests);
  const rows = (logs.data ?? []).map(parseRequestLogLine);

  const tiles: Array<[string, string]> = totals
    ? [
        ["Requests", formatTokens(totals.totalRequests)],
        ["Prompt tokens", formatTokens(totals.totalPromptTokens)],
        ["Completion tokens", formatTokens(totals.totalCompletionTokens)],
        ["Cached tokens", formatTokens(totals.totalCachedTokens)],
        ["Cost", formatCost(totals.totalCost)],
      ]
    : [];

  return (
    <div className="rt-panel">
      <div className="rt-toolbar">
        <span className="rt-note">Totals as 9router reports them.</span>
        {live && <Badge tone="ok">live</Badge>}
        <span className="rt-spacer" />
        {(stats.loading || chart.loading || logs.loading) && <Spinner />}
      </div>
      {stats.error && <ErrorNote message={stats.error} onRetry={() => void stats.refresh()} />}
      {tiles.length > 0 && (
        <div className="rt-tiles">
          {tiles.map(([label, value]) => (
            <div className="rt-tile" key={label}>
              <div className="rt-tile__label">{label}</div>
              <div className="rt-tile__value">{value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="rt-section-title">Tokens, last {points.length || 7} periods</div>
      {chart.error && <ErrorNote message={chart.error} onRetry={() => void chart.refresh()} />}
      {points.length === 0 ? (
        chart.data && <EmptyState title="No chart data" />
      ) : (
        <div className="rt-chart" role="img" aria-label="tokens per period">
          {points.map((p) => (
            <div className="rt-chart__col" key={p.label} title={`${formatTokens(p.tokens)} tokens, ${formatCost(p.cost)}`}>
              <span className="rt-chart__value">{formatTokens(p.tokens)}</span>
              <div className="rt-chart__bar" style={{ height: `${Math.round((p.tokens / maxTokens) * 100)}%` }} />
              <span className="rt-chart__label">{p.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="rt-section-title">By provider</div>
      {byProvider.length === 0 ? (
        totals && <EmptyState title="No provider usage yet" />
      ) : (
        <table className="rt-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th className="rt-num">Requests</th>
              <th className="rt-num">Prompt</th>
              <th className="rt-num">Completion</th>
              <th className="rt-num">Cached</th>
              <th className="rt-num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {byProvider.map(([name, u]) => (
              <tr key={name}>
                <td className="rt-mono">{name}</td>
                <td className="rt-num">{formatTokens(u.requests)}</td>
                <td className="rt-num">{formatTokens(u.promptTokens)}</td>
                <td className="rt-num">{formatTokens(u.completionTokens)}</td>
                <td className="rt-num">{formatTokens(u.cachedTokens)}</td>
                <td className="rt-num">{formatCost(u.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="rt-section-title">Recent requests</div>
      {logs.error && <ErrorNote message={logs.error} onRetry={() => void logs.refresh()} />}
      {rows.length === 0 ? (
        logs.data && <EmptyState title="No requests logged" hint="Enable request logs in the dashboard settings." />
      ) : (
        <table className="rt-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Model</th>
              <th>Provider</th>
              <th>Key</th>
              <th className="rt-num">Prompt</th>
              <th className="rt-num">Completion</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.timestamp}-${i}`}>
                <td className="rt-mono">{r.timestamp}</td>
                <td className="rt-mono">{r.model}</td>
                <td>{r.provider}</td>
                <td>{r.keyName}</td>
                <td className="rt-num">{formatTokens(r.promptTokens)}</td>
                <td className="rt-num">{formatTokens(r.completionTokens)}</td>
                <td>
                  <Badge tone={logOk(r.status) ? "ok" : "err"}>{r.status || "?"}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
