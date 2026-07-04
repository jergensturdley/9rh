# Spec — `Orchestrator.orchestrate` Wiring Decision

Status: spec only. No production code is modified by this document.
Audience: subagents (or a future session) that will implement the chosen
resolution path.

Verification basis: codegraph returned zero callers for
`Orchestrator.orchestrate`; the cross-referenced barrel
`src/orchestrator/index.ts` re-exports the class without instantiating
it; the only invocations in the repo are in
`src/__tests__/orchestrator.test.ts` (8 sites).

---

## Problem statement

`Orchestrator.orchestrate(task)` is a complete, tested, multi-role
pipeline (architect → implementer → security audit → test strategist
→ reviewer loop, with caching and project-memory writes), but it has
**no production caller**. The runtime CLI dispatches the streaming
`Agent` ReAct loop in `src/agent.ts`; the `Orchestrator` class is
exposed only as a library surface.

Consequences:

1. **God-node signal in the graph.** The orchestrator module appears
   as a high-degree node in `graphify-out/graph.html` (Community 0,
   degree 36) that connects to role definitions (Community 2) and
   state/context helpers (Community 15) via the barrel re-export in
   `src/orchestrator/index.ts`. A reader who follows those edges
   reasonably concludes that the orchestrator is load-bearing — it
   is not.
2. **Dead public API surface.** External embedders can `import { Orchestrator }`
   but receive no guidance on whether to use it or how. There is no
   "library-only" marker.
3. **Missed architectural intent.** The class was clearly designed as
   a structured alternative to the streaming loop. Whether to wire it
   in, mark it as embedding-only, or delete it is an open product
   question.

This spec lists the three resolution paths and the contract each path
must satisfy. Subagents should pick **one** path and execute it
end-to-end.

---

## Path A — Wire `Orchestrator.orchestrate` into the CLI

**Effort:** Medium (touches CLI dispatch + agent loop).
**Risk:** Medium (changes the runtime path users hit).

### Required changes

1. **Identify the dispatch point.** Open `src/index.ts` and locate the
   REPL `task runner` that invokes the streaming `Agent` loop.
   Record the file path and line range in the PR description.
2. **Define a complexity gate.** Decide which tasks should route to
   `Orchestrator.orchestrate` vs the streaming loop. Recommended
   default:
   - tasks with `--orchestrate` flag → `Orchestrator`
   - tasks with `--complex` heuristic (e.g. > 2 distinct verbs, or
     references "plan"/"design"/"audit") → `Orchestrator`
   - everything else → existing `Agent` loop
3. **Wire the call.** Construct an `Orchestrator` with the active
   backend's model and the user's `workDir`, then
   `await orchestrator.orchestrate(prompt)`. Stream `OrchestratorEvent`s
   into the same event channel the REPL already renders.
4. **Result mapping.** Convert `OrchestratorResult` to whatever
   final-response shape the existing `Agent.run()` returns so the
   REPL downstream is unchanged.
5. **Cache plumbing.** The `OrchestratorCache` is library-exported
   but not yet wired to disk. Either:
   - reuse the existing in-memory cache (simplest), OR
   - persist to `<workDir>/.9rh/orchestrator-cache.json` with a TTL
     (default 1 hour, configurable).
6. **Telemetry.** Emit a one-line log per `OrchestratorEvent` to the
   same logger the `Agent` loop uses.

### Acceptance

- A user running `9rh --orchestrate "refactor the indexer to use
  streaming writes"` enters the multi-role pipeline and the final
  result includes an `ArchitectPlan`, `ImplementationResult`,
  `ReviewResult`, and (if risk is high) `SecurityAuditResult`.
- All 8 existing tests in `src/__tests__/orchestrator.test.ts` still
  pass — they exercise the class directly and are unaffected by CLI
  wiring.
- A `--help` flag documents the new path.
- The orchestrator-cache file is created on second run with the same
  task; `cacheStats()` reflects the hit.

### Rollback

A single revert of the wiring commit returns the CLI to its prior
behavior. The `Orchestrator` class is unchanged.

---

## Path B — Mark as `@internal` / library-only

**Effort:** Low (JSDoc + README only, no runtime change).
**Risk:** Low (additive documentation).

### Required changes

1. **Add JSDoc `@internal` to the public surface.** In
   `src/orchestrator/index.ts`, prepend a header comment to the file
   and `@internal` to each re-export that is not used by production:
   ```ts
   /**
    * @internal
    *
    * This module is a public embedding API for external integrations.
    * The 9rh CLI itself does NOT use `Orchestrator` — runtime
    * dispatch goes through the streaming `Agent` loop in
    * `src/agent.ts`. Do not assume that calling `orchestrate()`
    * from within this repo will be exercised by tests of the CLI;
    * it is exercised only by `src/__tests__/orchestrator.test.ts`.
    */
   ```
   Tag every exported symbol in the barrel with `@internal` if it is
   not consumed by `src/index.ts`, `src/agent.ts`, `src/commands.ts`,
   or `src/main.ts`.
