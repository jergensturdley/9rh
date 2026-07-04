# Bug Fix Spec — Top 6 Findings

Status: spec only. No production code is modified by this document.
Audience: a future engineer (or future session) who will implement the fixes.

Verification basis: 5 failing Jest tests across `src/__tests__/indexer.test.ts`
and `src/sandbox/__tests__/sandbox.test.ts`, plus source inspection of
`src/backends/detect.ts:86`. All five failures were reproduced locally.
See "Verification log" at the bottom.

---

## #1 — `saveStore` silently swallows write errors

**Severity:** High (data-integrity / silent corruption).
**File:** `src/indexer.ts:165,168`
**Test that pins it:** `RepoIndexer — error propagation on write failure
(bug #1) › surfaces a write failure when the index file is not writable`

### Current behavior
```ts
mkdir(dir, { recursive: true }).catch(() => {});
writeFile(dbPath(workDir), JSON.stringify(store), "utf-8").catch(() => {});
```

If `writeFile` fails (EACCES, ENOSPC, EROFS), the rejection is caught
and discarded. `refresh()` returns a normal-looking `RefreshResult`,
in-memory `store.repos` diverges from disk, and the user has no signal.

### Required fix
1. Convert `saveStore` from `void` to `Promise<void>` (await it inside
   `refresh()`).
2. On write failure, surface the error in one of these ways (in order
   of preference):
   - throw from `refresh()` so the caller is forced to handle it, OR
   - attach the error to the returned `RefreshResult` as a new
     `lastWriteError: Error | null` field.
3. Do NOT silently fall back to a "best effort" write — the test
   contract requires the failure to be observable.

