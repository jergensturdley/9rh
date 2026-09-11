import { useEffect } from "react";
import type { RouterSettingsSummary } from "@shared/routerTypes";
import { Badge, ErrorNote, Spinner } from "@renderer/components/ui";
import { useRouterResource } from "@renderer/state/routerStore";
import "./router.css";

/** Display order for the declared fields; index-signature extras are not shown. */
const FIELDS: Array<[keyof RouterSettingsSummary & string, string]> = [
  ["requireLogin", "Require login"],
  ["requireApiKey", "Require API key"],
  ["authMode", "Auth mode"],
  ["hasPassword", "Password set"],
  ["tunnelEnabled", "Tunnel enabled"],
  ["tunnelProvider", "Tunnel provider"],
  ["tunnelUrl", "Tunnel URL"],
  ["tailscaleEnabled", "Tailscale enabled"],
  ["comboStrategy", "Combo strategy"],
  ["fallbackStrategy", "Fallback strategy"],
  ["stickyRoundRobinLimit", "Sticky round-robin limit"],
  ["enableRequestLogs", "Request logs"],
  ["enableObservability", "Observability"],
  ["mitmEnabled", "MITM"],
  ["outboundProxyEnabled", "Outbound proxy"],
  ["outboundProxyUrl", "Outbound proxy URL"],
  ["headroomEnabled", "Headroom"],
  ["cavemanEnabled", "Caveman"],
  ["ponytailEnabled", "Ponytail"],
];

function Value(props: { value: unknown }) {
  const v = props.value;
  if (v === undefined || v === null || v === "") return <span className="rt-note">unset</span>;
  if (typeof v === "boolean") return <Badge tone={v ? "ok" : "muted"}>{v ? "on" : "off"}</Badge>;
  return <>{String(v)}</>;
}

export function SettingsSummary(props: { refreshSignal?: number }) {
  const settings = useRouterResource("settings");

  useEffect(() => {
    if (props.refreshSignal) void settings.refresh();
  }, [props.refreshSignal]);

  return (
    <div className="rt-panel">
      <div className="rt-toolbar">
        <span className="rt-note">Read-only. Edit these in the dashboard.</span>
        <span className="rt-spacer" />
        {settings.loading && <Spinner />}
      </div>
      {settings.error && <ErrorNote message={settings.error} onRetry={() => void settings.refresh()} />}
      {settings.data && (
        <dl className="rt-kv">
          {FIELDS.map(([key, label]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt>{label}</dt>
              <dd>
                <Value value={settings.data?.[key]} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
