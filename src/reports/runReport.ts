import type {
  CompactionRecord,
  ErrorRecord,
  FileChangeRecord,
  ReasoningChunk,
  RepairRecord,
  RunReportData,
  RunStatus,
  ToolCallRecord,
} from "./runReportData.js";

/**
 * Render a `RunReportData` to a self-contained HTML document.
 *
 * Output characteristics:
 *   - Valid HTML5, single file, no external assets
 *   - Inline CSS, dark/light via `prefers-color-scheme`
 *   - System fonts, responsive, print-friendly
 *   - Tool call / file change / error sections are collapsible via <details>
 *   - All user-supplied strings are HTML-escaped
 *
 * The renderer is pure: same input -> same output, no I/O, no clock. The
 * caller is responsible for writing the result to disk and deciding the
 * file location.
 */
export function renderRunReport(data: RunReportData): string {
  const sections: string[] = [];

  sections.push(renderHeader(data));
  sections.push(renderSummaryCards(data));
  sections.push(renderReasoningSection(data.reasoning));
  sections.push(renderToolCallsSection(data.toolCalls));
  sections.push(renderFileChangesSection(data.fileChanges));
  sections.push(renderRepairsSection(data.repairs));
  sections.push(renderCompactionsSection(data.compactions));
  sections.push(renderErrorsSection(data.errors));
  sections.push(renderFooter(data));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>9rh run report — ${escapeHtml(data.runId)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main class="container">
${sections.join("\n")}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const BASE_CSS = `
:root {
  --bg: #ffffff;
  --bg-elev: #f6f8fa;
  --bg-code: #f6f8fa;
  --fg: #1f2328;
  --fg-muted: #656d76;
  --border: #d0d7de;
  --border-soft: #eaeef2;
  --accent: #0969da;
  --ok: #1a7f37;
  --warn: #bf8700;
  --err: #cf222e;
  --add: #e6ffec;
  --add-border: #abf2bc;
  --del: #ffebe9;
  --del-border: #ffcecb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-code: #161b22;
    --fg: #e6edf3;
    --fg-muted: #8d96a0;
    --border: #30363d;
    --border-soft: #21262d;
    --accent: #58a6ff;
    --ok: #3fb950;
    --warn: #d29922;
    --err: #f85149;
    --add: #033a16;
    --add-border: #196c2e;
    --del: #67060c;
    --del-border: #8e1519;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans",
               Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  font-size: 14px; line-height: 1.5; }
.container { max-width: 980px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 16px; margin: 32px 0 12px; padding-bottom: 6px;
     border-bottom: 1px solid var(--border-soft); }
h3 { font-size: 14px; margin: 16px 0 8px; }
.muted { color: var(--fg-muted); }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px;
       background: var(--bg-elev); border: 1px solid var(--border-soft);
       font-size: 11px; color: var(--fg-muted); margin-right: 4px; vertical-align: middle; }
.tag.ok    { color: var(--ok);    border-color: var(--ok); }
.tag.warn  { color: var(--warn);  border-color: var(--warn); }
.tag.err   { color: var(--err);   border-color: var(--err); }
.tag.router   { color: var(--accent); border-color: var(--accent); }
.tag.direct   { color: var(--accent); border-color: var(--accent); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
         gap: 12px; margin: 16px 0 24px; }
.card { padding: 12px 14px; border: 1px solid var(--border-soft);
        border-radius: 8px; background: var(--bg-elev); }
.card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
               color: var(--fg-muted); margin-bottom: 4px; }
.card .value { font-size: 18px; font-weight: 600; }
details { border: 1px solid var(--border-soft); border-radius: 6px;
          margin: 8px 0; background: var(--bg); }
details > summary { padding: 8px 12px; cursor: pointer; user-select: none;
                    font-weight: 500; list-style: none; display: flex;
                    align-items: center; gap: 8px; }
details > summary::-webkit-details-marker { display: none; }
details[open] > summary { border-bottom: 1px solid var(--border-soft); }
details > .body { padding: 12px; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px;
       font-size: 12px; }
.kv .k { color: var(--fg-muted); }
pre { background: var(--bg-code); border: 1px solid var(--border-soft);
       border-radius: 4px; padding: 8px 10px; font-size: 12px; line-height: 1.4;
       overflow-x: auto; font-family: ui-monospace, SFMono-Regular, "SF Mono",
                              Menlo, Consolas, "Liberation Mono", monospace; }
.diff { display: grid; grid-template-columns: max-content 1fr; gap: 0;
         font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
                       monospace; font-size: 12px; line-height: 1.45;
         border: 1px solid var(--border-soft); border-radius: 4px;
         overflow: hidden; }
.diff .ln { padding: 0 8px; color: var(--fg-muted); user-select: none;
            text-align: right; background: var(--bg-code); border-right: 1px solid var(--border-soft); }
.diff .src { padding: 0 10px; white-space: pre-wrap; word-break: break-word; }
.diff .add { background: var(--add); }
.diff .add .ln { background: var(--add); border-right-color: var(--add-border); }
.diff .del { background: var(--del); }
.diff .del .ln { background: var(--del); border-right-color: var(--del-border); }
.toolcall-args, .toolcall-output { font-size: 12px; }
.toolcall-output { white-space: pre-wrap; word-break: break-word; }
hr { border: none; border-top: 1px solid var(--border-soft); margin: 24px 0; }
.empty { color: var(--fg-muted); font-style: italic; padding: 8px 0; }
.footer { font-size: 12px; color: var(--fg-muted); margin-top: 32px; padding-top: 16px;
          border-top: 1px solid var(--border-soft); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--bg-code); padding: 1px 5px; border-radius: 3px;
        font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, "SF Mono",
                              Menlo, Consolas, monospace; }
@media print {
  body { background: white; color: black; }
  details { border: 1px solid #ccc; }
  details[open] > summary { border-bottom: 1px solid #ccc; }
  h2 { page-break-after: avoid; }
  details { page-break-inside: avoid; }
}
`;

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(data: RunReportData): string {
  const statusTag = renderStatusTag(data.status);
  const backendTag = `<span class="tag ${data.backendName}">${escapeHtml(data.backendName)}</span>`;
  return `
<header>
  <h1>9rh run report</h1>
  <div class="muted">
    ${statusTag}
    ${backendTag}
    <span class="tag">${escapeHtml(data.model)}</span>
  </div>
  <p class="muted" style="margin-top:8px">${escapeHtml(data.task)}</p>
</header>
`;
}

function renderSummaryCards(data: RunReportData): string {
  const cards: Array<[string, string]> = [
    ["Status", data.status],
    ["Duration", formatDuration(data.durationMs)],
    ["Steps", String(data.steps)],
    ["Tool calls", String(data.toolCalls.length)],
    ["Files changed", String(data.fileChanges.length)],
    ["Compactions", String(data.compactions.length || data.compactionCount)],
    ["Errors", String(data.errors.length)],
    ["Repairs", String(data.repairs.length)],
  ];
  if (data.tokenUsage) {
    cards.push(["Tokens", formatTokens(data.tokenUsage.total)]);
    cards.push(["Prompt", formatTokens(data.tokenUsage.prompt)]);
    cards.push(["Completion", formatTokens(data.tokenUsage.completion)]);
  }
  const cardsHtml = cards
    .map(
      ([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`,
    )
    .join("\n");
  return `<section class="cards">${cardsHtml}</section>`;
}

function renderReasoningSection(reasoning: ReasoningChunk[]): string {
  if (reasoning.length === 0) return "";
  // Concatenate, then collapse whitespace
  const fullText = reasoning
    .map((c) => c.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!fullText) return "";

  // For long reasoning, fold into a <details>
  const MAX_INLINE = 800;
  if (fullText.length <= MAX_INLINE) {
    return `
<h2>Reasoning</h2>
<div class="muted" style="margin-bottom:8px">${escapeHtml(String(reasoning.length))} chunk(s) of streamed thinking.</div>
<p>${escapeHtml(fullText)}</p>
`;
  }
  return `
<h2>Reasoning</h2>
<div class="muted" style="margin-bottom:8px">${escapeHtml(String(reasoning.length))} chunk(s) of streamed thinking.</div>
<details>
  <summary>Full reasoning (${escapeHtml(String(fullText.length))} chars)</summary>
  <div class="body"><p>${escapeHtml(fullText)}</p></div>
</details>
<p>${escapeHtml(fullText.slice(0, MAX_INLINE))}…</p>
`;
}

function renderToolCallsSection(toolCalls: ToolCallRecord[]): string {
  if (toolCalls.length === 0) {
    return `<h2>Tool calls</h2><div class="empty">no tool calls in this run</div>`;
  }
  const items = toolCalls
    .map((tc, i) => {
      const statusTag = tc.error
        ? `<span class="tag err">error</span>`
        : `<span class="tag ok">ok</span>`;
      const dur = tc.durationMs !== undefined ? ` · ${escapeHtml(formatDuration(tc.durationMs))}` : "";
      const args = JSON.stringify(tc.args, null, 2);
      const argsBody = `<pre class="toolcall-args">${escapeHtml(args)}</pre>`;
      const outBody = tc.error
        ? `<pre class="toolcall-output">${escapeHtml(tc.error)}</pre>`
        : tc.output
        ? `<pre class="toolcall-output">${escapeHtml(truncate(tc.output, 4000))}</pre>`
        : `<div class="muted">(no output)</div>`;
      return `
<details ${i < 3 ? "open" : ""}>
  <summary>${statusTag} <strong>${escapeHtml(tc.name)}</strong> <span class="muted">step ${escapeHtml(String(tc.step))}${dur}</span></summary>
  <div class="body">
    <h3>Arguments</h3>
    ${argsBody}
    <h3>Output</h3>
    ${outBody}
  </div>
</details>`;
    })
    .join("\n");
  return `<h2>Tool calls (${toolCalls.length})</h2>\n${items}`;
}

function renderFileChangesSection(changes: FileChangeRecord[]): string {
  if (changes.length === 0) {
    return `<h2>File changes</h2><div class="empty">no files modified in this run</div>`;
  }
  const items = changes
    .map((c) => {
      const opTag =
        c.operation === "create"
          ? `<span class="tag ok">created</span>`
          : `<span class="tag warn">edited</span>`;
      const diffHtml = renderDiff(c);
      return `
<details open>
  <summary>${opTag} <code>${escapeHtml(c.path)}</code> <span class="muted">step ${escapeHtml(String(c.step))}</span></summary>
  <div class="body">${diffHtml}</div>
</details>`;
    })
    .join("\n");
  return `<h2>File changes (${changes.length})</h2>\n${items}`;
}

function renderRepairsSection(repairs: RepairRecord[]): string {
  if (repairs.length === 0) {
    return `<h2>Repairs</h2><div class="empty">no repair attempts</div>`;
  }
  const items = repairs
    .map((r) => {
      const tag =
        r.outcome === "REPAIRED"
          ? `<span class="tag ok">repaired</span>`
          : r.outcome === "ESCALATED"
          ? `<span class="tag err">escalated</span>`
          : `<span class="tag warn">pending</span>`;
      return `<div>${tag} <span class="muted">step ${escapeHtml(String(r.step))} attempt ${escapeHtml(String(r.attempt))}</span> — ${escapeHtml(r.message)}</div>`;
    })
    .join("\n");
  return `<h2>Repairs (${repairs.length})</h2>\n${items}`;
}

function renderCompactionsSection(compactions: CompactionRecord[]): string {
  if (compactions.length === 0) {
    return `<h2>Compactions</h2><div class="empty">no context compactions</div>`;
  }
  const items = compactions
    .map((c) => `<div>⟳ <span class="muted">step ${escapeHtml(String(c.step))}</span> — ${escapeHtml(c.summary)}</div>`)
    .join("\n");
  return `<h2>Compactions (${compactions.length})</h2>\n${items}`;
}

function renderErrorsSection(errors: ErrorRecord[]): string {
  if (errors.length === 0) {
    return `<h2>Errors</h2><div class="empty">no errors</div>`;
  }
  const items = errors
    .map((e) => `<div><span class="tag err">error</span> <span class="muted">step ${escapeHtml(String(e.step))}</span> — ${escapeHtml(e.message)}</div>`)
    .join("\n");
  return `<h2>Errors (${errors.length})</h2>\n${items}`;
}

function renderFooter(data: RunReportData): string {
  const startedAt = new Date(data.startedAt).toISOString();
  const endedAt = new Date(data.endedAt).toISOString();
  const replay = data.replayLogPath
    ? `<div>Replay log: <code>${escapeHtml(data.replayLogPath)}</code></div>`
    : "";
  return `
<div class="footer">
  <div>runId: <code>${escapeHtml(data.runId)}</code></div>
  <div>started: ${escapeHtml(startedAt)}</div>
  <div>ended: ${escapeHtml(endedAt)}</div>
  ${replay}
</div>
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStatusTag(status: RunStatus): string {
  if (status === "completed") return `<span class="tag ok">completed</span>`;
  if (status === "aborted") return `<span class="tag warn">aborted</span>`;
  if (status === "max_iterations") return `<span class="tag warn">max iterations</span>`;
  return `<span class="tag err">error</span>`;
}

function renderDiff(change: FileChangeRecord): string {
  if (change.operation === "create" || !change.before) {
    const lines = (change.after ?? "").split("\n");
    const maxLines = 200;
    const shown = lines.slice(0, maxLines);
    const more = lines.length > maxLines ? `<div class="muted">… ${escapeHtml(String(lines.length - maxLines))} more lines</div>` : "";
    return `<div class="diff">${shown
      .map(
        (line, i) =>
          `<div class="ln">${escapeHtml(String(i + 1))}</div><div class="src add">${escapeHtml(line) || "&nbsp;"}</div>`,
      )
      .join("")}</div>${more}`;
  }
  // Side-by-side or unified? Use a simple unified diff via line-by-line comparison.
  const beforeLines = (change.before ?? "").split("\n");
  const afterLines = (change.after ?? "").split("\n");
  const diff = computeLineDiff(beforeLines, afterLines);
  const maxLines = 300;
  const shown = diff.slice(0, maxLines);
  const more = diff.length > maxLines ? `<div class="muted">… ${escapeHtml(String(diff.length - maxLines))} more diff lines</div>` : "";
  return `<div class="diff">${shown
    .map(
      (row) =>
        `<div class="ln">${escapeHtml(String(row.n))}</div><div class="src ${row.kind}">${escapeHtml(row.text) || "&nbsp;"}</div>`,
    )
    .join("")}</div>${more}`;
}

interface DiffRow {
  n: number;
  kind: "ctx" | "add" | "del";
  text: string;
}

/**
 * Minimal unified diff using a longest-common-subsequence approach.
 * Not as clever as git's diff, but good enough for the report.
 * O(n*m) — fine for the size of files an agent typically edits.
 */
function computeLineDiff(before: string[], after: string[]): DiffRow[] {
  const m = before.length;
  const n = after.length;
  // LCS length table
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (before[i - 1] === after[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }
  // Walk back to produce the edit script
  const out: DiffRow[] = [];
  let i = m;
  let j = n;
  let n_ = 0;
  while (i > 0 && j > 0) {
    if (before[i - 1] === after[j - 1]) {
      out.push({ n: ++n_, kind: "ctx", text: before[i - 1] });
      i--;
      j--;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      out.push({ n: ++n_, kind: "del", text: before[i - 1] });
      i--;
    } else {
      out.push({ n: ++n_, kind: "add", text: after[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ n: ++n_, kind: "del", text: before[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ n: ++n_, kind: "add", text: after[j - 1] });
    j--;
  }
  return out.reverse();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated ${s.length - max} chars)`;
}

/**
 * HTML-escape a string for safe insertion in HTML body / attribute values.
 * Escapes &, <, >, ", and '.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
