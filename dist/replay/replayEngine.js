import { readFile } from "fs/promises";
import { executeTool } from "../tools.js";
import { restoreSnapshot } from "../repair/snapshotManager.js";
export class ReplayEngine {
    options;
    events = [];
    eventIndex = 0;
    stepIndex = 0;
    diverged = false;
    recordedOutputs = new Map();
    constructor(options) {
        this.options = options;
    }
    async load() {
        const raw = await readFile(this.options.eventLogPath, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        this.events = lines.map((l) => JSON.parse(l));
    }
    async replay() {
        const fromStep = this.options.fromStep ?? 0;
        let eventCount = 0;
        for (const event of this.events) {
            this.eventIndex++;
            this.options.onEvent?.(event);
            if (event.type === "step_start") {
                const step = event.step;
                this.stepIndex = step?.stepIndex ?? this.stepIndex + 1;
                if (this.stepIndex < fromStep)
                    continue;
            }
            if (this.stepIndex < fromStep)
                continue;
            if (event.type === "checkpoint" && fromStep > 0) {
                const cp = event;
                await restoreSnapshot(cp.payload.snapshotId);
                this.stepIndex = cp.step.stepIndex;
                continue;
            }
            if (event.type === "tool_result" && !this.diverged) {
                const te = event;
                this.recordedOutputs.set(te.payload.callId, te.payload.output);
            }
            if (event.type === "tool_call" && !this.diverged) {
                const tc = event;
                try {
                    const freshResult = await executeTool(tc.payload.toolName, tc.payload.args, this.options.workDir);
                    const recordedOutput = this.recordedOutputs.get(tc.payload.callId);
                    if (recordedOutput !== undefined && this.options.stopOnDivergence) {
                        if (freshResult.output !== recordedOutput) {
                            const divergence = {
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
                }
                catch { }
                eventCount++;
            }
            if (event.type === "llm_response" && !this.diverged && this.options.llmProvider) {
                const llm = event;
                try {
                    const reqEvents = this.events.slice(0, this.eventIndex);
                    const reqEvent = reqEvents.reverse().find((e) => e.type === "llm_request");
                    if (reqEvent) {
                        await this.options.llmProvider.complete(reqEvent.payload.messages, reqEvent.payload.model, reqEvent.payload);
                    }
                }
                catch { }
                eventCount++;
            }
        }
        return { eventCount, divergenceReport: null };
    }
    isDiverged() {
        return this.diverged;
    }
    getEventAt(index) {
        return this.events[index];
    }
    getEventCount() {
        return this.events.length;
    }
}
//# sourceMappingURL=replayEngine.js.map