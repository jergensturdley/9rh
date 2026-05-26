import type { AgentEvent } from "./agent.js";
import type { ReplayEvent } from "./replay/eventSchema.js";
export type RunStage = "planning" | "execution" | "review" | "repair" | "completion";
export type StepStatus = "queued" | "running" | "blocked" | "failed" | "repaired" | "done";
export type Severity = "info" | "warning" | "error";
export type StepRole = "agent" | "tool" | "checkpoint" | "reasoning" | "repair" | "incident";
export interface VisualStep {
    id: string;
    label: string;
    stage: RunStage;
    status: StepStatus;
    severity: Severity;
    role?: StepRole;
    tool?: string;
    file?: string;
    branch?: string;
    params?: string;
    output?: string;
    diff?: string;
    trace?: string;
    policy?: string;
    partialOutput?: string;
    incidentCause?: string;
    repairAttempt?: number;
    circuitOpen?: boolean;
    durationMs?: number;
    createdAt: number;
}
export interface VisualEdge {
    from: string;
    to: string;
    label: string;
}
export interface RunVisualization {
    currentStepId?: string;
    lastGoodCheckpointId?: string;
    sandboxHealth?: {
        total: number;
        sandboxed: number;
        direct: number;
        timedOut: number;
    };
    steps: VisualStep[];
    edges: VisualEdge[];
}
export interface VisualizationFilter {
    stage?: RunStage;
    status?: StepStatus;
    severity?: Severity;
    role?: StepRole;
    tool?: string;
    file?: string;
    branch?: string;
    collapseNoise?: boolean;
    sinceStep?: number;
    untilStep?: number;
}
export declare function createRunVisualization(): RunVisualization;
export declare function applyAgentEvent(view: RunVisualization, event: AgentEvent): RunVisualization;
export declare function applyReplayEvent(view: RunVisualization, event: ReplayEvent): void;
export declare function visibleSteps(view: RunVisualization, filter?: VisualizationFilter): VisualStep[];
export declare function inspectStep(view: RunVisualization, stepId: string): VisualStep | null;
export declare function exportRunVisualization(view: RunVisualization, filter?: VisualizationFilter): string;
export declare function exportRunVisualizationGraphviz(view: RunVisualization, filter?: VisualizationFilter): string;
export declare function renderRunVisualization(view: RunVisualization, filter?: VisualizationFilter): string;
export declare function renderRunMapCompact(view: RunVisualization, maxWidth?: number): string[];
