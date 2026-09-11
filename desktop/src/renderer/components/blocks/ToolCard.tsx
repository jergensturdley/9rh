/**
 * One tool call and its result: name, target summary, running spinner,
 * six-line output preview that expands, error styling, copy and duration.
 */

import { useState } from "react";
import type { TranscriptBlock } from "@renderer/state/types";
import { describeToolTarget } from "@renderer/state/types";
import { Spinner, formatDuration } from "../ui";
import "./blocks.css";

type ToolBlock = Extract<TranscriptBlock, { kind: "tool" }>;

const PREVIEW_LINES = 6;

export function ToolCard(props: { block: ToolBlock }) {
  const { block } = props;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const target = describeToolTarget(block.name, block.args);
  const output = block.error ? `${block.output ? block.output + "\n" : ""}${block.error}` : (block.output ?? "");
  const lines = output.split("\n");
  const overflow = lines.length > PREVIEW_LINES;
  const shown = open || !overflow ? output : lines.slice(0, PREVIEW_LINES).join("\n");
  const duration = block.endedTs !== undefined ? formatDuration(block.endedTs - block.ts) : null;
  const argsJson = JSON.stringify(block.args, null, 2);

  const copy = (): void => {
    void navigator.clipboard.writeText(output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={`tool tool-${block.status}`}>
      <div className="tool-head">
        <span className="tool-status" aria-label={block.status}>
          {block.status === "running" ? <Spinner /> : block.status === "error" ? "✖" : "✔"}
        </span>
        <span className="tool-name mono">{block.name}</span>
        <span className="tool-target mono ellipsis" title={target}>
          {target}
        </span>
        {duration ? <span className="tool-duration muted">{duration}</span> : null}
        {output ? (
          <button type="button" className="tool-btn" onClick={copy} aria-label="copy output">
            {copied ? "copied" : "copy"}
          </button>
        ) : null}
        <button
          type="button"
          className="tool-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "collapse tool card" : "expand tool card"}
        >
          {open ? "less" : "more"}
        </button>
      </div>
      {open ? (
        <details className="tool-args" open={!target}>
          <summary>args</summary>
          <pre className="tool-pre">{argsJson}</pre>
        </details>
      ) : null}
      {shown ? (
        <pre className={open ? "tool-pre tool-output is-open" : "tool-pre tool-output"}>{shown}</pre>
      ) : block.status === "running" ? (
        <div className="tool-waiting muted">running...</div>
      ) : null}
      {!open && overflow ? (
        <button type="button" className="tool-more" onClick={() => setOpen(true)}>
          {lines.length - PREVIEW_LINES} more lines
        </button>
      ) : null}
    </div>
  );
}
