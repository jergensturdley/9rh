# Bug Fix Spec — Audit of Remaining Gaps

Status: spec only. No production code is modified by this document.
Audience: a future engineer (or future session) who will implement the fixes.

Supersedes: `docs/bug-fix-spec.md` for active work. The prior spec
described 6 bugs that have since been fixed in source (47/47 tests
pass; all six "Required fix" sketches already exist verbatim). The
findings below are the gaps the prior spec missed.

Verification basis: source inspection of `src/indexer.ts`,
`src/sandbox/executor.ts`, `src/sandbox/sandboxer.ts`,
`src/backends/detect.ts`, and `src/sandbox/__tests__/sandbox.test.ts`.
Reproduced locally: 47/47 tests pass on
`src/__tests__/indexer.test.ts`,
`src/sandbox/__tests__/sandbox.test.ts`,
`src/__tests__/backends.test.ts`.

---

## A1 — `SandboxExecutor` has no timeout cap visibility; `clampTimeout` silently caps at 120s

**Severity:** Medium (caller contract violated on the sandbox path).
**File:** `src/sandbox/sandboxer.ts:59-63` (clampTimeout),
`src/sandbox/executor.ts:42-57` (SandboxExecutor.exec).
**Test gap:** no test exercises SandboxExecutor with `timeoutMs` > 120_000.

### Current behavior

`src/sandbox/sandboxer.ts:59-63`:
```ts
function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) return 1000;
  if (timeoutMs > 120_000) return 120_000;
  return timeoutMs;
}
```

`SandboxExecutor.exec` (`src/sandbox/executor.ts:42-57`) hard-codes
`clampedTimeout: false` regardless of what the underlying sandbox did:

```ts
return {
  ...
  requestedTimeoutMs: requested,
  clampedTimeout: false,
};
```

So a caller asking for 10 minutes gets 2 minutes on the sandbox path
with **zero** signal — the `clampedTimeout` field lies.

Meanwhile `DirectExecutor.exec` correctly surfaces
`requestedTimeoutMs`/`clampedTimeout` (see `executor.ts:85-87,109,134,148`).

### Asymmetry

`DirectExecOptions.maxTimeoutMs` defaults to 600_000 (10 min) — see
`executor.ts:86`. `SandboxConfig` carries no equivalent knob, and the
sandbox's `clampTimeout` is hard-coded to 120s.

### Required fix

1. Plumb `maxTimeoutMs` through `SandboxConfig` and into the
   underlying `clampTimeout` call, defaulting to 600_000 for parity
   with `DirectExecutor`.
2. Have `SandboxExecutor.exec` capture the effective timeoutMs the
   sandbox used (return it from `sandbox.exec` if not already), and
   compute `clampedTimeout = effective < requested`.
3. Add a regression test: SandboxExecutor with `timeoutMs: 10*60*1000`
   must set `clampedTimeout: false` (or surface the clamp).

### Acceptance

- New test: `SandboxExecutor — timeout clamp visibility` passes.
- Bug-#5 test (`executor — timeout clamp visibility (bug #5)`)
  continues to pass on the direct path.
- No new test passes that previously failed (no regression).

---

## A2 — `DirectExecutor.validatePath` does not follow symlinks; sandbox path does

**Severity:** Medium (sandbox-bound drift between paths).
**File:** `src/sandbox/executor.ts:152-168` (DirectExecutor),
`src/sandbox/sandboxer.ts:42-57` (sandboxPath).
**Test gap:** no test for `DirectExecutor.validatePath("/tmp/link-to-etc")`
where `/tmp/link-to-etc → /etc`.

### Current behavior

`DirectExecutor.validatePath` (`executor.ts:152-168`):
```ts
const abs = isAbsolute(_filePath)
  ? resolve(_filePath)
  : resolve(this.workDir, _filePath);
const root = resolve(this.workDir);
const rel = relative(root, abs);
const escapes = rel.startsWith("..") || isAbsolute(rel);
```

