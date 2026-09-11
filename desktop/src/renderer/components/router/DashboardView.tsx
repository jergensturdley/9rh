import { useEffect, useRef } from "react";
import { Button, ErrorNote, Spinner } from "@renderer/components/ui";
import { useAsync } from "@renderer/state/useAsync";
import type { WebviewElement } from "./webview";
import "./router.css";

export function DashboardView(props: { refreshSignal?: number }) {
  const url = useAsync<string>(() => window.ninerh.router.dashboardUrl(), []);
  const ref = useRef<WebviewElement>(null);

  useEffect(() => {
    if (props.refreshSignal) ref.current?.reload();
  }, [props.refreshSignal]);

  return (
    <div className="rt-dashboard">
      <div className="rt-toolbar">
        <Button size="sm" onClick={() => ref.current?.reload()} disabled={!url.data}>
          Reload
        </Button>
        <Button size="sm" variant="ghost" onClick={() => url.data && void window.ninerh.shell.openExternal(url.data)} disabled={!url.data}>
          Open externally
        </Button>
        <span className="rt-note">Log in with your 9router password; the app never sees it.</span>
        <span className="rt-spacer" />
        {url.loading && <Spinner />}
      </div>
      {url.error && <ErrorNote message={url.error} onRetry={() => void url.refresh()} />}
      {url.data && (
        <div className="rt-dashboard__frame">
          <webview ref={ref} src={url.data} partition="persist:9router" className="rt-webview" style={{ height: "100%" }} />
        </div>
      )}
    </div>
  );
}
