# Parallelism & Efficiency Plan

Date: 2026-09-06
Status: Approved for implementation
Branch: `perf/parallelism` (from `main`)

## Goal

Reduce the harness's filesystem/CPU load and introduce safe parallelism at three hot spots: per-bash workdir snapshots, sequential tool-call execution, and the repo indexer. Everything stays dependency-free (no `p-limit`), strict TypeScript, and behavior-preserving from the model's perspective.

## Success criteria

1. `run_bash` in a git repo performs **one** `git status`-based snapshot pass per command (was: two full sequential walks that read every file ≤ 32 KB), and non-git dirs walk **in parallel** with lazy content reads.
2. When the model emits multiple read-only tool calls in one turn, they execute **concurrently** (bounded pool, default 4) and their `tool` role messages are appended in the original order. Mutating tools (`run_bash`, `write_file`) serialize behind a lock as today.
3. The indexer folds hash+size into **one** async walk with bounded per-file concurrency (was: three synchronous full traversals).
4. `execSync` in the router-key path and startup init is replaced with promisified `execFile`; no sync sqlite3/ioreg calls on the hot path.
5. `npm run build` passes, `npx jest` passes (all pre-existing suites green plus new suites), and a before/after timing run shows the snapshot fix eliminating the dominant per-bash cost.
6. Concurrency is configurable via `--parallel-tools <n>` and `NINE_RH_PARALLEL_TOOLS`; default 4; `1` reproduces today's sequential behavior.

## Non-goals

- No worker_threads (single-process async concurrency is sufficient at current scale; revisit only if profiling says otherwise).
- No changes to tool sandboxing, `assessToolRisk` taxonomy, or the repair/circuit-breaker logic.
- No new npm dependencies.
- `FileChangeOperation` gains no new variants; `"delete"` detection is deferred (documented, not implemented).

---

## Task 1: Shared concurrency helpers (`parallel.ts`)

**Files:** create `src/parallel.ts`; create `src/__tests__/parallel.test.ts`

Zero-dependency building blocks used by every later task. Exported API:

