## Summary

Implements the approved parallelism & efficiency plan (docs/superpowers/plans/2026-09-06-parallelism-efficiency.md) as 7 reviewable commits. Model-visible behavior is unchanged: tool messages still append in original call order, mutating tools stay serialized.

- **Bounded parallel tool execution** (`--parallel-tools <n>`, env `NINE_RH_PARALLEL_TOOLS`, default 4, `1` = sequential). Only read-only tools run concurrently; everything else goes through a shared mutation lock (fail-closed). Unexpected executor throws are contained as per-call error results. TUI `tool_result` matching is name-aware for concurrent results.
- **Git fast-path workdir snapshots** for `run_bash`: `git status --porcelain -z -uall` + lstat of the dirty set instead of two full content-read walks per bash call. Paths are re-keyed toplevel-relative → workDir-relative (correct attribution when workDir sits inside a repo subdirectory), and `git show :<path>` index reads use the toplevel prefix. Git-ignored files are not tracked by the fast path (documented).
- **Indexer single-pass async walk**: findRepos/hashing/sizing collapsed into one traversal with bounded concurrency; repos processed 2 at a time. Verified byte-identical via a golden-comparison fixture.
- **Async exec in hot paths**: sqlite3 key lookup, ioreg/REG machine-id probes, cli-token reads, startup-log tail — no sync exec/FS left in init.ts.
- **Shared helpers** (`src/parallel.ts`): zero-dep `mapPool` (ordered, stops dispatch after failure, drains in-flight) and `AsyncLock`.
- **Docs** (flag row + "Parallelism & performance") and **benchmark harness** (`scripts/perf-check.cjs`).

## Benchmark results (macOS aarch64, median of 5)

| benchmark | main | branch | delta |
| --- | --- | --- | --- |
| snapshot cold (300-file git repo) | 17.6ms | 9.4ms | **1.9x faster** |
| snapshot warm + diff (1 dirty) | 16.7ms | 14.3ms | 1.2x faster |
| snapshot overhead, 10 trivial bash calls | 318.4ms | 206.0ms | **1.55x faster** |
| indexer refresh (3x250 files) | 3.9ms | 4.8ms | ~noise (small fixture) |
| 6 grep subprocesses, toolConcurrency=1 | - | 28.0ms | parity with main |
| 6 grep subprocesses, toolConcurrency=4 | - | 12.1ms | **2.31x vs sequential** |

## Test plan

- [x] Full suite: 51 suites / 711 tests green (`npm test`; do not use bare `npx jest`)
- [x] `npm run build` clean (strict TS)
- [x] Golden comparison: indexer output byte-identical before/after rewrite
- [x] New suites: `parallelTools.test.ts` (order, lock serialization, containment, flag parsing), `init.test.ts` (async key/token probes, promisify-bridged mocks)
- [x] Sequential mode (`--parallel-tools 1`) within noise of main

## Post-merge review pass

An independent code-review audit of the merge range produced commit `1b77770`:

- `assessToolRisk` fail-closed hardening: allowlisted read-only bash commands containing write signals (redirection, `tee`/`sponge`/`dd`, command substitution) now classify medium and take the mutation lock.
- Mixed git/walk snapshot diffs (`[]` semantics) pinned by tests.
- WorkDir-inside-repo-subdir path attribution fixed (tested); untracked directories expanded via `-uall`.
- A fourth finding (quiet-mode phantom running entries) was investigated and refuted.

Gates on the PR head: `npm test` 51 suites / 711 tests green; `npm run build` clean; `scripts/perf-check.cjs` parallel-read speedup 2.33x (gate >= 2x).
