import type { TaggedError } from "./errorTaxonomy.js";
export interface IncidentReport {
    timestamp: number;
    errorType: string;
    rootCause: string;
    attemptsCount: number;
    fixApplied: string;
    outcome: "REPAIRED" | "ESCALATED" | "FAILED";
    durationMs: number;
    userMessage: string;
    sourceLayer: string;
    errorClass: string;
}
export interface PlaybookEntry {
    id: string;
    pattern: string;
    errorClass: string;
    suggestedFix: string;
    autoApply: boolean;
}
export declare function logIncident(errorContext: TaggedError, repairAttempts: number, outcome: IncidentReport["outcome"], durationMs: number, userMessage: string): Promise<void>;
export declare function generatePlaybookEntry(incident: IncidentReport): Promise<PlaybookEntry>;
export declare function appendPlaybookEntry(entry: PlaybookEntry): Promise<void>;
