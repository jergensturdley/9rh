/**
 * One-line loop bookkeeping marker (iteration, continuation, repair, ...).
 * Detail text, when present, sits behind a native disclosure.
 */

import type { TranscriptBlock } from "@renderer/state/types";
import "./blocks.css";

type MarkerBlock = Extract<TranscriptBlock, { kind: "marker" }>;

const ICONS: Record<MarkerBlock["variant"], string> = {
  iteration: "↻",
  continuation: "→",
  model_switch: "⇄",
  compact: "⌸",
  repair_start: "⚙",
  repair_success: "✔",
  escalate: "▲",
  circuit_open: "⚠",
  incident: "⚠",
  spec_plan: "☰",
  branch_create: "⑂",
  sandbox_health: "▣",
  step_inspect: "⌕",
  partial_output: "…",
};

export function MarkerRow(props: { block: MarkerBlock }) {
  const { block } = props;
  const body = (
    <>
      <span className="marker-icon" aria-hidden="true">
        {ICONS[block.variant]}
      </span>
      <span className="marker-text">{block.text}</span>
    </>
  );
  if (!block.detail) return <div className={`marker marker-${block.variant}`}>{body}</div>;
  return (
    <details className={`marker marker-${block.variant}`}>
      <summary className="marker-summary">{body}</summary>
      <pre className="marker-detail">{block.detail}</pre>
    </details>
  );
}
