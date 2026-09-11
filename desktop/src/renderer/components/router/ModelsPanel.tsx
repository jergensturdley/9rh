import { useEffect, useMemo, useState } from "react";
import type { RouterModel, RouterModelAvailability } from "@shared/routerTypes";
import { Badge, Button, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui";
import { useRouterResource } from "@renderer/state/routerStore";
import { sessionsActions, useActiveSession } from "@renderer/state/sessionsStore";
import { formatTokens } from "./format";
import "./router.css";

type Tone = "ok" | "warn" | "err" | "muted";

function availTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s.includes("unavail") || s.includes("error") || s.includes("fail")) return "err";
  if (s.includes("limit") || s.includes("cool") || s.includes("backoff")) return "warn";
  if (s.includes("avail") || s === "ok" || s === "active") return "ok";
  return "muted";
}

function caps(m: RouterModel): string[] {
  const c = m.caps;
  if (!c) return [];
  const out: string[] = [];
  if (c.vision) out.push("vision");
  if (c.reasoning) out.push("reasoning");
  if (c.search) out.push("search");
  if (c.contextWindow) out.push(`${formatTokens(c.contextWindow)} ctx`);
  if (c.maxOutput) out.push(`${formatTokens(c.maxOutput)} out`);
  return out;
}

export function ModelsPanel(props: { refreshSignal?: number }) {
  const models = useRouterResource("models");
  const availability = useRouterResource("availability");
  const active = useActiveSession();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (props.refreshSignal) {
      void models.refresh();
      void availability.refresh();
    }
  }, [props.refreshSignal]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // ponytail: keyed by "provider/model"; when several connections report the
  // same provider the last entry wins. Group by connectionId if that matters.
  const avail = useMemo(() => {
    const byKey = new Map<string, RouterModelAvailability>();
    for (const a of availability.data ?? []) byKey.set(`${a.provider}/${a.model}`, a);
    return byKey;
  }, [availability.data]);

  const forModel = (m: RouterModel): RouterModelAvailability | undefined =>
    avail.get(`${m.provider}/${m.model}`) ?? avail.get(`${m.provider}/__all`);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, RouterModel[]>();
    for (const m of models.data ?? []) {
      if (q && ![m.fullModel, m.name, m.provider, m.alias].some((v) => typeof v === "string" && v.toLowerCase().includes(q))) continue;
      const list = map.get(m.provider);
      if (list) list.push(m);
      else map.set(m.provider, [m]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models.data, query]);

  const searching = query.trim().length > 0;
  const canUse = active !== null && active.snapshot.status === "idle";
  const useHint = !active ? "Select a session first" : active.snapshot.status !== "idle" ? "Session is busy" : undefined;

  function toggle(provider: string): void {
    const next = new Set(open);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    setOpen(next);
  }

  async function useInSession(m: RouterModel): Promise<void> {
    if (!active) return;
    setBusy(m.fullModel);
    const res = await sessionsActions.setModel(active.snapshot.id, m.fullModel);
    setBusy(null);
    setToast(res.ok ? { ok: true, text: `Session model set to ${m.fullModel}` } : { ok: false, text: res.error });
  }

  return (
    <div className="rt-panel">
      <div className="rt-toolbar">
        <input className="rt-input" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="rt-note">
          {groups.reduce((n, [, list]) => n + list.length, 0)} of {models.data?.length ?? 0}
        </span>
        <span className="rt-spacer" />
        {(models.loading || availability.loading) && <Spinner />}
      </div>
      {toast && <div className={`rt-toast ${toast.ok ? "" : "rt-toast--err"}`}>{toast.text}</div>}
      {models.error && <ErrorNote message={models.error} onRetry={() => void models.refresh()} />}
      {availability.error && <ErrorNote message={`availability: ${availability.error}`} onRetry={() => void availability.refresh()} />}
      {models.data && groups.length === 0 ? (
        <EmptyState title={searching ? "No models match" : "No models"} hint={searching ? undefined : "Connect a provider in the dashboard."} />
      ) : (
        groups.map(([provider, list]) => {
          const expanded = searching || open.has(provider);
          const providerAvail = avail.get(`${provider}/__all`);
          return (
            <div className="rt-group" key={provider}>
              <button type="button" className="rt-group__head" onClick={() => toggle(provider)} aria-expanded={expanded}>
                <span>{expanded ? "▾" : "▸"}</span>
                <span className="rt-mono">{provider}</span>
                <span className="rt-group__count">{list.length}</span>
                <span className="rt-spacer" />
                {providerAvail && <Badge tone={availTone(providerAvail.status)}>{providerAvail.status}</Badge>}
              </button>
              {expanded && (
                <table className="rt-table">
                  <tbody>
                    {list.map((m) => {
                      const a = forModel(m);
                      return (
                        <tr key={m.fullModel}>
                          <td>
                            <span className="rt-mono">{m.fullModel}</span>
                            {m.name && m.name !== m.model && <span className="rt-sub">{m.name}</span>}
                          </td>
                          <td>
                            {a && (
                              <Badge tone={availTone(a.status)}>
                                {a.status}
                              </Badge>
                            )}
                            {a?.lastError && <span className="rt-sub">{a.lastError}</span>}
                          </td>
                          <td>
                            <span className="rt-chips">
                              {caps(m).map((c) => (
                                <span className="rt-chip" key={c}>
                                  {c}
                                </span>
                              ))}
                            </span>
                          </td>
                          <td className="rt-actions">
                            <Button size="sm" disabled={!canUse || busy === m.fullModel} title={useHint} onClick={() => void useInSession(m)}>
                              {busy === m.fullModel ? "..." : "Use in session"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
