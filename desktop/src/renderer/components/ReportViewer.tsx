/**
 * In-app viewer for the HTML run report the engine writes after a turn.
 * Main reads the file (restricted to .html under ~/.9rh) and the renderer
 * shows it in a fully sandboxed iframe: no scripts, no same-origin access,
 * so nothing in the report can reach window.ninerh.
 */

import { useAsync } from "@renderer/state/useAsync";
import { Modal } from "./Modal";
import { Button, ErrorNote, Spinner } from "./ui";
import "./ReportViewer.css";

export function ReportViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const html = useAsync(() => window.ninerh.shell.readReport(path), [path]);
  return (
    <Modal title="Run report" onClose={onClose} width={1100}>
      <div className="report">
        <div className="report-toolbar">
          <code className="report-path" title={path}>
            {path}
          </code>
          <Button size="sm" variant="ghost" onClick={() => void window.ninerh.shell.openPath(path)}>
            Open externally
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {html.error ? (
          <ErrorNote message={html.error} onRetry={() => void html.refresh()} />
        ) : html.data !== null ? (
          <iframe className="report-frame" sandbox="" srcDoc={html.data} title="run report" />
        ) : (
          <Spinner />
        )}
      </div>
    </Modal>
  );
}
