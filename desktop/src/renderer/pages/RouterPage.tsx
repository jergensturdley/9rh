import { useState } from "react";
import { Button } from "@renderer/components/ui";
import { StatusCard } from "@renderer/components/router/StatusCard";
import { ProvidersTable } from "@renderer/components/router/ProvidersTable";
import { CombosPanel } from "@renderer/components/router/CombosPanel";
import { KeysPanel } from "@renderer/components/router/KeysPanel";
import { ModelsPanel } from "@renderer/components/router/ModelsPanel";
import { UsagePanel } from "@renderer/components/router/UsagePanel";
import { SettingsSummary } from "@renderer/components/router/SettingsSummary";
import { DashboardView } from "@renderer/components/router/DashboardView";
import { UpdatePanel } from "@renderer/components/router/UpdatePanel";
import { setRouterTab, useRouterTab } from "@renderer/state/routerStore";
import "./RouterPage.css";

const TABS = [
  ["providers", "Providers"],
  ["combos", "Combos"],
  ["keys", "Keys"],
  ["models", "Models"],
  ["usage", "Usage"],
  ["update", "Update"],
  ["settings", "Settings"],
  ["dashboard", "Dashboard"],
] as const;

type Tab = (typeof TABS)[number][0];

export function RouterPage() {
  // Tab lives in the router store so the command palette can open one directly.
  const tab = useRouterTab() as Tab;
  const setTab = setRouterTab;
  // Bumped by the Refresh button; the mounted panel re-fetches on change.
  const [tick, setTick] = useState(0);

  // ponytail: only the active tab is mounted, so its hooks poll only while
  // visible and stop on switch. Keep panels mounted with `enabled` on the
  // hooks if tab switches ever need to preserve scroll or the webview page.
  const panel =
    tab === "providers" ? <ProvidersTable refreshSignal={tick} />
    : tab === "combos" ? <CombosPanel refreshSignal={tick} />
    : tab === "keys" ? <KeysPanel refreshSignal={tick} />
    : tab === "models" ? <ModelsPanel refreshSignal={tick} />
    : tab === "usage" ? <UsagePanel refreshSignal={tick} />
    : tab === "update" ? <UpdatePanel refreshSignal={tick} />
    : tab === "settings" ? <SettingsSummary refreshSignal={tick} />
    : <DashboardView refreshSignal={tick} />;

  return (
    <div className="router-page">
      <StatusCard refreshSignal={tick} />
      <div className="router-page__tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            type="button"
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`router-page__tab ${tab === id ? "router-page__tab--active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <span className="router-page__spacer" />
        <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)}>
          Refresh
        </Button>
      </div>
      <div className={`router-page__body ${tab === "dashboard" ? "router-page__body--fill" : ""}`}>{panel}</div>
    </div>
  );
}
