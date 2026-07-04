/**
 * Complexity gate — decide whether a task should be routed through the
 * multi-role `Orchestrator.orchestrate()` pipeline instead of the
 * streaming `Agent.run()` loop.
 *
 * Two triggers, in priority order:
 *   1. Explicit `--orchestrate` flag (`opts.force === true`) → dispatch
 *      regardless of task text. Use this when the user has signaled an
 *      intent for structured multi-role output.
 *   2. Heuristic: task text mentions ≥1 of a small list of
 *      "design-pattern" keywords — "plan", "design", "audit",
 *      "architect", "implement". Conservative by design: false negatives
 *      (a complex task falling through to the streaming loop) are
 *      recoverable; false positives (multi-role pipeline where streaming
 *      would have sufficed) cost more compute and latency.
 *
 * Heuristic deliberately does NOT auto-fire on common short verbs
 * ("fix", "read", "build") to keep the streaming loop as the default
 * for the bulk of interactive usage.
 */
export function shouldUseOrchestrator(
  task: string,
  opts?: { force?: boolean },
): boolean {
  if (opts?.force === true) return true;
  if (!task || task.trim().length === 0) return false;
  return /\b(plan|design|audit|architect|implement)\b/i.test(task);
}