This resolves lexical `..` but **does not follow symlinks**. A symlink
`/tmp/escape → /etc` will be accepted as inside `/tmp` even though
the kernel will follow it to `/etc`.

`sandboxPath` (`sandboxer.ts:42-57`) uses `realpath`, which follows
symlinks. So the two paths disagree on the same input.

### Required fix

Switch `DirectExecutor.validatePath` to follow symlinks via `realpath`,
matching `sandboxPath`. Sketch:

```ts
import { realpath } from "fs/promises";

async validatePath(filePath: string): Promise<string> {
  const abs = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(this.workDir, filePath);
  const realAbs = await realpath(abs);  // resolves symlinks
  const realRoot = await realpath(this.workDir);
  const rel = relative(realRoot, realAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `path escapes sandbox workDir: ${filePath} (resolved ${realAbs})`,
    );
  }
  return realAbs;
}
```

The cache key stays the raw input; the cache value becomes the
realpath. Add a regression test:
`DirectExecutor.validatePath("/tmp/symlink-to-etc")` throws.

### Acceptance

- New symlink-escape test passes.
- All existing `validatePath` tests (e.g. `/tmp/test.txt`) still pass
  — `realpath` of a regular file inside `/tmp` stays inside `/tmp`.
- Both DirectExecutor and SandboxExecutor now reject the same set of
  paths on the same input.

---

## A3 — `DirectExecutor.exec` signal-heuristic regex produces false positives on stdout

**Severity:** Medium (observability corruption; false `killed: true`).
**File:** `src/sandbox/executor.ts:95-99`.
**Test gap:** no test for benign output containing the word `Killed`.

### Current behavior

```ts
const out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
const killedBySignal = /\b(Killed|Terminated)\b|Killed\s+\(signal/i.test(out);
```

The regex tests the **combined stdout+stderr** buffer. A program that
legitimately prints `Killed: 42 enemies defeated` (or `Terminated:
session timed out`) triggers `killedBySignal = true` and the result
reports a signal kill that did not happen.

### Required fix

1. Restrict the regex to `stderr` only (where kernel-generated
   diagnostic messages actually appear), not the merged buffer.
2. Tighten the pattern to require the parenthetical form
   `Killed (<PID>...)` or `\bTerminated\b` immediately preceded by a
   process exit indicator, not arbitrary text.
3. Add a regression test: `exec("echo Killed: 42 enemies")` must
   report `killed: false`.

Sketch:

```ts
const killedBySignal = e.signal !== undefined && e.signal !== null;
// no output regex — rely on e.signal
```

Or, if the regex must stay for the "outer sh exits 0, child was
signalled" case, restrict it to stderr and anchor more tightly:

```ts
const killedBySignal = /(?:^|\n)Killed(?:\s+\(signal[^)]*\))?|(?:^|\n)Terminated(?:\s+\(signal[^)]*\))?/m.test(stderr ?? "");
```

### Acceptance

- New false-positive test passes (`echo "Killed: 42 enemies"` →
  `killed: false`).
- The bug-#4 signal test (child killed via `kill -9`) still passes
  (the path now sets `killed: true` via `e.signal`, not via regex).

---

## A4 — `findRepos` resolves lexical paths but does not follow symlinks

**Severity:** Low (correctness on symlinked monorepos; data quality).
**File:** `src/indexer.ts:65-94`.
**Test gap:** no symlink test for `findRepos`.

### Current behavior

`findRepos` calls `resolve(dir)` which collapses `..` segments but
does not follow symlinks. A symlinked repo (`~/projects/myapp → ~/code/myapp`)
will be reported twice (once at the symlink path, once at the target)
and `hashRepo` will compute hashes for both — but the on-disk
manifestation is one repo.

### Required fix

Use `realpath` (cached per session to avoid syscall storms) when
recording results:

