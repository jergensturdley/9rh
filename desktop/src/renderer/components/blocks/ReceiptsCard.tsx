/**
 * Receipts card closing a turn: status, duration, tokens, files with a Diff
 * button, commands, tool counts, assumptions, report link, then the model's
 * prose through a markdown-lite renderer (headers, code fences, inline code,
 * bold). No library.
 */

import type { TranscriptBlock } from "@renderer/state/types";
import { Badge, Button, formatDuration, formatTokens } from "../ui";
import "./blocks.css";

type ReceiptsBlock = Extract<TranscriptBlock, { kind: "receipts" }>;

const STATUS_ICON: Record<ReceiptsBlock["status"], string> = { completed: "✔", error: "✖", aborted: "■" };
const STATUS_TONE: Record<ReceiptsBlock["status"], "ok" | "err" | "warn"> = { completed: "ok", error: "err", aborted: "warn" };

export function ReceiptsCard(props: {
  block: ReceiptsBlock;
  onOpenDiff?: (turn: number, path: string) => void;
  onOpenReport?: (path: string) => void;
}) {
  const { block, onOpenDiff, onOpenReport } = props;
  const d = block.digest;
  const reportPath = block.reportPath ?? d?.reportPath;
  const toolCounts = d ? Object.entries(d.toolCounts).sort((a, b) => b[1] - a[1]) : [];
  return (
    <section className={`receipts receipts-${block.status}`} aria-label={`receipts for turn ${block.turn}`}>
      <header className="receipts-head">
        <span className={`receipts-icon tone-${STATUS_TONE[block.status]}`} aria-hidden="true">
          {STATUS_ICON[block.status]}
        </span>
        <span className="receipts-title">receipts</span>
        <Badge tone={STATUS_TONE[block.status]}>{block.status}</Badge>
        {d ? <span className="muted">{formatDuration(d.durationMs)}</span> : null}
        {d?.tokens ? (
          <span className="muted mono">
            {formatTokens(d.tokens.prompt)} in / {formatTokens(d.tokens.completion)} out
          </span>
        ) : null}
        {d ? <span className="muted">{d.steps} steps</span> : null}
      </header>

      {d ? (
        <dl className="receipts-grid">
          <dt>Goal</dt>
          <dd className="receipts-goal">{d.task}</dd>

          {d.files.length > 0 ? (
            <>
              <dt>Files</dt>
              <dd>
                <ul className="receipts-list">
                  {d.files.map((f) => (
                    <li key={f.path} className="receipts-file">
                      <span className="mono ellipsis" title={f.path}>
                        {f.path}
                      </span>
                      <span className="receipts-op muted">{f.operation}</span>
                      <span className="receipts-add">+{f.added}</span>
                      <span className="receipts-del">-{f.removed}</span>
                      {onOpenDiff && d.diffablePaths.includes(f.path) ? (
                        <Button size="sm" onClick={() => onOpenDiff(block.turn, f.path)}>
                          Diff
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}

          {d.commands.length > 0 ? (
            <>
              <dt>Ran</dt>
              <dd>
                <ul className="receipts-list">
                  {d.commands.map((c, i) => (
                    <li key={i} className="receipts-cmd">
                      <span className={c.ok ? "tone-ok" : "tone-err"} aria-label={c.ok ? "ok" : "failed"}>
                        {c.ok ? "✔" : "✖"}
                      </span>
                      <code className="ellipsis" title={c.command}>
                        {c.command}
                      </code>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}

          {toolCounts.length > 0 ? (
            <>
              <dt>Tools</dt>
              <dd className="receipts-tools">
                {toolCounts.map(([name, n]) => (
                  <span key={name} className="receipts-tool mono">
                    {name} <b>{n}</b>
                  </span>
                ))}
              </dd>
            </>
          ) : null}

          {d.assumptions && d.assumptions.length > 0 ? (
            <>
              <dt>Assumed</dt>
              <dd>
                <ul className="receipts-list receipts-assumptions">
                  {d.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}

          {reportPath ? (
            <>
              <dt>Report</dt>
              <dd>
                {onOpenReport ? (
                  <button type="button" className="receipts-link mono" onClick={() => onOpenReport(reportPath)}>
                    {reportPath}
                  </button>
                ) : (
                  <span className="mono">{reportPath}</span>
                )}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {block.text ? <div className="receipts-prose">{renderMarkdownLite(block.text)}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Markdown-lite
// ---------------------------------------------------------------------------

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

function renderInline(text: string): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/**
 * Headers become bold lines, fenced blocks become <pre>, blank lines split
 * paragraphs, inline code and bold are the only inline marks.
 * ponytail: no lists, links, or tables; upgrade to a real parser if prose
 * ever needs them.
 */
export function renderMarkdownLite(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let fence: string[] | null = null;
  const flush = (): void => {
    if (para.length === 0) return;
    const body = para.join("\n");
    out.push(
      <p key={out.length} className="md-p">
        {renderInline(body)}
      </p>,
    );
    para = [];
  };
  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith("```")) {
        out.push(
          <pre key={out.length} className="md-code">
            {fence.join("\n")}
          </pre>,
        );
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flush();
      fence = [];
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(
        <p key={out.length} className="md-h">
          {renderInline(h[2])}
        </p>,
      );
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    para.push(line);
  }
  if (fence) {
    out.push(
      <pre key={out.length} className="md-code">
        {fence.join("\n")}
      </pre>,
    );
  }
  flush();
  return out;
}
