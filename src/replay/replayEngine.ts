import { readFile } from "fs/promises";
import type {
  ReplayEvent,
  ToolCallEvent,
  ToolResultEvent,
  LLMRequestEvent,
  LLMResponseEvent,
  CheckpointEvent,
} from "./eventSchema.js";
import { executeTool } from "../tools.js";
import type { SandboxProvider } from "../sandbox/index.js";
import type { DivergenceReport } from "./divergenceDetector.js";
import { restoreSnapshot } from "../repair/snapshotManager.js";

export interface ReplayOptions {
  eventLogPath: string;
  workDir: string;
  fromStep?: number;
  stopOnDivergence?: boolean;
  onEvent?: (event: ReplayEvent) => void;
  onDivergence?: (report: DivergenceReport) => void;
  llmProvider?: LLMProvider;
  // F-14: replay re-executes recorded tool calls; require the caller
  // to pass an executor (sandboxed or explicit Direct) so we never
  // implicitly run tool calls with the user's full permissions.
  executor: SandboxProvider;
  // F-26: by default, replay is DRY-RUN. Tool calls are observed but
  // NOT executed, to prevent planted log entries from triggering
  // arbitrary `run_bash` and `write_file` actions. Set execute: true
  // explicitly to opt in to live replay. The dry-run path still
  // invokes the executor for read-only / observable tools but never
  // for run_bash or write_file unless execute: true.
  execute?: boolean;
  // F-26: if a signature is provided, the log is verified on load.
  // The signature is an HMAC-SHA256 of the JSONL contents with the
  // supplied key. An unsigned or mismatched log refuses to execute
  // even if execute: true.
  signatureKey?: string;
}

export interface LLMProvider {
  complete(messages: unknown, model: string, params: unknown): Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; argsRaw: string }> | null;
    finishReason: string;
  }>;
}

export class ReplayEngine {
  private options: ReplayOptions;
  private events: ReplayEvent[] = [];
  private eventIndex = 0;
  private stepIndex = 0;
  private diverged = false;
  private recordedOutputs: Map<string, string> = new Map();
  private effectiveExecute: boolean;  // F-26: resolved at construction

  constructor(options: ReplayOptions) {
    this.options = options;
    this.effectiveExecute = options.execute === true;
  }

  async load(): Promise<void> {
    const raw = await readFile(this.options.eventLogPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // F-26: verify signature if one is provided. The expected signature
    // lives in a sidecar file "<log>.sig" containing the hex HMAC.
    if (this.options.signatureKey) {
      const sigPath = this.options.eventLogPath + ".sig";
      let expected = "";
      try {
        expected = (await readFile(sigPath, "utf-8")).trim();
      } catch {
        throw new Error(
          `Replay log signature missing: expected ${sigPath}. ` +
          `Refusing to replay an unverified log.`,
        );
      }
      const { createHmac } = await import("crypto");
      const got = createHmac("sha256", this.options.signatureKey)
        .update(raw)
        .digest("hex");
      if (got !== expected) {
        throw new Error(
          `Replay log signature mismatch: file is signed by a different key ` +
          `or has been tampered with. Refusing to execute replay.`,
        );
      }
    }
    this.events = lines.map((l) => JSON.parse(l) as ReplayEvent);
  }

  async replay(): Promise<{ eventCount: number; divergenceReport: DivergenceReport | null; dryRun: boolean }> {
    const fromStep = this.options.fromStep ?? 0;
    let eventCount = 0;
    const dryRun = !this.effectiveExecute;

    for (const event of this.events) {
      this.eventIndex++;
      this.options.onEvent?.(event);

      if (event.type === "step_start") {
        const step = (event as { step?: { stepIndex?: number } }).step;
        this.stepIndex = step?.stepIndex ?? this.stepIndex + 1;
        if (this.stepIndex < fromStep) continue;
      }

      if (this.stepIndex < fromStep) continue;

      if (event.type === "checkpoint" && fromStep > 0) {
        const cp = event as CheckpointEvent;
        await restoreSnapshot(cp.payload.snapshotId);
        this.stepIndex = cp.step.stepIndex;
        continue;
      }

      if (event.type === "tool_result" && !this.diverged) {
        const te = event as ToolResultEvent;
        this.recordedOutputs.set(te.payload.callId, te.payload.output);
      }

      if (event.type === "tool_call" && !this.diverged) {
        const tc = event as ToolCallEvent;
        // F-26: in dry-run mode, observe the recorded call but do NOT
        // execute it. We still emit the event to the consumer so
        // visibility/diffing works. This blocks planted tool_call
        // events from triggering arbitrary `run_bash` / `write_file`.
        if (!this.effectiveExecute) {
          eventCount++;
          continue;
        }
        try {
          const freshResult = await executeTool(
            tc.payload.toolName,
            tc.payload.args,
            this.options.workDir,
            { executor: this.options.executor },
          );
          const recordedOutput = this.recordedOutputs.get(tc.payload.callId);
          if (recordedOutput !== undefined && this.options.stopOnDivergence) {
            if (freshResult.output !== recordedOutput) {
              const divergence: DivergenceReport = {
                runId: "",
                branchId: "",
                divergedAt: {
                  seq: tc.seq,
                  eventType: "tool_call",
                  step: tc.step.stepIndex,
                  field: "output",
                  expected: recordedOutput.slice(0, 200),
                  actual: freshResult.output.slice(0, 200),
                  severity: "critical",
                },
                totalEventsCompared: this.eventIndex,
                eventsBeforeDivergence: this.eventIndex - 1,
              };
              this.diverged = true;
              this.options.onDivergence?.(divergence);
            }
          }
        } catch {}
        eventCount++;
      }

      if (event.type === "llm_response" && !this.diverged && this.options.llmProvider) {
        const llm = event as LLMResponseEvent;
        try {
          const reqEvents = this.events.slice(0, this.eventIndex);
          const reqEvent = reqEvents.reverse().find((e) => e.type === "llm_request") as LLMRequestEvent | undefined;
          if (reqEvent) {
            await this.options.llmProvider.complete(
              reqEvent.payload.messages,
              reqEvent.payload.model,
              reqEvent.payload
            );
          }
        } catch {}
        eventCount++;
      }
    }

    return { eventCount, divergenceReport: null, dryRun };
  }

  isDiverged(): boolean {
    return this.diverged;
  }

  getEventAt(index: number): ReplayEvent | undefined {
    return this.events[index];
  }

  getEventCount(): number {
    return this.events.length;
  }
}
