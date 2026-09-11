/**
 * Pure helpers behind the command palette: a fuzzy scorer ported from the
 * CLI's slash-command completer (src/index.ts fuzzyScore) plus word-start and
 * consecutive-match bonuses, and a filter that keeps group order stable.
 * DOM-free so it can be unit tested.
 */

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

const WORD_BREAK = /[\s\-_/:.]/;

/**
 * Subsequence match of `pattern` inside `target`, case-insensitive.
 * Returns 0 when the pattern is not a subsequence; otherwise 1 per matched
 * character, +1 when the match continues the previous one, +2 when it lands
 * on the first character of a word. Empty pattern scores 1 (matches all).
 */
export function fuzzyScore(pattern: string, target: string): number {
  if (!pattern) return 1;
  const p = pattern.toLowerCase();
  const t = target.toLowerCase();
  let pi = 0;
  let score = 0;
  let prev = -2;
  // ponytail: greedy left-to-right alignment, same as the CLI. A DP over all
  // alignments would rank "ab" in "a-b ab" higher; add it if rankings feel off.
  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (p[pi] !== t[ti]) continue;
    score += 1;
    if (ti === prev + 1) score += 1;
    if (ti === 0 || WORD_BREAK.test(t[ti - 1]!)) score += 2;
    prev = ti;
    pi++;
  }
  return pi === p.length ? score : 0;
}

/**
 * Actions whose label matches `query`, grouped in order of each group's first
 * appearance among the matches, best score first inside a group (ties keep
 * the original order). An empty query returns the input untouched.
 */
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const q = query.trim();
  if (!q) return actions;
  const groups = new Map<string, Array<{ a: PaletteAction; i: number; s: number }>>();
  actions.forEach((a, i) => {
    const s = fuzzyScore(q, a.label);
    if (s === 0) return;
    const bucket = groups.get(a.group) ?? [];
    bucket.push({ a, i, s });
    groups.set(a.group, bucket);
  });
  const out: PaletteAction[] = [];
  for (const bucket of groups.values()) {
    bucket.sort((x, y) => y.s - x.s || x.i - y.i);
    for (const { a } of bucket) out.push(a);
  }
  return out;
}
