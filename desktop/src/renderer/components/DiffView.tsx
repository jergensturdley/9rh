/**
 * Unified line diff for one file touched in a turn, fetched from main's
 * `sessions.diff` (before/after records kept by the ledger).
 */

import type { FileDiff } from "@shared/ipc";
import { useAsync } from "@renderer/state/useAsync";
import { Modal } from "./Modal";
import { Badge, ErrorNote, Spinner } from "./ui";
import "./DiffView.css";

export function DiffView({
  sessionId,
  turnIndex,
  path,
  onClose,
}: {
  sessionId: string;
  turnIndex: number;
  path: string;
  onClose: () => void;
}) {
  const diff = useAsync(() => window.ninerh.sessions.diff(sessionId, turnIndex, path), [sessionId, turnIndex, path]);
  return (
    <Modal title={`Diff: turn ${turnIndex}`} onClose={onClose} width={1000}>
      {diff.error ? (
        <ErrorNote message={diff.error} onRetry={() => void diff.refresh()} />
      ) : diff.data ? (
        <DiffBody diff={diff.data} />
      ) : (
        <Spinner />
      )}
    </Modal>
  );
}

function DiffBody({ diff }: { diff: FileDiff }) {
  const truncated = diff.beforeTruncated || diff.afterTruncated;
  return (
    <div className="diff">
      <header className="diff-header">
        <code className="diff-path" title={diff.path}>
          {diff.path}
        </code>
        <Badge tone={diff.operation === "create" ? "ok" : "accent"}>{diff.operation}</Badge>
        <span className="diff-count add">+{diff.added}</span>
        <span className="diff-count remove">-{diff.removed}</span>
      </header>
      {truncated ? (
        <p className="diff-notice">
          The {diff.beforeTruncated && diff.afterTruncated ? "before and after" : diff.beforeTruncated ? "before" : "after"}{" "}
          content was truncated when recorded; this diff may be incomplete.
        </p>
      ) : null}
      <table className="diff-table">
        <tbody>
          {diff.lines.map((l, i) => (
            <tr key={i} className={`diff-row ${l.kind}`}>
              <td className="diff-gutter">{l.oldLine ?? ""}</td>
              <td className="diff-gutter">{l.newLine ?? ""}</td>
              <td className="diff-sign">{l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " "}</td>
              <td className="diff-text">{l.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
