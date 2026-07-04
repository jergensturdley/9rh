# TUI: right-column full-height + streamed word-wrap

Status: proposed (not implemented)
Scope: `src/tui.ts`, `src/__tests__/tui.test.ts`
Owner: TBD

## Problem

Two related defects in the live two-column TUI renderer (`createTuiRenderer` in `src/tui.ts:604`):

1. **Right column does not extend to the bottom of the terminal.** The dashboard (`renderDashboardLines` at `src/tui.ts:514`) emits a fixed number of rows; `drawDashboard()` at `src/tui.ts:641` clears the previous area but does not fill empty rows down to `process.stdout.rows`. On a tall terminal the user sees a short floating panel with the bottom 60–80% of the right column as blank space — visually broken and inconsistent with the "two columns" metaphor the layout implies.
2. **Streamed output is not word-wrapped to the left column's width.** `partial_output` chunks (`src/tui.ts:1002`) and the final `done` summary (`src/tui.ts:928-944`) print raw, with the only post-processing being `normalizeWhitespace` and a `wrapText` call on the *final* summary. Streamed text (and tool_result previews) can run off the right edge of the terminal, crashing into the dashboard or wrapping the terminal itself, especially when the user has resized.

## Goals

- G1. The right column visually fills from the top of the dashboard (`row 2`) to the last terminal row.
- G2. Streamed text (thinking snapshots, `partial_output`, tool previews, final summary) is word-wrapped to a width derived from the left column's available space, accounting for the dashboard's column reservation.
- G3. Both behaviors recompute on terminal resize (SIGWINCH) and on first draw after launch.
- G4. Existing tests still pass; new tests cover fill-to-bottom and wrap-at-column-edge.
- G5. No new dependencies. Only Node stdlib (`process.stdout.rows/columns`) and existing helpers (`wrapText` at `src/tui.ts:280`, `visibleLength`, `padVisible`).

## Non-goals

- Not adding scrolling, alternate-screen buffer, or full redraw on every event. The current diff-based `drawDashboard` pattern stays.
- Not wrapping spinners, status lines, or `─`/`═` separator lines. Only prose.
- Not touching `splash.ts`, `visualization.ts`, or the run-report generator.

## Current behavior (recap)

- `cols()` (`src/tui.ts:215`) reads `process.stdout.columns ?? 80`.
- `boxWidth()` (`src/tui.ts:219`) caps at `cols() - 4`, max 76 — this is the *centered single-column* width, not the two-column geometry.
- `drawDashboard()` writes to `\x1b[${2 + i};${dashCol}H` where `dashCol = termWidth - dashWidth + 1` and `dashWidth = max(36, min(floor(termWidth * 0.28), 48))` (`src/tui.ts:643-646`).
- `lastDashboardHeight` tracks the *content* height (`src/tui.ts:658`); the cleared region is `Math.max(lines.length, lastDashboardHeight)` rows.
- Streamed prose is emitted via `process.stdout.write` with no width math (`partial_output` at `src/tui.ts:1002`, tool previews at `src/tui.ts:846-857`, thinking snapshot at `src/tui.ts:662`).

There is no `rows()` helper, no SIGWINCH listener, and no notion of "left column width."

## Proposed design

### 1. Geometry

Compute one source of truth — a `geometry` object computed on launch and on every resize:

```
geometry = {
  termCols,         // process.stdout.columns ?? 80
  termRows,         // process.stdout.rows    ?? 24
  dashWidth,        // max(36, min(floor(termCols * 0.28), 48))
  dashCol,          // termCols - dashWidth + 1
  leftColWidth,     // termCols - dashWidth - 1   // 1-col gutter
  leftInner,        // leftColWidth - 2            // after 2-space indent
  wrapWidth,        // leftInner                   // what wrapText() sees
}
```

- `leftColWidth` is everything left of the dashboard, with a 1-column gutter.
- `leftInner` is the printable text area after the 2-space indent already used by spinners, tool lines, and the summary.
- `wrapWidth` is the value passed to `wrapText()`.

### 2. New helpers (additive, exported for testability)

| Function | Purpose |
|---|---|
| `rows(): number` | `process.stdout.rows ?? 24` — mirrors `cols()` at `src/tui.ts:215`. |
| `computeGeometry(termCols: number, termRows: number): Geometry` | Pure function: returns the `geometry` object. **Testable in isolation.** |
| `padDashboardToHeight(lines: string[], target: number): string[]` | Appends `│${' '.repeat(inner + 2)}│` rows so the panel hits `target` rows. Caps at `target` if `lines.length > target` (truncate from the top is **not** correct — instead, leave the content taller and let `drawDashboard` clear+redraw with the new height). |
| `wrapStreamChunk(text: string, wrapWidth: number): string` | Wraps each `\n`-delimited line of `text` independently, joins with `\n`. Distinct from `wrapText` (which collapses paragraphs); this preserves newlines so streamed chunks don't get smushed together. |

