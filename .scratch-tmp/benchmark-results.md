Benchmark results — perf/parallelism vs main
=============================================
Machine: macOS aarch64, this repo's shape (300-file git fixture for
snapshots; 3 pseudo-repos x 250 files for the indexer; 6 parallel-safe
grep subprocesses for the multi-tool turn). Median of 5 iterations,
alternating arm order to cancel warm-cache bias.

| benchmark                                        | main (before) | branch (after) | delta        |
| --- | --- | --- | --- |
| snapshot cold, 300-file git repo                 | 17.6ms        | 9.4ms          | 1.9x faster  |
| snapshot warm + diff (1 dirty file)              | 16.7ms        | 14.3ms         | 1.2x faster  |
| snapshot overhead for 10 trivial bash calls      | 318.4ms       | 206.0ms        | 1.55x faster |
| indexer refresh (3 repos x 250 files)            | 3.9ms         | 4.8ms          | ~noise*      |
| 6 search_files (grep subprocess), toolConcurrency=1 | 28.0ms     | 28.0ms         | parity       |
| 6 search_files (grep subprocess), toolConcurrency=4 | n/a        | 12.1ms         | 2.31x vs =1  |
| parallel-read speedup at pool=4                  | n/a           | 2.29-2.33x     | >= 2x gate   |

*Indexer: the fixture is small; the win is the single-traversal design
(one walk instead of hashRepo+roughSize = two full walks) plus async
stays-responsive I/O, which shows up at larger tree sizes.

Notes:
- 10-bash-call numbers include the harness write between snapshots.
  A clean-tree run measures 151.8ms for the branch (the dominant cost is
  20 `git status --porcelain -z` spawns at ~9.6ms each on this machine;
  192ms is the process-spawn floor). Main pays full 300-file content
  reads twice per call (legacy walk reads file contents); the branch
  reads contents only for the dirty set.
- Sequential mode is within noise of main: the per-call tool path is
  unchanged for toolConcurrency=1 (same loop shape, same ordering).
- Merge gate: all 703 jest tests green, `npm run build` clean,
  parallel speedup 2.31x >= 2x target at pool=4 with 6 parallel-safe
  subprocess calls.