```ts
// src/parallel.ts

/** Maps `items` through `fn` with at most `limit` fns in flight. Preserves order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Async mutex so mutating tools keep strict ordering. */
export class AsyncLock {
  private chain: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

**Tests** (`src/__tests__/parallel.test.ts`, following the existing jest conventions):

- `mapPool` returns results in input order even when `fn` resolves out of order (resolve each with a reversed delay).
- Concurrency never exceeds `limit` (track in-flight count with a counter, assert max observed ≤ limit).
- `mapPool([])` resolves to `[]`; limit larger than item count works; limit 1 is sequential (assert monotonic start timestamps).
- A rejected `fn` propagates (workers finish draining is acceptable; assert the rejection surfaces).
- `AsyncLock.run` serializes: launch 5 runs that each record `[start, end]`; assert intervals never overlap.

**Verify:** `npx jest src/__tests__/parallel.test.ts`

---

## Task 2: Workdir snapshot efficiency (biggest load win)

**Files:** modify `src/reports/workdirSnapshot.ts`, `src/agent.ts` (snapshot call site), `src/reports/__tests__` (new `workdirSnapshot.test.ts` if not present)

### 2a. Parallel walk with lazy content reads (`workdirSnapshot.ts`)

Rewrite the internal walker to:

1. `readdir` with `withFileTypes` (one syscall per dir, replaces `statSync` per child).
2. Walk subdirectories concurrently using `mapPool(dirs, 8, ...)`.
3. For each regular file ≤ 32 KB, record `{ path, size, mtimeMs, content: null }` — **do not read content**.
4. Content is filled in only where a caller needs it, via a new exported helper:

```ts
export async function hydrateSnapshotContents(
  files: SnapshotFile[],          // the ≤32KB entries recorded above
  root: string,
): Promise<void> {
  await mapPool(files, 16, async (f) => {
    try {
      f.content = await readFile(join(root, f.path), "utf8");
    } catch {
      f.content = null; // deleted or unreadable between walk and read
    }
  });
}
```

(The exact `SnapshotFile` type name should match what exists; adapt rather than rename public types.)

### 2b. Git fast path (`workdirSnapshot.ts`)

New exported function used by the agent loop:

```ts
export async function snapshotWorkDirFast(root: string): Promise<WorkDirSnapshot> {
  // If root is inside a git work tree:
  //   const { stdout } = await execFile("git", ["status", "--porcelain", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  //   -> parse entries into FileChangeOperation create|edit (porcelain codes ??/A = create, M/T = edit)
  //   -> return a snapshot object carrying only changes (empty fullFiles list)
  // Else: fall back to the parallel walk from 2a.
}
```

Notes:

- Use `execFile` (async), not `execSync`.
- Handle "not a git repository" (non-zero exit) by falling back.
- Untracked-but-ignored files are excluded by design (that is the point); document this in a comment and in the doc-table row below.
- The snapshot type may need an optional `changes?: FileChangeOperation[]` field; do **not** change `FileChangeOperation` itself (stays `"create" | "edit"`; `"delete"` is future work).

### 2c. Single snapshot per bash command (`agent.ts` ~line 692-756)

Today `executeToolWithRepair` calls `snapshotWorkDir()` before *and* after every bash command and diffs. Change to:

1. Take **one** fast snapshot **before** the command (`snapshotWorkDirFast`).
2. After the command, capture `git status --porcelain -z` again (git case) and diff the two porcelain outputs — O(changes), zero walks. Non-git case: re-run the parallel walk but compare `mtimeMs+size` only; **lazy-hydrate content** only for paths whose `mtime+size` changed (usually 0-3 files), then diff contents for those.
3. If nothing changed, skip the diff/report update entirely (common case: builds, greps, git commands).

**Tests:**

- Non-git tmpdir fixture: create files/subdirs, snapshot; assert parallel walk lists all files, `content` is `null` before hydrate, populated after.
- Change detection: snapshot, mutate one file and create another, run the "detect changes" helper, assert exactly those two paths reported with `create`/`edit`.
- Git fixture (`git init` in tmpdir, config `user.email`/`user.name` to keep it hermetic): untracked file → `create`; modified tracked file → `edit`; clean tree → no changes and **no** full walk (can assert via a spy on the walker export).
- Existing snapshot/report tests keep passing.

**Verify:** `npx jest src/reports src/__tests__ -t snapshot` (adapt filter to suite names), plus a manual timing check:

```
node -e "const {performance}=require('perf_hooks'); /* time 5x snapshotWorkDirFast vs old snapshotWorkDir on this repo */"
```

Record before/after numbers in the task 7 benchmark section.

---

## Task 3: Parallel tool-call execution in the agent loop

**Files:** modify `src/agent.ts`, `src/index.ts` (flag), `src/cliArgs.ts` (flag parsing + DEFAULTS), `src/tui.ts` (one matching fix), `src/__tests__` (new `parallelTools.test.ts`)

### 3a. Config plumbing

- `DEFAULTS` (src/index.ts:62): add `parallelTools: 4`.
- Parse `--parallel-tools <n>` exactly like `parseMaxIter` (src/index.ts:190): a `parsePositiveInt` helper, env fallback `NINE_RH_PARALLEL_TOOLS`, flag wins; values `< 1` or `NaN` fall back to 4; `1` = sequential (today's behavior).
- Add `parallelTools: number` to the `opts` type at src/index.ts:113 and pass into `AgentConfig` as `toolConcurrency`.
- `AgentConfig` (src/agent.ts:69): add `toolConcurrency?: number` with default 4 in the config-normalization spot.

### 3b. Read-only classification (agent.ts)

Use the existing risk engine instead of a new name list — `assessToolRisk` (src/orchestrator/roles.ts:142) with `DEFAULT_TOOL_RISK_THRESHOLD`/`toolRiskThreshold`:

```ts
private isConcurrentSafe(call: ParsedToolCall): boolean {
  try {
    const risk = assessToolRisk({ name: call.name, args: call.args ?? {} });
    return risk === "low" || risk === "medium";
  } catch {
    return false; // fail closed to sequential
  }
}
```

Guard rails:

- Sequential fallback when `toolConcurrency <= 1`.
- Concurrency applies **within a turn's tool-call batch only**; the ReAct loop still waits for all results before the next model turn.
- The `AsyncLock` from Task 1 is applied around any mutating tool (`run_bash`, `write_file`, anything `assessToolRisk` scores high/critical) even inside a concurrent batch, preserving today's no-parallel-mutation guarantee.

### 3c. Batch execution in `executeAssistantMessage` (src/agent.ts:1074)

Replace the sequential `for (const tc of parsedToolCalls)` with:

```ts
const results = await mapPool(parsedToolCalls, this.config.toolConcurrency ?? 4, async (tc) => {
  if (this.isConcurrentSafe(tc)) return this.executeToolWithRepair(tc);
  return this.mutationLock.run(() => this.executeToolWithRepair(tc));
});
// Append `tool` role messages in the ORIGINAL parsedToolCalls order (API requirement):
for (const r of results) { /* existing message-append code, unchanged */ }
```

Ordering guarantee: `mapPool` preserves index order, so assistant→tool pairing and any index-based result consumption are unchanged.

### 3d. Event emission

Keep emitting `tool_call` immediately before each execution starts and `tool_result` when it settles (out-of-order arrival is fine for consumers — see TUI fix below). No new event kinds; the `AgentEvent` union (src/agent.ts:132) is unchanged.

### 3e. TUI matching fix (src/tui.ts:1519)

`tool_result` currently marks the *last running* history entry done. With concurrency, match by name too:

```ts
const lastRunning = [...dashboard.toolHistory].reverse()
  .find(h => h.status === "running" && h.name === event.name)
  ?? [...dashboard.toolHistory].reverse().find(h => h.status === "running");