2. **README section.** In `README.md`, add a `Library API` section
   that points at `src/orchestrator/index.ts` and warns readers that
   the class is for embedding, not for driving the CLI.
3. **No code change.** Do not modify `Orchestrator` or its members.

### Acceptance

- JSDoc tags render in editor hover/tooltip and in any `typedoc`
  output the project generates.
- README change is reviewed and merged.
- All existing tests still pass (no production code touched).

### Rollback

Trivial — revert the docs commit.

---

## Path C — Delete the unused scaffolding

**Effort:** Low–Medium (delete files + tests + barrel).
**Risk:** Medium (public API surface change).

### Required changes

1. **Inventory current callers** (re-run codegraph before deleting):
   - `Orchestrator` and friends in `src/orchestrator/index.ts`
   - Direct usage in `src/__tests__/orchestrator.test.ts` (8 sites)
   - Any other test fixtures (`src/__tests__/*.test.ts` that imports
     from the orchestrator barrel — grep to confirm).
2. **Decide the deletion scope.**
   - Conservative: delete `src/orchestrator/` and
     `src/__tests__/orchestrator.test.ts` entirely.
   - Less conservative: keep the role definitions (`roles.ts`) and
     state helpers (`taskState.ts`) because they document the
     conceptual model; delete only `orchestrator.ts`,
     `conflictResolver.ts`, and `performanceCache.ts`.
3. **Update the barrel exports.** If step 2 is conservative, prune
   `src/orchestrator/index.ts` to only the survivors.
4. **Update documentation.** Remove the "library API" implication
   from any README section that referenced it.
5. **Add a migration note** in the PR description: "External
   embedders using `Orchestrator.orchestrate` should pin to the
   previous release."

### Acceptance

- `npm run build` succeeds.
- `npm test` (excluding the deleted test file) passes.
- `grep -r "from \"./orchestrator" src/` returns no results after
   deletion.

### Rollback

Revert the deletion commit; re-add the files from git history.

---

## Selection criteria (for the implementer)

Pick **Path A** if any of:
- The product wants structured multi-role output for complex tasks.
- The graph god-node signal should be made real (the edges become
  load-bearing).
- Telemetry on role-level decisions is wanted.

Pick **Path B** if:
- `Orchestrator` is intentionally an embedding surface for external
  tools and the CLI will never use it.
- The cost of wiring + regression risk is too high for the current
  sprint.
- The god-node signal is acceptable as long as it's documented.

Pick **Path C** if:
- `Orchestrator` has no embedder and no committed roadmap to add one.
- The graph god-node is misleading enough that documentation alone
  (Path B) is not worth the maintenance.
- The team is comfortable breaking a public API (or there is no
  external consumer to break).

If unsure, default to **Path B**. It is strictly additive, reversible,
and removes the most common source of confusion ("why does this exist
but isn't used?") without committing to a product decision.

---

## Out of scope for all paths

- The `Agent` streaming loop itself. Do not modify `src/agent.ts` in
  this work; it is the production-critical path.
- The `OrchestratorCache` TTL semantics. Use the existing in-memory
  implementation; persisting to disk is a separate decision.
- Renaming the `Orchestrator` class. If a rename happens (e.g. to
  `LibraryOrchestrator` or `EmbedderPipeline`), it must be coordinated
  with Path A's wiring so external references stay consistent.
- Tests beyond `src/__tests__/orchestrator.test.ts`. Do not add tests
  for Paths A or B; the existing contract tests are sufficient.

---

## Subagent briefing template

When dispatching a subagent for the chosen path, include in the
prompt:

1. **The chosen path letter** (A, B, or C).
2. **The acceptance criteria** for that path, copied verbatim from
   this spec.
3. **A pointer to the relevant file(s):**
   - Path A → `src/index.ts`, `src/agent.ts`, `src/orchestrator/orchestrator.ts`
   - Path B → `src/orchestrator/index.ts`, `README.md`
   - Path C → `src/orchestrator/`, `src/__tests__/orchestrator.test.ts`
4. **The graphify orientation rule.** "Before reading raw source,
   run `graphify query` / `graphify explain` / `graphify path` to
   scope the subgraph. Use `Read` only for the specific lines you'll
   modify."
5. **The cost notice.** "Use codegraph for structural questions;
   it is cheaper than grep + Read loops."
6. **The verification gate.** "Run `npm run build` and
   `NODE_OPTIONS='--experimental-vm-modules' node_modules/.bin/jest
   --config jest.config.ts` before reporting completion. Report
   command output verbatim."
