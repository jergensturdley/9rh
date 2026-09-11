import { useEffect, useMemo, useState } from "react";
import type { RouterProvider } from "@shared/routerTypes";
import { Badge, Button, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui";
import { Modal } from "@renderer/components/Modal";
import { useRouterResource } from "@renderer/state/routerStore";
import { ConfirmModal } from "./StatusCard";
import { relativeTime } from "./format";
import "./router.css";

function statusTone(s: string | undefined): "ok" | "err" | "muted" {
  if (s === "available" || s === "ok") return "ok";
  if (s === "unavailable" || s === "error") return "err";
  return "muted";
}

function label(p: RouterProvider): string {
  return p.name ?? p.email ?? p.id;
}

export function ProvidersTable(props: { refreshSignal?: number }) {
  const providers = useRouterResource("providers");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [testing, setTesting] = useState<{ id: string; result: unknown } | null>(null);
  const [deleting, setDeleting] = useState<RouterProvider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (props.refreshSignal) void providers.refresh();
  }, [props.refreshSignal]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (providers.data ?? []).filter(
      (p) => !q || [p.name, p.email, p.provider, p.id, p.authType].some((v) => typeof v === "string" && v.toLowerCase().includes(q)),
    );
    return list.sort(
      (a, b) =>
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || label(a).localeCompare(label(b)),
    );
  }, [providers.data, filter]);

  async function act(id: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setBusy(id);
    setActionError(null);
    const res = await fn();
    if (!res.ok) setActionError(res.error ?? "unknown error");
    setBusy(null);
    await providers.refresh();
  }

  async function test(p: RouterProvider): Promise<void> {
    setBusy(p.id);
    setActionError(null);
    const res = await window.ninerh.router.testProvider(p.id);
    setBusy(null);
    if (!res.ok) setActionError(res.error);
    else setTesting({ id: p.id, result: res.value });
    await providers.refresh();
  }

  return (
    <div className="rt-panel">
      <div className="rt-toolbar">
        <input className="rt-input" placeholder="Filter providers" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="rt-note">{rows.length} of {providers.data?.length ?? 0}</span>
        <span className="rt-spacer" />
        {providers.loading && <Spinner />}
      </div>
      {actionError && <ErrorNote message={actionError} />}
      {providers.error && <ErrorNote message={providers.error} onRetry={() => void providers.refresh()} />}
      {providers.data && rows.length === 0 ? (
        <EmptyState title={filter ? "No providers match" : "No providers"} hint={filter ? undefined : "Add connections in the dashboard."} />
      ) : (
        <table className="rt-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Auth</th>
              <th className="rt-num">Priority</th>
              <th>Active</th>
              <th>Test status</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  {label(p)}
                  {p.email && p.name && <span className="rt-sub">{p.email}</span>}
                </td>
                <td className="rt-mono">{p.provider}</td>
                <td>{p.authType ?? ""}</td>
                <td className="rt-num">{p.priority ?? ""}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={p.isActive}
                    disabled={busy === p.id}
                    onChange={(e) => void act(p.id, () => window.ninerh.router.setProviderActive(p.id, e.target.checked))}
                  />
                </td>
                <td>
                  <Badge tone={statusTone(p.testStatus)}>{p.testStatus ?? "untested"}</Badge>
                  {p.lastError && (
                    <div>
                      <button
                        type="button"
                        className={`rt-error-text ${expanded === p.id ? "" : "rt-error-text--clamped"}`}
                        title={expanded === p.id ? "click to collapse" : "click to expand"}
                        aria-expanded={expanded === p.id}
                        onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                      >
                        {p.lastError}
                      </button>
                      {p.lastErrorAt && <span className="rt-sub">{relativeTime(p.lastErrorAt)}</span>}
                    </div>
                  )}
                </td>
                <td>{relativeTime(p.lastUsedAt)}</td>
                <td className="rt-actions">
                  <Button size="sm" disabled={busy === p.id} onClick={() => void test(p)}>
                    {busy === p.id ? "..." : "Test"}
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy === p.id} onClick={() => setDeleting(p)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {testing && (
        <Modal title={`Test result: ${label(rows.find((r) => r.id === testing.id) ?? { id: testing.id, provider: "", isActive: false })}`} onClose={() => setTesting(null)} width={640}>
          <pre className="rt-json">{JSON.stringify(testing.result, null, 2)}</pre>
        </Modal>
      )}
      {deleting && (
        <ConfirmModal
          title="Delete provider?"
          confirmLabel="Delete"
          busy={busy === deleting.id}
          onConfirm={() => {
            const target = deleting;
            void act(target.id, () => window.ninerh.router.deleteProvider(target.id)).then(() => setDeleting(null));
          }}
          onClose={() => setDeleting(null)}
        >
          Remove <strong>{label(deleting)}</strong> ({deleting.provider}) from 9router. Requests routed through it will fall back to other connections.
        </ConfirmModal>
      )}
    </div>
  );
}
