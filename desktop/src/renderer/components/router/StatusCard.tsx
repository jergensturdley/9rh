import { useEffect, useState, type ReactNode } from "react";
import type { RouterProcessResult } from "@shared/ipc";
import { Badge, Button, ErrorNote, Spinner } from "@renderer/components/ui";
import { Modal } from "@renderer/components/Modal";
import { useRouterNotice, useRouterStatus } from "@renderer/state/routerStore";
import "./router.css";

/** Confirm dialog shared by the console's destructive actions. */
export function ConfirmModal(props: {
  title: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={props.title} onClose={props.onClose} width={420}>
      <div>{props.children}</div>
      <div className="rt-modal-actions">
        <Button variant="ghost" onClick={props.onClose} disabled={props.busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={props.onConfirm} disabled={props.busy}>
          {props.busy ? "Working..." : (props.confirmLabel ?? "Confirm")}
        </Button>
      </div>
    </Modal>
  );
}

type Action = "start" | "stop" | "restart";

export function StatusCard(props: { refreshSignal?: number }) {
  const status = useRouterStatus();
  const [confirm, setConfirm] = useState<Exclude<Action, "start"> | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Outcome of start/stop/restart triggered from the command palette.
  const notice = useRouterNotice();

  useEffect(() => {
    if (props.refreshSignal) void status.refresh();
  }, [props.refreshSignal]);

  useEffect(() => {
    if (notice.nonce > 0) void status.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice.nonce]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const bundle = status.data;
  const reachable = bundle?.health.reachable ?? false;
  const tunnel = bundle?.tunnel?.tunnel;
  const publicUrl = tunnel?.running ? (tunnel.publicUrl ?? tunnel.tunnelUrl) : undefined;

  async function run(action: Action): Promise<void> {
    setConfirm(null);
    setBusy(action);
    setActionError(null);
    const api = window.ninerh.router;
    const res = action === "stop" ? await api.stop() : action === "start" ? await api.start() : await api.restart();
    if (!res.ok) setActionError(res.error);
    else if (action !== "stop") {
      const r = res.value as RouterProcessResult;
      if (r.error) setActionError(r.error);
      else if (!r.reachable) setActionError(`9router did not come up at ${r.baseURL}`);
    }
    setBusy(null);
    await status.refresh();
  }

  async function openDashboard(): Promise<void> {
    const url = await window.ninerh.router.dashboardUrl();
    if (!url.ok) {
      setActionError(url.error);
      return;
    }
    const opened = await window.ninerh.shell.openExternal(url.value);
    if (!opened.ok) setActionError(opened.error);
  }

  return (
    <div className="rt-status">
      <span className={`rt-status__dot ${reachable ? "rt-status__dot--ok" : "rt-status__dot--err"}`} aria-label={reachable ? "reachable" : "unreachable"} />
      <span className="rt-status__title">9router {bundle?.version?.currentVersion ?? ""}</span>
      {bundle?.version?.hasUpdate && <Badge tone="warn">update available {bundle.version.latestVersion}</Badge>}
      {status.loading && !bundle && <Spinner />}
      {bundle?.auth && (
        <span className="rt-status__meta">
          auth: {bundle.auth.authMode}
          <Badge tone={bundle.auth.requireLogin ? "accent" : "muted"}>{bundle.auth.requireLogin ? "login required" : "open"}</Badge>
        </span>
      )}
      {publicUrl && (
        <span className="rt-status__meta">
          tunnel <span className="rt-mono">{publicUrl}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(publicUrl);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </span>
      )}
      {!reachable && bundle?.health.detail && <span className="rt-status__meta">{bundle.health.detail}</span>}
      <div className="rt-status__actions">
        <Button size="sm" variant="primary" disabled={reachable || busy !== null} onClick={() => void run("start")}>
          {busy === "start" ? "Starting..." : "Start"}
        </Button>
        <Button size="sm" disabled={!reachable || busy !== null} onClick={() => setConfirm("stop")}>
          {busy === "stop" ? "Stopping..." : "Stop"}
        </Button>
        <Button size="sm" disabled={!reachable || busy !== null} onClick={() => setConfirm("restart")}>
          {busy === "restart" ? "Restarting..." : "Restart"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!reachable} onClick={() => void openDashboard()}>
          Open dashboard in browser
        </Button>
      </div>
      {(actionError ?? notice.message ?? status.error) && (
        <div className="rt-status__error">
          <ErrorNote message={actionError ?? notice.message ?? status.error ?? ""} onRetry={() => void status.refresh()} />
        </div>
      )}
      {confirm && (
        <ConfirmModal
          title={confirm === "stop" ? "Stop 9router?" : "Restart 9router?"}
          confirmLabel={confirm === "stop" ? "Stop" : "Restart"}
          onConfirm={() => void run(confirm)}
          onClose={() => setConfirm(null)}
        >
          {confirm === "stop"
            ? "Sessions using the router will fail until it is started again."
            : "In-flight requests through the router will be dropped."}
        </ConfirmModal>
      )}
    </div>
  );
}
