/**
 * Cmd+K command palette: a top-anchored overlay with a search input and a
 * grouped, keyboard-navigable action list. State lives in the inner body so
 * every open starts with a blank query and the cursor on the first item.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { filterActions, type PaletteAction } from "./palette";
import "./CommandPalette.css";

export type { PaletteAction } from "./palette";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

export function CommandPalette(props: CommandPaletteProps) {
  return props.open ? <PaletteBody onClose={props.onClose} actions={props.actions} /> : null;
}

function PaletteBody({ onClose, actions }: Omit<CommandPaletteProps, "open">) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const visible = useMemo(() => filterActions(actions, query), [actions, query]);
  const active = Math.min(cursor, Math.max(0, visible.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, visible]);

  const run = (a: PaletteAction): void => {
    onClose();
    a.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(active + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = visible[active];
      if (a) run(a);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const items: React.ReactNode[] = [];
  let lastGroup: string | null = null;
  visible.forEach((a, i) => {
    if (a.group !== lastGroup) {
      lastGroup = a.group;
      items.push(
        <li key={`g:${a.group}`} className="palette-group" role="presentation">
          {a.group}
        </li>,
      );
    }
    items.push(
      <li
        key={a.id}
        role="option"
        aria-selected={i === active}
        className={i === active ? "palette-item is-active" : "palette-item"}
        onMouseEnter={() => setCursor(i)}
        onClick={() => run(a)}
      >
        <span className="palette-label">{a.label}</span>
        {a.hint ? <span className="palette-hint">{a.hint}</span> : null}
      </li>,
    );
  });

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          spellCheck={false}
          placeholder="Type a command..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          aria-controls="palette-list"
        />
        <ul id="palette-list" ref={listRef} className="palette-list" role="listbox">
          {items.length > 0 ? items : <li className="palette-empty">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
