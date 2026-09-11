/**
 * Model chooser: a filter box over a list loaded by the caller (session
 * listModels, or the router catalog before a session exists), plus a free
 * text entry for ids the list does not know.
 */

import { useEffect, useRef, useState } from "react";
import type { IpcResult, ModelInfo } from "@shared/ipc";
import { Modal } from "./Modal";
import { Button, ErrorNote, Spinner } from "./ui";
import "./ModelPicker.css";

export function ModelPicker(props: {
  value: string;
  load: (filter: string) => Promise<IpcResult<ModelInfo[]>>;
  onPick: (model: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  const load = async (): Promise<void> => {
    const mine = ++gen.current;
    setError(null);
    const res = await props.load("");
    if (mine !== gen.current) return;
    if (res.ok) setModels(res.value);
    else setError(res.error);
  };

  useEffect(() => {
    void load();
    return () => {
      gen.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = filter.trim().toLowerCase();
  const shown = (models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || (m.owned_by ?? "").toLowerCase().includes(q));
  const exact = shown.some((m) => m.id === filter.trim());

  return (
    <Modal title="Choose a model" onClose={props.onClose} width={560}>
      <form
        className="mp-filter row gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = filter.trim();
          if (t) props.onPick(t);
        }}
      >
        <input
          className="grow"
          autoFocus
          placeholder="Filter, or type a model id and press Enter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="model filter"
        />
        <Button size="sm" type="submit" disabled={!filter.trim() || exact}>
          Use id
        </Button>
      </form>
      {error ? <ErrorNote message={error} onRetry={() => void load()} /> : null}
      {models === null && !error ? (
        <div className="mp-loading">
          <Spinner />
        </div>
      ) : null}
      {models !== null ? (
        <ul className="mp-list" role="listbox" aria-label="models">
          {shown.length === 0 ? <li className="muted mp-empty">No models match.</li> : null}
          {shown.map((m) => (
            <li key={m.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={m.id === props.value}
                className={m.id === props.value ? "mp-item is-current" : "mp-item"}
                onClick={() => props.onPick(m.id)}
              >
                <span className="mono ellipsis">{m.id}</span>
                {m.owned_by ? <span className="muted">{m.owned_by}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}
