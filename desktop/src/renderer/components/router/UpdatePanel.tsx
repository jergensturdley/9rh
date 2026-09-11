/**
 * 9router updates. Shows every install found, which one PATH resolves, what
 * the running daemon reports, and why an update may not have taken. Update
 * refreshes the copy on PATH and restarts; Force update refreshes every
 * install, kills every 9router process, then starts and verifies.
 */

import { useEffect, useRef, useState } from "react";
import type { RouterUpdateInfo, RouterUpdateProgress, RouterUpdateResult } from "@shared/ipc";
import { Badge, Button, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui";
import { useAsync } from "@renderer/state/useAsync";
import { setRouterNotice } from "@renderer/state/routerStore";
import { ConfirmModal } from "./StatusCard";
import "./router.css";

const LOG_CAP = 300;

export function UpdatePanel(props: { refreshSignal?: number }) {
  const info = useAsync<RouterUpdateInfo>(() => window.ninerh.router.updateInfo(), []);
  const [busy, setBusy] = useState<"update" | "force" | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<RouterUpdateResult | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (props.refreshSignal) void info.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshSignal]);

  useEffect(() => {
    return window.ninerh.events.onRouterUpdateProgress((p: RouterUpdateProgress) => {
      setLines((prev) => [...prev, p.line].slice(-LOG_CAP));
    });
  }, []);

  useEffect(() => {
    // Follow the log while it grows.
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = async (force: boolean): Promise<void> => {
    setConfirmForce(false);
    setBusy(force ? "force" : "update");
    setLines([]);
    setResult(null);
    const res = await window.ninerh.router.update({ force });
    setBusy(null);
    if (!res.ok) {
      setResult({ ok: false, before: null, after: null, latest: null, updatedInstalls: [], restarted: false, log: [], diagnosis: [], error: res.error });
      setRouterNotice(res.error);
    } else {
      setResult(res.value);
      setRouterNotice(res.value.ok ? null : (res.value.error ?? "the update did not complete"));
      if (res.value.log.length > 0) setLines(res.value.log.slice(-LOG_CAP));
    }
    await info.refresh();
  };

  const data = info.data;
  const running = busy !== null;

  if (info.loading && !data) return <Spinner />;
  if (!data) return <ErrorNote message={info.error ?? "could not inspect the 9router install"} onRetry={() => void info.refresh()} />;

  const onPath = data.installs.find((i) => i.pathRank === 0) ?? null;
  const behind = data.latestVersion !== null && data.runningVersion !== null && data.runningVersion !== data.latestVersion;

  return (
    <div className="rt-update">
      <div className="rt-update__head">
        <div className="rt-update__versions">
          <span className="rt-update__label">running</span>
          <span className="rt-mono">{data.runningVersion ?? "not running"}</span>
          <span className="rt-update__label">latest</span>
          <span className="rt-mono">{data.latestVersion ?? "unknown"}</span>
          {behind ? <Badge tone="warn">update available</Badge> : data.runningVersion ? <Badge tone="ok">current</Badge> : null}
        </div>
        <div className="rt-update__actions">
          <Button variant="primary" disabled={running || !data.canUpdate} onClick={() => void run(false)}>
            {busy === "update" ? "Updating..." : "Update"}
          </Button>
          <Button variant="danger" disabled={running || !data.canUpdate} onClick={() => setConfirmForce(true)} title="update every install, kill every 9router process, then restart and verify">
            {busy === "force" ? "Forcing..." : "Force update"}
          </Button>
          <Button variant="ghost" disabled={running} onClick={() => void info.refresh()}>
            Recheck
          </Button>
        </div>
      </div>

      {data.diagnosis.length > 0 ? (
        <ul className="rt-update__diagnosis">
          {data.diagnosis.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : null}

      <table className="rt-table rt-update__installs">
        <thead>
          <tr>
            <th>Install</th>
            <th>Version</th>
            <th>npm prefix</th>
            <th>Resolution</th>
          </tr>
        </thead>
        <tbody>
          {data.installs.length === 0 ? (
            <tr>
              <td colSpan={4}>
                <EmptyState title="No install found" hint="Update installs 9router into npm's global prefix." />
              </td>
            </tr>
          ) : (
            data.installs.map((i) => (
              <tr key={i.dir}>
                <td className="rt-mono">{i.dir}</td>
                <td className="rt-mono">{i.version ?? "unknown"}</td>
                <td className="rt-mono">{i.prefix}</td>
                <td className="rt-update__tags">
                  {i.pathRank === 0 ? <Badge tone="accent">runs from PATH</Badge> : i.onPath ? <Badge tone="muted">on PATH #{(i.pathRank ?? 0) + 1}</Badge> : null}
                  {i.npmDefault ? <Badge tone="muted">npm default</Badge> : null}
                  {data.runningDir === i.dir ? <Badge tone="ok">daemon</Badge> : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {result ? (
        result.ok ? (
          <div className="rt-update__result rt-update__result--ok">
            Updated {result.before ?? "unknown"} to {result.after}. {result.updatedInstalls.length} install{result.updatedInstalls.length === 1 ? "" : "s"} refreshed and the daemon restarted.
          </div>
        ) : (
          <ErrorNote message={result.error ?? "the update did not complete"} />
        )
      ) : null}

      {lines.length > 0 ? (
        <details className="rt-update__log" open={running}>
          <summary>{running ? "Update log (running)" : "Update log"}</summary>
          <pre className="rt-mono" ref={logRef}>
            {lines.join("\n")}
          </pre>
        </details>
      ) : null}

      {confirmForce ? (
        <ConfirmModal title="Force update 9router?" confirmLabel="Force update" onConfirm={() => void run(true)} onClose={() => setConfirmForce(false)}>
          Every 9router install on this machine is reinstalled at the latest version, every 9router process is stopped (SIGKILL if it ignores a clean shutdown), and the daemon is started from PATH. In-flight requests through the router are dropped.
        </ConfirmModal>
      ) : null}
    </div>
  );
}
