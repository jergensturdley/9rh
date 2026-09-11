/**
 * Left rail: one button per page. Cmd/Ctrl+1..4 shortcuts are handled by
 * the App; the rail only shows them in tooltips.
 */

import "./Nav.css";

export type Page = "agent" | "router" | "replays" | "settings";

export const PAGES: ReadonlyArray<{ id: Page; label: string; glyph: string }> = [
  { id: "agent", label: "Agent", glyph: "◉" },
  { id: "router", label: "Router", glyph: "⇄" },
  { id: "replays", label: "Replays", glyph: "▶" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function Nav(props: { page: Page; onChange: (p: Page) => void }) {
  return (
    <nav className="nav" aria-label="pages">
      <div className="nav-brand" aria-hidden="true">
        9rh
      </div>
      {PAGES.map((p, i) => (
        <button
          key={p.id}
          type="button"
          className={p.id === props.page ? "nav-item is-active" : "nav-item"}
          aria-current={p.id === props.page ? "page" : undefined}
          title={`${p.label} (${MOD}${i + 1})`}
          onClick={() => props.onChange(p.id)}
        >
          <span className="nav-glyph" aria-hidden="true">
            {p.glyph}
          </span>
          <span className="nav-label">{p.label}</span>
        </button>
      ))}
    </nav>
  );
}
