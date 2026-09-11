import { useEffect, useState } from "react";
import type { RouterApiKey } from "@shared/routerTypes";
import { Badge, Button, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui";
import { Modal } from "@renderer/components/Modal";
import { useRouterResource } from "@renderer/state/routerStore";
import { ConfirmModal } from "./StatusCard";
import { maskKey, relativeTime } from "./format";
import "./router.css";

export function KeysPanel(props: { refreshSignal?: number }) {
  const keys = useRouterResource("keys");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string; created: RouterApiKey | null } | null>(null);
  const [deleting, setDeleting] = useState<RouterApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (props.refreshSignal) void keys.refresh();
  }, [props.refreshSignal]);

  useEffect(() => {
    if (!copiedId) return;
    const t = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(t);
  }, [copiedId]);

  function copy(id: string, value: string): void {
    void navigator.clipboard.writeText(value);
    setCopiedId(id);
  }

  function toggleReveal(id: string): void {
    const next = new Set(revealed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setRevealed(next);
  }

  async function create(): Promise<void> {
    if (!creating) return;
    const name = creating.name.trim();
    if (!name) {
      setActionError("Name is required.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const res = await window.ninerh.router.createKey(name);
    setBusy(false);
    if (!res.ok) {
      setActionError(res.error);
      return;
    }
    setCreating({ name, created: res.value });
    await keys.refresh();
  }

  async function remove(k: RouterApiKey): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await window.ninerh.router.deleteKey(k.id);
    if (!res.ok) setActionError(res.error);
    setBusy(false);
    setDeleting(null);
    await keys.refresh();
  }

  return (
    <div className="rt-panel">
      <div className="rt-toolbar">
        <Button variant="primary" size="sm" onClick={() => setCreating({ name: "", created: null })}>
          New key
        </Button>
        <span className="rt-note">{keys.data?.length ?? 0} keys</span>
        <span className="rt-spacer" />
        {keys.loading && <Spinner />}
      </div>
      {actionError && !creating && <ErrorNote message={actionError} />}
      {keys.error && <ErrorNote message={keys.error} onRetry={() => void keys.refresh()} />}
      {keys.data && keys.data.length === 0 ? (
        <EmptyState title="No API keys" hint="Create one to let clients call the router's /v1 endpoints." />
      ) : (
        <table className="rt-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Active</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(keys.data ?? []).map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td className="rt-mono">{revealed.has(k.id) ? k.key : maskKey(k.key)}</td>
                <td>
                  <Badge tone={k.isActive ? "ok" : "muted"}>{k.isActive ? "active" : "inactive"}</Badge>
                </td>
                <td>{relativeTime(k.createdAt)}</td>
                <td className="rt-actions">
                  <Button size="sm" variant="ghost" onClick={() => toggleReveal(k.id)}>
                    {revealed.has(k.id) ? "Hide" : "Reveal"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => copy(k.id, k.key)}>
                    {copiedId === k.id ? "Copied" : "Copy"}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(k)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <Modal title={creating.created ? "Key created" : "New API key"} onClose={() => setCreating(null)} width={520}>
          {creating.created ? (
            <>
              <p className="rt-note">Copy it now. The key stays visible in the list, but this is the moment to paste it into your client.</p>
              <pre className="rt-json">{creating.created.key}</pre>
              <div className="rt-modal-actions">
                <Button variant="primary" onClick={() => copy(creating.created!.id, creating.created!.key)}>
                  {copiedId === creating.created.id ? "Copied" : "Copy key"}
                </Button>
                <Button variant="ghost" onClick={() => setCreating(null)}>
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="rt-field">
                <label htmlFor="rt-key-name">Name</label>
                <input
                  id="rt-key-name"
                  className="rt-input"
                  autoFocus
                  value={creating.name}
                  onChange={(e) => setCreating({ name: e.target.value, created: null })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void create();
                  }}
                />
              </div>
              {actionError && <ErrorNote message={actionError} />}
              <div className="rt-modal-actions">
                <Button variant="ghost" onClick={() => setCreating(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void create()} disabled={busy}>
                  {busy ? "Creating..." : "Create"}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
      {deleting && (
        <ConfirmModal title="Delete API key?" confirmLabel="Delete" busy={busy} onConfirm={() => void remove(deleting)} onClose={() => setDeleting(null)}>
          Delete <strong>{deleting.name}</strong> ({maskKey(deleting.key)}). Clients using it will start getting 401s.
        </ConfirmModal>
      )}
    </div>
  );
}
