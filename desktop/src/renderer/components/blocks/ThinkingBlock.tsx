/**
 * Streaming model reasoning. In quiet mode it collapses to the first line,
 * dimmed, with a toggle to expand.
 */

import { useState } from "react";
import "./blocks.css";

export function ThinkingBlock(props: { text: string; quiet: boolean }) {
  const [open, setOpen] = useState(false);
  const collapsed = props.quiet && !open;
  const firstLine = props.text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return (
    <div className={collapsed ? "thinking is-collapsed" : "thinking"}>
      {props.quiet ? (
        <button
          type="button"
          className="thinking-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "expand thinking" : "collapse thinking"}
          onClick={() => setOpen((v) => !v)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      ) : null}
      <div className="thinking-text">{collapsed ? firstLine : props.text}</div>
    </div>
  );
}
