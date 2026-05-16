import type { ToolResultEvent, LLMResponseEvent } from "./eventSchema.js";

export interface Divergence {
  seq: number;
  eventType: string;
  step: number;
  field: string;
  expected: string;
  actual: string;
  severity: "minor" | "major" | "critical";
}

export interface DivergenceReport {
  runId: string;
  branchId: string;
  divergedAt: Divergence;
  totalEventsCompared: number;
  eventsBeforeDivergence: number;
}

export function detectToolDivergence(
  recorded: ToolResultEvent,
  replayed: ToolResultEvent
): Divergence[] {
  const divergences: Divergence[] = [];
  const step = recorded.step.stepIndex;

  if (recorded.payload.output !== replayed.payload.output) {
    const oLen = recorded.payload.output.length;
    const rLen = replayed.payload.output.length;
    const maxLen = Math.max(oLen, rLen);
    const pct = maxLen > 0 ? Math.round((1 - Math.abs(oLen - rLen) / maxLen) * 100) : 0;
    const severity = pct > 95 ? "minor" : pct > 80 ? "major" : "critical";
    divergences.push({
      seq: recorded.seq,
      eventType: "tool_result",
      step,
      field: "output",
      expected: recorded.payload.output.slice(0, 200),
      actual: replayed.payload.output.slice(0, 200),
      severity,
    });
  }

  if ((recorded.payload.error ?? "") !== (replayed.payload.error ?? "")) {
    divergences.push({
      seq: recorded.seq,
      eventType: "tool_result",
      step,
      field: "error",
      expected: recorded.payload.error ?? "none",
      actual: replayed.payload.error ?? "none",
      severity: "critical",
    });
  }

  return divergences;
}

export function detectLLMDivergence(
  recorded: LLMResponseEvent,
  replayed: LLMResponseEvent
): Divergence[] {
  const divergences: Divergence[] = [];
  const step = recorded.step.stepIndex;

  if (recorded.payload.finishReason !== replayed.payload.finishReason) {
    divergences.push({
      seq: recorded.seq,
      eventType: "llm_response",
      step,
      field: "finishReason",
      expected: recorded.payload.finishReason,
      actual: replayed.payload.finishReason,
      severity: "major",
    });
  }

  const recTools = recorded.payload.toolCalls;
  const repTools = replayed.payload.toolCalls;
  if (JSON.stringify(recTools) !== JSON.stringify(repTools)) {
    divergences.push({
      seq: recorded.seq,
      eventType: "llm_response",
      step,
      field: "toolCalls",
      expected: JSON.stringify(recTools ?? null).slice(0, 200),
      actual: JSON.stringify(repTools ?? null).slice(0, 200),
      severity: "critical",
    });
  }

  return divergences;
}

export function compareEventLogs(
  recordedEvents: (ToolResultEvent | LLMResponseEvent)[],
  replayedEvents: (ToolResultEvent | LLMResponseEvent)[]
): DivergenceReport | null {
  let firstDivergence: Divergence | null = null;
  let compared = 0;

  for (let i = 0; i < Math.min(recordedEvents.length, replayedEvents.length); i++) {
    const rec = recordedEvents[i];
    const rep = replayedEvents[i];
    compared++;

    let divs: Divergence[] = [];
    if (rec.type === "tool_result" && rep.type === "tool_result") {
      divs = detectToolDivergence(rec, rep);
    } else if (rec.type === "llm_response" && rep.type === "llm_response") {
      divs = detectLLMDivergence(rec, rep);
    }

    if (divs.length > 0 && !firstDivergence) {
      firstDivergence = divs[0];
      break;
    }
  }

  if (!firstDivergence) return null;

  return {
    runId: "",
    branchId: "",
    divergedAt: firstDivergence,
    totalEventsCompared: compared,
    eventsBeforeDivergence: compared - 1,
  };
}