### Acceptance
- The bug-#1 test passes without modification.
- Existing tests (e.g. "persists successfully when the parent directory
  must be created") still pass.
- No new test passes that previously failed (no regression).

---

## #2 — `findRepos` traversal contract (DOCSTRING vs REALITY)

**Severity:** Low (docstring rot, not runtime bug).
**File:** `src/indexer.ts:48-66`
**Test that pins it:** `findRepos — traversal rules (bug #2)`

### Current behavior
```ts
if (VCS_DIRS.has(e.name)) continue; // skip .git contents
if (e.name.startsWith(".") && e.name !== ".config") continue;
```

The production code **already does the right thing**: `.git` is skipped
at every level, `.config` is carved out. Both pin-tests pass today.

### Recommended action
1. **Do not change production code.** The behavior is correct.
2. Update the docstring on `findRepos` so the next reader doesn't file
   the same false positive. Specifically, mention:
   - `.git` is skipped at every depth (not just top-level).
   - `.config` is the only dotted directory that is descended into.
3. Keep the two pin-tests as-is — they protect the contract.

This is a documentation-only change.

---

## #3 — `DirectExecutor.validatePath` is a pass-through

**Severity:** High (sandbox boundary violation).
**File:** `src/sandbox/executor.ts:98-103`
**Test that pins it:** `DirectExecutor.validatePath — sandbox-bounds
enforcement (bug #3)` (both tests in that block fail today)

### Current behavior
```ts
async validatePath(_filePath: string): Promise<string> {
  const cached = this.pathValidationCache.get(_filePath);
  if (cached) return cached;
  this.pathValidationCache.set(_filePath, _filePath);
  return _filePath;
}
```

Returns the input verbatim. `/tmp/../etc/passwd` resolves to
`/etc/passwd` outside the sandbox.

### Required fix
Replace the body with a real bounds check. Sketch:
```ts
import { resolve, relative, isAbsolute } from "node:path";

async validatePath(filePath: string): Promise<string> {
  const abs = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(this.workDir, filePath);
  const root = resolve(this.workDir);
  const rel = relative(root, abs);
  const escapes = rel.startsWith("..") || isAbsolute(rel);
  if (escapes) {
    throw new Error(
      `path escapes sandbox workDir: ${filePath} (resolved ${abs})`,
    );
  }
  this.pathValidationCache.set(filePath, abs);
  return abs;
}
```

Notes for the implementer:
- The error message must include enough detail to debug — both the
  input and the resolved absolute path.
- Throwing is acceptable (one of the two test cases treats throw as a
  pass). Returning a normalized-inside path is also acceptable; pick
  one and stick with it. Recommend **throw** — silent normalization
  can mask intent in user code that constructs paths dynamically.
- Do not remove `pathValidationCache` — other callers may rely on the
  memoization. Keep the cache key as the raw input, value as resolved.

### Acceptance
- Both bug-#3 tests pass.
- Other tests that use `validatePath` for legitimate in-workDir paths
  (e.g. `/tmp/test.txt`) still pass — see the `DirectExecutor` describe
  block in `sandbox.test.ts`.

---

## #4 — `ExecutionResult` drops the signal name on child kill

**Severity:** Medium (observability gap; user cannot distinguish
"timeout" from "manual SIGKILL" from "OOM kill").
**File:** `src/sandbox/executor.ts:84-94`
**Test that pins it:** `ExecutionResult — signal preservation on kill
(bug #4)`

### Current behavior
```ts
const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
...
return {
  output: ...,
  exitCode: e.code ?? null,
  error: ...,
  timedOut: false,
  ...
};
```

`e.signal` is never read. `timedOut` is hard-coded `false`. A user that
sends SIGKILL sees `exitCode: null, error: "exit non-zero"` with no
indication of the signal.

### Required fix
1. Widen the cast to include `signal?: NodeJS.Signals`.
2. Add a `signal: NodeJS.Signals | null` field to `ExecutionResult`.
3. If `e.signal` is set, return:
   - `exitCode: null`
   - `signal: e.signal`
   - `error: \`killed by signal ${e.signal}\``
   - `timedOut: false` (timeout is a separate path; do not conflate)
4. If `e.code` is set (non-signal exit), keep current behavior.

### Acceptance
- The bug-#4 test passes (`signal`, `killed`, or `timedOut` set).
- Existing tests for `exit 42` (non-signal exit) still pass — they
  expect `exitCode: 42`, not `signal`.

---

## #5 — `DirectExecutor.exec` silently clamps `timeoutMs` at 120_000

**Severity:** Medium (caller expectation violated without notice).
**File:** `src/sandbox/executor.ts:69`
**Test that pins it:** `DirectExecutor.exec — timeout clamp visibility
(bug #5)`

### Current behavior
```ts
const timeoutMs = Math.min(options?.timeoutMs ?? 60_000, 120_000);
```

A caller asking for 10 minutes gets 2 minutes, no warning.

### Required fix (recommended)
Make the cap configurable, and surface a warning when the cap is hit.
Sketch:
```ts
export interface DirectExecOptions {
  timeoutMs?: number;
  // Default 600_000 (10 min). Set to Infinity to disable the cap.
  maxTimeoutMs?: number;
}

const requested = options?.timeoutMs ?? 60_000;
const cap = options?.maxTimeoutMs ?? 600_000;
const timeoutMs = Math.min(requested, cap);
const clamped = timeoutMs < requested;
```

Then in the return value:
```ts
return {
  ...,
  requestedTimeoutMs: requested,
  clampedTimeout: clamped,
  ...
};
```

Notes:
- The bug-#5 test accepts any of: `clampedTimeout === true`,
  `requestedTimeoutMs > 120_000`, or a clamp-related `error` string.
- The recommended shape is to BOTH raise the default cap (to a saner
  value like 10 min) AND expose the requested-vs-actual on the result.
  Do not silently cap and silently expand — always surface the actual
  value used.

### Acceptance
- The bug-#5 test passes.
- Existing exec tests with implicit short timeouts still pass (no
  behavior change for callers that didn't pass `timeoutMs`).

---

## #6 — `hasRouterHint` tautology (DEAD CODE, not a runtime bug)

**Severity:** Low (code quality only — no observable runtime impact).
**File:** `src/backends/detect.ts:86`
**Test that pins it:** `detectBackend — router-hint tautology (bug #6)`

### Current behavior
```ts
const routerUrl = opts.routerBaseURL ?? process.env.NINE_ROUTER_URL ?? NINE_ROUTER_OPENAI;
const hasRouterHint = Boolean(process.env.NINE_ROUTER_URL) || routerUrl !== NINE_ROUTER_OPENAI;
```

Because `routerUrl` is `process.env.NINE_ROUTER_URL ?? NINE_ROUTER_OPENAI`,
the second clause `routerUrl !== NINE_ROUTER_OPENAI` is true iff
`process.env.NINE_ROUTER_URL` is set. The first clause is also true iff
the env var is set. The two clauses are equivalent; one is dead code.

### Recommended fix
Simplify to:
```ts
const hasRouterHint = routerUrl !== NINE_ROUTER_OPENAI;
```

This is the single source of truth — "router URL is non-default". The
boolean env-var check was always redundant.

### Why this is safe
- Both pin-tests already pass with the current code (and would continue
  to pass after simplification).
- The behavioral surface is unchanged: `hasRouterHint` evaluates to the
  same value in every env-var configuration.
- No public API change.

### Acceptance
- The two pin-tests in the bug-#6 describe block continue to pass.
- The simplify-only commit does not require a test change — the tests
  already pin the contracts on either side.

---

## Verification log

Run date: 2026-06-18, against `9rh` repo at
`/Volumes/M.2 2TB/code/9rh`.

```
$ NODE_OPTIONS='--experimental-vm-modules' \
    node_modules/.bin/jest --config jest.config.ts \
    src/__tests__/indexer.test.ts \
    src/sandbox/__tests__/sandbox.test.ts \
    src/__tests__/backends.test.ts
...
Test Suites: 2 failed, 1 passed, 3 total
Tests:       5 failed, 42 passed, 47 total
```

Per-bug confirmation:

| Bug | File | Test | Status |
|-----|------|------|--------|
| #1 | `src/indexer.ts:165,168` | bug #1 write-failure test | FAIL (real bug) |
| #2 | `src/indexer.ts:48-66` | bug #2 traversal pin-tests | PASS (docstring rot only) |
| #3 | `src/sandbox/executor.ts:98-103` | bug #3 validatePath tests (×2) | FAIL (real bug) |
| #4 | `src/sandbox/executor.ts:84-94` | bug #4 signal test | FAIL (real bug) |
| #5 | `src/sandbox/executor.ts:69` | bug #5 clamp test | FAIL (real bug) |
| #6 | `src/backends/detect.ts:86` | bug #6 pin-tests (×2) | PASS (dead code, no runtime impact) |

## Recommended commit order

1. #3 (highest impact — sandbox escape) — touches
   `src/sandbox/executor.ts` only.
2. #1 (data integrity) — touches `src/indexer.ts`.
3. #5 (caller contract) — touches `src/sandbox/executor.ts`.
4. #4 (observability) — touches `src/sandbox/executor.ts`.
5. #6 (dead code) — touches `src/backends/detect.ts`.
6. #2 (docstring) — touches the comment on `findRepos` only.

Each commit should be small enough that the corresponding test goes
red → green in a single PR.