`wrapStreamChunk` is the key new primitive for streamed output. Current `wrapText` at `src/tui.ts:280` collapses runs of whitespace via `.split(/\s+/)` — fine for the final summary, wrong for live deltas where newlines carry meaning. Either:
- (a) keep `wrapText` as-is and add `wrapStreamChunk` alongside it, or
- (b) make `wrapText` accept an option `{ collapseWhitespace?: boolean }` defaulting to `true`.

Recommend **(a)** — single-purpose helpers, easier to test, no risk of regressing `done`-summary callers.

### 3. `drawDashboard` rewrite

Replace the clear-loop at `src/tui.ts:650-653`:

```
const targetHeight = Math.max(lines.length, geometry.termRows - 1);
const padded = padDashboardToHeight(lines, targetHeight);
// Clear lastDashboardHeight rows, draw padded.length rows.
```

Notes:
- The first dashboard row is at `row 2` (1-based) per the existing `\x1b[${2 + i}…` write; subtract 1 from `termRows` so we don't try to clear the last terminal row (some terminals scroll on bottom-row clear).
- On a tall terminal the padded rows are blank `│…│` boxes. On a *short* terminal (`termRows < lines.length`) the dashboard exceeds the screen — current behavior. Acceptable; the user can grow the window.

### 4. Wrap integration points

For each prose-emitting site, route through `wrapStreamChunk` and indent the wrapped output to match the existing 2-space left margin.

| Site | Current (line) | Change |
|---|---|---|
| `printThinkingSnapshot` body | `src/tui.ts:662-675` | `process.stdout.write(wrapStreamChunk(snippet, geometry.wrapWidth - 2))` prefixed with `  ⚡ ` once, then `  ` for continuation lines. |
| `partial_output` case | `src/tui.ts:1002-1009` | Buffer last partial chunk, wrap on emission. Re-enter: `\n` from the model already carries semantics — wrap each line independently. |
| `tool_result` preview (success) | `src/tui.ts:846-857` | Wrap the 6-line preview at `geometry.wrapWidth - 4` (account for `  ` + `✓ ` prefix). |
| `tool_result` error `drawBox` | `src/tui.ts:843` | `drawBox` already has a width cap via `boxWidth()`; switch to `geometry.wrapWidth + 2` so the box fits the left column. |
| `done` summary wrap | `src/tui.ts:938-942` | Replace `boxWidth()` with `geometry.wrapWidth`. |
| `step_inspect` `drawBox` | `src/tui.ts:998` | Same as `tool_result` error. |
| `spec_plan` `drawBox` | `src/tui.ts:906` | Same. |

The dashboard's `print*` calls (`renderDashboardLines`) are **not** affected — they have their own internal width math and render only inside the right column.

### 5. Resize handling

