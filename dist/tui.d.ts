import type { AgentEvent } from "./agent.js";
import { type RunVisualization } from "./visualization.js";
export interface TuiOptions {
    getModel: () => string;
    getWorkDir: () => string;
    getBaseURL?: () => string;
    getStartedByRouter?: () => boolean | undefined;
    useColor: boolean;
}
export interface SplashOptions extends TuiOptions {
    provider: string;
    project: string;
    status: string;
}
export interface TranscriptEntry {
    kind: "agent" | "tool" | "result" | "system" | "error";
    text: string;
}
export declare function renderRecentTranscript(entries: TranscriptEntry[], maxLines?: number): string;
export declare function summarizeLiveModelInsight(recentThinking: string[], toolName: string, args: Record<string, unknown>): string;
export declare function shouldRepositionSplashFrame(startMs: number, nowMs: number, timeoutMs: number): boolean;
export declare function splashFrameDelayMs(): number;
export declare function splashAnimationFrameCount(): number;
export declare function splashCollapseFrameCount(): number;
export declare function printSplash(useColor: boolean): Promise<void>;
export interface ToolHistoryEntry {
    status: "running" | "success" | "error";
    name: string;
    target: string;
}
export interface DashboardState {
    startedAt: Date;
    iterCurrent: number;
    iterMax: number;
    activity: "idle" | "thinking" | "tool" | "done" | "error";
    thinkingCharCount: number;
    thinkingPreview: string;
    currentTool: string | null;
    currentToolTarget: string | null;
    toolHistory: ToolHistoryEntry[];
}
export declare function formatElapsed(start: Date): string;
export declare function toolTarget(args: Record<string, unknown>): string;
export declare function renderDashboardLines(state: DashboardState, useColor: boolean, w: number, runMap: RunVisualization): string[];
export declare function createTuiRenderer(opts: TuiOptions): (event: AgentEvent) => void;
