/**
 * Run report generation for 9rh.
 *
 * After every agent turn, the harness writes a self-contained HTML report
 * summarizing the run — what the model reasoned about, which tools it
 * called, which files it changed, how many tokens it spent, and any errors
 * or repairs that happened along the way.
 *
 * The renderer is pure (no I/O, no clock) so it can be tested in isolation
 * and reused for past runs from the replay log.
 *
 * By default the report is overwritten on every turn (`~/.9rh/last-run.html`).
 * Set `keepReports: true` in `~/.9rh/config.json` to embed the runId in the
 * filename so each turn is preserved. The path is also overridable per
 * invocation via `--report-path`.
 */

export {
  renderRunReport,
  escapeHtml,
} from "./runReport.js";
export type {
  RunReportData,
  RunStatus,
  TokenUsage,
  ToolCallRecord,
  ReasoningChunk,
  FileChangeRecord,
  FileChangeOperation,
  ErrorRecord,
  RepairRecord,
  CompactionRecord,
} from "./runReportData.js";