- On `createTuiRenderer` construction, attach `process.stdout.on('resize', recompute)`. On every event, the cached `geometry` is consulted; on resize it is recomputed and `drawDashboard()` is called once to re-anchor the panel at the new `dashCol` and new height.
- Detach on a new `dispose()` method exported from the closure (out of scope for this spec's tests, but the listener must be removable to avoid leaks in long-lived REPL sessions). Add `dispose()` only if a caller exists or a follow-up issue owns it — otherwise leave a `// TODO(resize-cleanup)` comment near the listener.

### 6. Buffer for streamed wrap

`partial_output` arrives in arbitrary chunks. Naive per-chunk `wrapStreamChunk` will re-wrap the entire visible history every event, which is fine at human-typing speeds but wasteful. Two acceptable approaches:

- **A. Stateless (recommended for v1).** Keep a small per-step buffer (`stepId -> string`), flush with `wrapStreamChunk` on emission. Truncate to the last N wrapped lines (`N = geometry.termRows`) to bound memory. Test the wrap on a synthetic 10KB stream — should not OOM and should produce a deterministic wrapped output.
- **B. Stateful line buffer.** Track incomplete trailing line across chunks, only wrap completed lines. Lower allocation but more state. Defer until A proves insufficient.

Pick **A** for this spec; revisit if profiling shows it's a hotspot.

## Files & functions (exact)

| File | Change |
|---|---|
| `src/tui.ts` | Add `rows()`, `computeGeometry()`, `padDashboardToHeight()`, `wrapStreamChunk()`. Cache `geometry` in `createTuiRenderer`. Update `drawDashboard` to pad to `termRows - 1`. Attach SIGWINCH listener. Route `printThinkingSnapshot`, `partial_output`, tool_result preview, and `done` summary through `wrapStreamChunk`. Switch `drawBox` callers from `boxWidth()` to `geometry.wrapWidth + 2` for left-column use. |
| `src/__tests__/tui.test.ts` | New `describe` blocks (see Test plan). |

## Test plan

All new tests run with the existing Jest setup; no infra changes.

### `computeGeometry`
- 80×24: `dashWidth=22` (min floor 80*0.28=22.4→22), `leftColWidth=57`, `leftInner=55`, `wrapWidth=55`.
- 120×40: `dashWidth=33` (floor 33.6→33), `leftColWidth=86`, `leftInner=84`.
- 40×20: `dashWidth=36` (min), `leftColWidth=3`. `leftInner=1`. Wrap still safe (`wrapText` returns text unchanged at width≤0; `wrapStreamChunk` should similarly guard).
- 0×0 (no TTY): falls back to 80×24.

### `padDashboardToHeight`
- 5-line content, target 20: appends 15 `│${' '.repeat(inner+2)}│` rows.
- 25-line content, target 20: returns the 25 lines unchanged (caller responsibility to truncate, per §3 note).
- target ≤ 0: returns input unchanged.
- Inner width 0: emits `│${' '}│` (the existing `lines.push` pattern at `src/tui.ts:528`).

### `wrapStreamChunk`
- Single line shorter than width: unchanged.
- Single line longer than width: word-broken at width, single long token hard-wrapped.
- Multi-line input (embedded `\n`): each line wrapped independently, `\n` preserved.
- All-whitespace line: emits empty string for that line (preserves the row count).
- Width 0: passthrough.
- ANSI in input: defer to caller — `wrapStreamChunk` should document that callers must strip ANSI before passing, mirroring `visibleLength`'s contract. (Adding ANSI-aware wrapping is out of scope.)

### `drawDashboard` fill-to-bottom (integration)
- Mock `process.stdout` to capture writes. Stub `process.stdout.columns=80, rows=30, isTTY=true`.
- Construct a renderer, emit a single `iteration` event.
- Assert: the writes include `\x1b[<30-1=29>;1H\x1b[0K` (a clear at the last dashboard-able row) **or** an equivalent set of clears whose row positions cover `2..termRows-1`.
- Easier alternative: export `padDashboardToHeight` and test it directly (preferred — keeps the test deterministic without ANSI capture).

### `done` summary wrap
- Emit a `done` event whose `text` is 200 chars of single-token nonsense.
- Assert the captured stdout contains at least 2 lines and each line's `visibleLength` ≤ `geometry.wrapWidth`.

### Resize
- Set `process.stdout.columns=80, rows=24`, emit `iteration`. Capture the `dashCol` from the first `\x1b[...;XH` write.
- Emit a `resize` event with new dimensions 120×40 (or set `process.stdout.columns=120, rows=40` and call the internal `recompute` if exposed). Emit `iteration` again.
- Assert new `dashCol` reflects 120-col geometry.
- This requires exposing `recompute` from the closure, or testing the geometry-recompute in isolation. Recommend the latter.

## Verification

- `npm run build` — `tsc` must succeed.
- `npm test -- tui.test.ts` — all new and existing tests pass.
- Manual: in a 200×60 terminal, launch `npm run dev` and run a streaming task. Confirm dashboard fills to row 60, no streamed line exceeds the left column width, resizing the window mid-run re-anchors the dashboard and re-wraps the next emitted chunk.
- Manual: in a 60×20 terminal, confirm dashboard still fits the content and streamed wrap uses ~28 cols.
- Manual: in a non-TTY (`./dist/cli.js` piped to `cat`), confirm early-return paths in `drawDashboard` (existing `if (!process.stdout.isTTY) return;` at `src/tui.ts:642`) still skip work.

## Risks

- **R1.** ANSI escape sequences in the output may confuse `visibleLength` if a wrap inserts a newline mid-escape. Mitigation: wrap is per-line, and per-line content already goes through chalk in callers; do not wrap inside chalk-tagged strings. Document in `wrapStreamChunk` docstring.
- **R2.** SIGWINCH firing mid-`write` can interleave. Mitigation: wrap `drawDashboard` body in a `let drawing = false; if (drawing) return; drawing = true; ... finally drawing = false;` guard. Cheap, drops a redraw rather than corrupting the screen.
- **R3.** The right column is "filler" rows with no content — at very tall terminals the user sees 80+ empty box rows. Acceptable; the alternative (no border, just blank space) breaks the visual contract of the panel. If this becomes noisy, follow up by collapsing the bottom border (`╰…╯` only at the bottom row, no `│…│` filler) — out of scope here.
- **R4.** The malware-analysis hook on `Read` blocks improvements to `tui.ts` in this session. Apply the changes in a follow-up session where the hook is not active, or via a subagent that reads only this spec (not the file).

## Out of scope

- Replacing the diff-based dashboard with a full redraw on every event.
- Mouse support, scrollback, copy/paste.
- A third column.
- TUI theme configuration.
- Test coverage for `splash.ts` (separate concern, splash already passes).
