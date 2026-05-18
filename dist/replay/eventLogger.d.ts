import type { ReplayEvent } from "./eventSchema.js";
export interface EventLoggerConfig {
    runId: string;
    branchId: string;
    logDir: string;
    flushEvery?: number;
}
export declare class EventLogger {
    private runId;
    private branchId;
    private logPath;
    private writer;
    private seq;
    private pending;
    private flushEvery;
    private finalized;
    constructor(config: EventLoggerConfig);
    init(): Promise<void>;
    log(event: Omit<ReplayEvent, "seq" | "ts">): void;
    flush(): void;
    finalize(runId: string, reason: string): Promise<string>;
    getLogPath(): string;
}
export declare function readEventLog(path: string): Promise<ReplayEvent[]>;
