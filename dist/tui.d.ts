import type { AgentEvent } from "./agent.js";
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
export declare function shouldRepositionSplashFrame(startMs: number, nowMs: number, timeoutMs: number): boolean;
export declare function splashFrameDelayMs(): number;
export declare function splashAnimationFrameCount(): number;
export declare function splashCollapseFrameCount(): number;
export declare function printSplash(useColor: boolean): Promise<void>;
export declare function createTuiRenderer(opts: TuiOptions): (event: AgentEvent) => void;