```ts
import { realpathSync } from "fs";

function walk(dir: string, depth: number): void {
  const resolved = resolve(dir);
  let realResolved: string;
  try {
    realResolved = realpathSync(resolved);
  } catch {
    return; // unreadable
  }
  if (seen.has(realResolved)) return;
  seen.add(realResolved);
  ...
}
```

The `seen` set must key on the realpath so symlinked duplicates are
deduped.

### Acceptance

- New test: a symlink inside the walk target pointing to a sibling
  repo root is not double-listed.
- All existing findRepos tests still pass (regular paths are
  unaffected because `realpath(realpath(x)) === realpath(x)`).

---

## A5 — `RepoIndexer.refresh` commits to memory before persisting; write failure causes silent divergence

**Severity:** High (data-integrity / silent corruption, same class as
prior bug #1).
**File:** `src/indexer.ts:241-242`.
**Test gap:** no test for saveStore failure on the post-#1 path.

### Current behavior

```ts
this.store = { version: 1, repos: pruned };
await saveStore(this.workDir, this.store);
```

If `saveStore` throws (EACCES, ENOSPC, EROFS), `this.store` has
already been mutated. The in-memory state now disagrees with disk.
`refresh()` returns a normal-looking `RefreshResult` and the user has
no signal.

### Required fix

Reorder so the disk write completes before the in-memory mutation:

```ts
const next = { version: 1, repos: pruned };
await saveStore(this.workDir, next);  // throws on failure
this.store = next;
```

Add a regression test: a workDir with a read-only `.9rh/` directory
must surface the error from `refresh()`, not return a normal result.

### Acceptance

- New read-only-write test passes.
- Bug-#1 test continues to pass.
- All other indexer tests continue to pass.

---

## A6 — `hasRouterHint` already simplified (verified, no action)

**Severity:** N/A (already fixed).
**File:** `src/backends/detect.ts:86`.

Inspected. Current code is:

```ts
const hasRouterHint = routerUrl !== NINE_ROUTER_OPENAI;
```

This is the simplified form recommended by prior bug #6. The tautology
the prior spec flagged has been removed.

**No action.**

---

## A7 — `findRepos` docstring still incomplete (documentation rot)

**Severity:** Low (docstring drift).
**File:** `src/indexer.ts:47-66`.

Prior spec bug #2 (docs-only) already updated the docstring to mention
`.git`-skip-everywhere and `.config` carve-out. A4 above adds a new
contract worth documenting: **symlink dedup via realpath**. Update the
docstring on `findRepos` to mention this.

**Documentation-only change.**

---

## Verification log

Run date: 2026-06-20, against `9rh` repo at `/Volumes/M.2 2TB/code/9rh`.

```
$ NODE_OPTIONS='--experimental-vm-modules' \
    node_modules/.bin/jest --config jest.config.ts \
    src/__tests__/indexer.test.ts \
    src/sandbox/__tests__/sandbox.test.ts \
    src/__tests__/backends.test.ts
...
Test Suites: 3 passed, 3 total
Tests:       47 passed, 47 total
```

The 47/47 baseline is **clean**: every bug the prior spec flagged is
already fixed in source. The audit above targets the gaps the prior
spec missed.

---

## Recommended commit order

1. **A5** (data integrity, highest impact — same class as the prior
   bug #1) — touches `src/indexer.ts` only.
2. **A3** (false-positive observability corruption) — touches
   `src/sandbox/executor.ts`.
3. **A2** (sandbox-bound drift between paths) — touches
   `src/sandbox/executor.ts`.
4. **A4** (symlink dedup in walk) — touches `src/indexer.ts`.
5. **A1** (timeout cap visibility on sandbox path) — touches
   `src/sandbox/sandboxer.ts` and `src/sandbox/executor.ts`.
6. **A7** (docstring) — touches the comment on `findRepos` only.

A6 is verified-no-action.

Each commit should be small enough that the corresponding new test
goes red → green in a single PR.