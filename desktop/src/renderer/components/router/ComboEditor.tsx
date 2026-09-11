import { useMemo, useState } from "react";
import type { RouterCombo, RouterModel } from "@shared/routerTypes";
import { Button, ErrorNote, Spinner } from "@renderer/components/ui";
import { Modal } from "@renderer/components/Modal";
import "./router.css";

export function ComboEditor(props: {
  combo: RouterCombo | null;
  models: RouterModel[] | null;
  modelsError: string | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.combo?.name ?? "");
  const [models, setModels] = useState<string[]>(props.combo?.models ?? []);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !props.models) return [];
    const chosen = new Set(models);
    return props.models
      .filter((m) => !chosen.has(m.fullModel) && (m.fullModel.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)))
      .slice(0, 30);
  }, [query, props.models, models]);

  function move(i: number, dir: -1 | 1): void {
    const j = i + dir;
    if (j < 0 || j >= models.length) return;
    const next = models.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    setModels(next);
  }

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    if (models.length === 0) {
      setError("Add at least one model.");
      return;
    }
    setSaving(true);
    setError(null);
    const input = { name: trimmed, models, kind: props.combo?.kind ?? null };
    const res = props.combo ? await window.ninerh.router.updateCombo(props.combo.id, input) : await window.ninerh.router.createCombo(input);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    props.onSaved();
  }

  return (
    <Modal title={props.combo ? `Edit combo: ${props.combo.name}` : "New combo"} onClose={props.onClose} width={560}>
      <div className="rt-field">
        <label htmlFor="rt-combo-name">Name</label>
        <input id="rt-combo-name" className="rt-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="rt-field">
        <label>Models, in fallback order</label>
        {models.length === 0 ? (
          <span className="rt-note">No models yet. Search below to add one.</span>
        ) : (
          <ul className="rt-combo-models">
            {models.map((id, i) => (
              <li key={id}>
                <span className="rt-combo-idx">{i + 1}</span>
                <span className="rt-combo-id" title={id}>
                  {id}
                </span>
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="move up">
                  Up
                </Button>
                <Button size="sm" variant="ghost" disabled={i === models.length - 1} onClick={() => move(i, 1)} aria-label="move down">
                  Down
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setModels(models.filter((m) => m !== id))} aria-label="remove">
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rt-field">
        <label htmlFor="rt-combo-search">Add model</label>
        <input
          id="rt-combo-search"
          className="rt-input"
          placeholder={props.models ? "Search by id or name" : "Loading models..."}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {props.modelsError && <ErrorNote message={props.modelsError} />}
        {!props.models && !props.modelsError && <Spinner />}
        {results.length > 0 && (
          <ul className="rt-search-results">
            {results.map((m) => (
              <li
                key={m.fullModel}
                role="option"
                aria-selected={false}
                tabIndex={0}
                onClick={() => {
                  setModels([...models, m.fullModel]);
                  setQuery("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setModels([...models, m.fullModel]);
                    setQuery("");
                  }
                }}
              >
                <span className="rt-mono">{m.fullModel}</span>
                <span className="rt-note">
                  {m.provider}
                  {m.name ? ` · ${m.name}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {query.trim() && props.models && results.length === 0 && <span className="rt-note">No matching models.</span>}
      </div>
      {error && <ErrorNote message={error} />}
      <div className="rt-modal-actions">
        <Button variant="ghost" onClick={props.onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </Modal>
  );
}
