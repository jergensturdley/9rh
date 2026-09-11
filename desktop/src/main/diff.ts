/**
 * Line diff for the before/after file records the ledger retains.
 *
 * Counting semantics match `countLineChanges` in the engine's ledger.ts:
 * both sides are split on "\n" (so a trailing newline yields an empty last
 * line on both sides), `before === undefined` is a pure creation, and
 * added/removed are `after.length - lcs` / `before.length - lcs`.
 */

import type { DiffLine } from "@shared/ipc";

/** Above this many lines on either side the DP table is not worth it. */
const MAX_LINES = 4000;

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

export function computeLineDiff(before: string | undefined, after: string): LineDiff {
  const b = after.split("\n");
  if (before === undefined) {
    return {
      lines: b.map((text, i) => ({ kind: "add", text, newLine: i + 1 })),
      added: b.length,
      removed: 0,
    };
  }
  const a = before.split("\n");
  if (before === after) {
    return {
      lines: a.map((text, i) => ({ kind: "context", text, oldLine: i + 1, newLine: i + 1 })),
      added: 0,
      removed: 0,
    };
  }
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // ponytail: whole-file replace above 4000 lines; swap in a Myers O(ND)
    // diff if large-file diffs ever matter in the UI.
    const lines: DiffLine[] = [{ kind: "context", text: "(diff too large; showing whole-file replace)" }];
    a.forEach((text, i) => lines.push({ kind: "remove", text, oldLine: i + 1 }));
    b.forEach((text, i) => lines.push({ kind: "add", text, newLine: i + 1 }));
    return { lines, added: b.length, removed: a.length };
  }

  // Full LCS table so the walk can be reconstructed. Cell (i, j) holds the
  // LCS length of a[i..] and b[j..]; Uint16 is enough for MAX_LINES.
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: "context", text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      lines.push({ kind: "remove", text: a[i], oldLine: i + 1 });
      removed++;
      i++;
    } else {
      lines.push({ kind: "add", text: b[j], newLine: j + 1 });
      added++;
      j++;
    }
  }
  for (; i < n; i++) {
    lines.push({ kind: "remove", text: a[i], oldLine: i + 1 });
    removed++;
  }
  for (; j < m; j++) {
    lines.push({ kind: "add", text: b[j], newLine: j + 1 });
    added++;
  }
  return { lines, added, removed };
}
