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

  constructor(options: ReplayOptions) {
    this.options = options;
  }

  async load(): Promise<void> {
    const raw = await readFile(this.options.eventLogPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    this.events = lines.map((l) => JSON.parse(l) as ReplayEvent);
  }

  async replay(): Promise<{ eventCount: number; divergenceReport: DivergenceReport | null }> {
    const fromStep = this.options.fromStep ?? 0;
    let eventCount = 0;

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
        try {
          const freshResult = await executeTool(tc.payload.toolName, tc.payload.args, this.options.workDir);
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

    return { eventCount, divergenceReport: null };
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
