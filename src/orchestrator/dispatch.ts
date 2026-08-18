/**
 * Team suggestion heuristic — decide whether a task looks structured enough
 * that the harness should OFFER the multi-role `Orchestrator.orchestrate()`
 * pipeline ("run as a team?").
 *
 * This is deliberately a suggestion trigger, not a router: the old version
 * silently redirected matching tasks into the pipeline, which made dispatch
 * opaque ("why did my task spawn five roles?"). Now the only ways into the
 * pipeline are explicit — the `--orchestrate` flag, the `/team` command, or
 * the user accepting the suggestion prompt this function gates.
 *
 * Heuristic: task text mentions ≥1 of a small list of "design-pattern"
 * keywords — "plan", "design", "audit", "architect", "implement".
 * Conservative by design: it deliberately does NOT fire on common short
 * verbs ("fix", "read", "build") so the streaming loop stays the default
 * for the bulk of interactive usage.
 */
export function shouldSuggestTeam(task: string): boolean {
  if (!task || task.trim().length === 0) return false;
  return /\b(plan|design|audit|architect|implement)\b/i.test(task);
}
