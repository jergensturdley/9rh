/**
 * Tool approval gate: tool name, risk versus the session threshold, args as
 * pretty JSON, Approve or Reject with an optional reason. Esc rejects.
 */

import { useState } from "react";
import type { PendingRequest } from "@shared/ipc";
import { sessionsActions } from "@renderer/state/sessionsStore";
import { Modal } from "./Modal";
import { Badge, Button, ErrorNote } from "./ui";
import "./hitl.css";

type ApprovalRequest = Extract<PendingRequest, { kind: "approval" }>;

const RISK_TONE = { low: "ok", medium: "warn", high: "err", critical: "err" } as const;

export function ApprovalModal(props: { sessionId: string; request: ApprovalRequest }) {
  const { sessionId, request } = props;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = (approved: boolean): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void sessionsActions
      .decideApproval(sessionId, request.requestId, approved, reason.trim() || undefined)
      .then((r) => {
        if (!r.ok) setError(r.error);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal title="Approve this tool call?" onClose={() => decide(false)} width={640}>
      <div className="hitl-tool row gap-2 wrap">
        <code className="hitl-tool-name">{request.name}</code>
        <Badge tone={RISK_TONE[request.risk]}>risk {request.risk}</Badge>
        <span className="muted">threshold {request.threshold}</span>
      </div>
      <pre className="hitl-args mono" tabIndex={0} aria-label="tool arguments">
        {JSON.stringify(request.args, null, 2)}
      </pre>
      <input
        className="hitl-input"
        placeholder="Reason (optional, sent to the agent on reject)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-label="reason"
      />
      {error ? <ErrorNote message={error} /> : null}
      <div className="hitl-actions">
        <Button variant="danger" disabled={busy} onClick={() => decide(false)}>
          Reject
        </Button>
        <Button variant="primary" disabled={busy} autoFocus onClick={() => decide(true)}>
          Approve
        </Button>
      </div>
    </Modal>
  );
}