```

`ToolHistoryEntry` (src/tui.ts:636) already has `name`, so no type changes.

### 3f. Timing edge case

`tool.durationMs` currently measures around the sequential loop. Measure per-call instead: capture `Date.now()` at the top of the mapped fn and again after `executeToolWithRepair` resolves; attach to the result. Concurrent durations overlap by definition; that is correct for per-call timing.

**Tests** (`src/__tests__/parallelTools.test.ts`, reusing the mock-executor pattern from `tools.test.ts` and tmpdir conventions from `indexer.test.ts`):

1. **Order preservation:** three read-only calls with reversed completion times → the `tool` role messages appear in the original call order in `messages`.
2. **Concurrency observed:** read-only calls targeting files whose stubbed handler sleeps 50 ms → total wall time < sum (assert overlap via elapsed ratio), with `toolConcurrency=4`.
3. **Mutation serialization:** mix of `write_file` + reads in one batch → writes never overlap each other (assert via recorded intervals in a stub executor); reads still parallelize around them.
4. **Sequential mode:** `toolConcurrency: 1` → strict start/finish ordering, identical message order (regression guard).
5. **Flag parsing:** `--parallel-tools 2`, `NINE_RH_PARALLEL_TOOLS=3` with no flag, invalid input (`--parallel-tools 0`, `abc`) → parses to 2 / 3 / 4 / 4 respectively.
6. **Risk gating:** a call `assessToolRisk` scores high in a concurrent batch goes through the lock (assert serialized ordering).
7. **Error containment:** one call throws → `Promise.allSettled`-style handling in `mapPool` usage still appends an error `tool` message for that call and the loop continues (matching current per-call try/catch behavior).

**Verify:** `npx jest src/__tests__/parallelTools.test.ts`, then a REPL smoke test: prompt that provokes multiple reads in one turn, confirm TUI lanes and message order look right, and `--parallel-tools=1` behaves exactly as `main`.

---

## Task 4: Indexer single-walk async rewrite

**Files:** modify `src/indexer.ts`, `src/__tests__/indexer.test.ts` (extend)

Today: `findRepos` (line 68), `hashRepo` (line 104), `roughSize` (line 133) are three separate synchronous full traversals; `refresh()` runs `hashRepo`+`roughSize` per repo (lines 207, 220-221). Only consumer: `ensureRepoIndex` via dynamic import in `src/commands.ts:603-608` (already async, so signature change is safe).

Rewrite:

1. Fold `hashRepo` + `roughSize` into one async walker per repo that accumulates `hash` and `bytes` in a single pass, hashing files concurrently with `mapPool(files, 16, ...)` (hashing is CPU-ish but async-ifying keeps the event loop responsive; batch file collection first, then hash).
2. Keep `findRepos` semantics (same skip rules) but make it async with concurrent directory descent via `mapPool(dirs, 8, ...)`.
3. Process repos in `refresh()` with `mapPool(repos, 2, ...)` — index building may touch disk heavily, keep repo-level concurrency modest.
4. Preserve exported function names/signatures where cheap (`ensureRepoIndex` must keep working without changes at the `commands.ts` call site); convert internal walkers to async and update `refresh()`/`ensureRepoIndex` internals. If a public sync signature must break, grep for all callers first and update them in the same commit.
5. Progress/heartbeat behavior in `refresh()` must be preserved (keep the same logging cadence; emit per-repo completion as each finishes rather than strictly sequentially).

**Tests:** extend `src/__tests__/indexer.test.ts` (it already builds tmpdir fixtures):

- Same fixture as existing tests → index hash and repo list are **identical** before/after rewrite (golden comparison against current output captured first).
- Deterministic concurrency: a fixture with nested repos and many small files completes with correct total size and hash.
- Skip rules: node_modules/symlinks/dotted dirs still excluded exactly as before.

**Verify:** `npx jest src/__tests__/indexer.test.ts`; run `/index`-adjacent REPL path or `ensureRepoIndex` in a scratch script against this repo and compare index JSON before/after the rewrite.

---

## Task 5: Remove sync exec from hot paths

**Files:** modify `src/backends/router.ts` (line 66), `src/init.ts` (lines 24-47, 59)

1. `src/backends/router.ts:66`: replace sync `sqlite3` invocation with `execFile` promisified (`const { stdout } = await execFile("sqlite3", [...])`). The calling method is already async; propagate `await` to its callers if any were sync — grep for the enclosing function name and fix call sites in the same commit.
2. `src/init.ts:24-47`: convert the startup `sqlite3` / `ioreg` / Windows `REG` probes to awaited `execFile`. `runStartupInit` is async; ensure every branch awaits and failures keep their current swallowed/logged behavior (no new crash paths at startup).
3. `getCliToken` (src/init.ts:59): swap `readFileSync`/`readdirSync` internals for `fs/promises`. Call sites `src/commands.ts:175-176` and `src/commands.ts:846-847` are already async contexts — just add `await`.

**Tests:**

- If `init.ts` has no direct suite, add a small `src/__tests__/init.test.ts`: stub `execFile` (jest.mock) and assert (a) functions resolve rather than hang, (b) a failing probe is swallowed exactly as before (no throw).
- Router key path: existing backend tests keep passing; add one test that the async key lookup resolves a token from a stubbed sqlite stdout, and returns `null` on exec failure (mirrors current null-on-miss behavior).

**Verify:** `npx jest`, plus `npm run build` (strict TS catches any missed `await`).

---

## Task 6: Docs & configuration table

**Files:** modify `docs/full-documentation.md`, `README.md` (if it has a flags table)

Add to the flags table (format per line 129 style):

```
| `--parallel-tools <n>` | `NINE_RH_PARALLEL_TOOLS` | `4` | Max tool calls executed concurrently per turn; `1` = sequential (previous behavior) |
```

Plus a short "Parallelism & performance" prose section: what runs concurrently (read-only tools within a turn, snapshot walks, indexer), what stays serialized (bash/write, per-turn model loop), and the git-snapshot fast path note (ignored files are not tracked in snapshots).

---

## Task 7: Benchmark & verification gate (before merge)

**Files:** update `_perf_check.cjs` (existing scaffolding) or add `scripts/perf-check.cjs`

Measure on this repo (≈ real-world shape), 5 iterations each, report medians:

1. **Snapshot:** old `snapshotWorkDir` vs new fast path, cold and warm.
2. **Bash round trip:** 10 trivial `run_bash` calls end-to-end through the agent loop (before/after branch comparison via `git stash` or checking out `main`).
3. **Multi-read turn:** a scripted run that issues 4 concurrent-safe reads; compare wall time at `--parallel-tools=1` vs `=4`.
4. **Indexer:** `ensureRepoIndex` full refresh before/after.

**Merge gate:** all jest suites green, `npm run build` clean, benchmark table pasted into the PR/commit message with at least: snapshot per-bash improvement (expect the dominant win), parallel-read speedup ≥ 2x at pool=4 on 4+ reads, and no regression in sequential mode (`--parallel-tools=1` within noise of `main`).

## Commit sequence (one PR, reviewable commits)

1. `perf: shared mapPool/AsyncLock helpers` (Task 1)
2. `perf: git fast-path + parallel lazy workdir snapshots` (Task 2)
3. `feat: bounded parallel tool execution with --parallel-tools` (Task 3)
4. `perf: indexer single-pass async walk` (Task 4)
5. `perf: async exec in router/init hot paths` (Task 5)
6. `docs: parallelism flags and behavior` (Task 6)
7. `perf: benchmark harness + results` (Task 7)

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Provider rejects out-of-order `tool` messages | `mapPool` preserves order; test 3a.1 asserts message order explicitly |
| Concurrent FS writes corrupt state | High/critical-risk tools go through `AsyncLock`; test 3a.3 |
| Git absent / not a repo | Exec failure → parallel-walk fallback; covered in tests |
| TUI mislabels concurrent results | Name-aware matching fix (Task 3e) |
| `assessToolRisk` changes over time reclassify reads as risky | Fail-closed default: anything not low/medium runs serialized — correctness over speed |
| Hidden sync callers of converted functions | `npm run build` (strict) + grep in Tasks 4/5 before finalizing each commit |
