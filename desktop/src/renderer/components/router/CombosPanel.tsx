import { useEffect, useState } from "react";
import type { RouterCombo } from "@shared/routerTypes";
import { Button, EmptyState, ErrorNote, Spinner } from "@renderer/components/ui";
import { useRouterResource } from "@renderer/state/routerStore";
import { ComboEditor } from "./ComboEditor";
import { ConfirmModal } from "./StatusCard";
import "./router.css";

type Editor = { mode: "new" } | { mode: "edit"; combo: RouterCombo };

export function CombosPanel(props: { refreshSignal?: number }) {
  const combos = useRouterResource("combos");
  const [editor, setEditor] = useState<Editor | null>(null);
  // The model catalog is only needed while the editor is open; no polling.
  const models = useRouterResource("models", { enabled: editor !== null, pollMs: 0 });
  const [deleting, setDeleting] = useState<RouterCombo | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (props.refreshSignal) void combos.refresh();
  }, [props.refreshSignal]);

  async function remove(c: RouterCombo): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await window.ninerh.router.deleteCombo(c.id);
    if (!res.ok) setActionError(res.error);
    setBusy(false);
    setDeleting(null);
    await combos.refresh();
  }

  return (
    <div className="rt-panel">
      <div className="rt-toolbar">
        <Button variant="primary" size="sm" onClick={() => setEditor({ mode: "new" })}>
          New combo
        </Button>
        <span className="rt-note">{combos.data?.length ?? 0} combos</span>
        <span className="rt-spacer" />
        {combos.loading && <Spinner />}
      </div>
      {actionError && <ErrorNote message={actionError} />}
      {combos.error && <ErrorNote message={combos.error} onRetry={() => void combos.refresh()} />}
      {combos.data && combos.data.length === 0 ? (
        <EmptyState title="No combos" hint="A combo is a named fallback chain of models." />
      ) : (
        <table className="rt-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th className="rt-num">Models</th>
              <th>Chain</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(combos.data ?? []).map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.kind ?? "default"}</td>
                <td className="rt-num">{c.models.length}</td>
                <td className="rt-mono">
                  {c.models.slice(0, 3).join(", ")}
                  {c.models.length > 3 ? `, +${c.models.length - 3} more` : ""}
                </td>
                <td className="rt-actions">
                  <Button size="sm" onClick={() => setEditor({ mode: "edit", combo: c })}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(c)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editor && (
        <ComboEditor
          combo={editor.mode === "edit" ? editor.combo : null}
          models={models.data}
          modelsError={models.error}
          onSaved={() => {
            setEditor(null);
            void combos.refresh();
          }}
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <ConfirmModal title="Delete combo?" confirmLabel="Delete" busy={busy} onConfirm={() => void remove(deleting)} onClose={() => setDeleting(null)}>
          Delete <strong>{deleting.name}</strong>. Clients that request it by name will get an unknown-model error.
        </ConfirmModal>
      )}
    </div>
  );
}
