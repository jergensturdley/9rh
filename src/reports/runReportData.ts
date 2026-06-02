/**
 * Data shape for the run report.
 *
 * The renderer (`renderRunReport` in runReport.ts) consumes this — it is
 * deliberately framework-free so it can be tested in isolation and used
 * programmatically (e.g. by `Agent` after a run completes, or by a future
 * "render past replay log" utility).
 *
 * The `Agent` class builds one of these incrementally as a run progresses,
 * then passes it to the renderer on the `done` event.
 */

export type RunStatus = "completed" | "aborted" | "error" | "max_iterations";

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ToolCallRecord {
  step: number;
  name: string;
  args: Record<string, unknown>;
  output?: string;
  error?: string;
  durationMs?: number;
  timestamp: number;
}

export interface ReasoningChunk {
  step: number;
  text: string;
  timestamp: number;
}

export type FileChangeOperation = "create" | "edit";

export interface FileChangeRecord {
  step: number;
  path: string;
  operation: FileChangeOperation;
  /** The file content BEFORE the write. `undefined` when the file did not exist. */
  before?: string;
  /** The file content AFTER the write. */
  after: string;
  /** True when `before` or `after` was truncated to fit the report. */
  beforeTruncated?: boolean;
  afterTruncated?: boolean;
}

export interface ErrorRecord {
  step: number;
  message: string;
  timestamp: number;
}

export interface RepairRecord {
  step: number;
  attempt: number;
  outcome: "REPAIRED" | "ESCALATED" | "PENDING";
  message: string;
  timestamp: number;
}

export interface CompactionRecord {
  step: number;
  /** One-line summary of the compaction (already collapsed from the long packet). */
  summary: string;
  timestamp: number;
}

export interface RunReportData {
  runId: string;
  task: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  model: string;
  backendName: string;
  hasNativeRouter: boolean;
  status: RunStatus;
  steps: number;
  compactionCount: number;
  /** Captured from the final streaming chunk. */
  tokenUsage?: TokenUsage;
  toolCalls: ToolCallRecord[];
  reasoning: ReasoningChunk[];
  fileChanges: FileChangeRecord[];
  errors: ErrorRecord[];
  repairs: RepairRecord[];
  compactions: CompactionRecord[];
  /** Optional path to the replay log (JSONL), if one was written. */
  replayLogPath?: string;
}
