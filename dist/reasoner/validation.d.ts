import type { ReplayEvent } from "../replay/eventSchema.js";
interface ValidationIssue {
    path: string;
    message: string;
    severity: "error" | "warning";
}
export declare function validateEvent(event: ReplayEvent): ValidationIssue[];
export declare function repairEvent(event: ReplayEvent): ReplayEvent;
export declare function validateAndRepair(event: ReplayEvent): {
    event: ReplayEvent;
    issues: ValidationIssue[];
};
export {};
