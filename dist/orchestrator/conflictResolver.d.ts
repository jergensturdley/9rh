export type ConflictParty = "architect" | "implementer" | "reviewer" | "security_auditor" | "test_strategist";
export type ConflictResolution = "implementer_revises" | "reviewer_overridden" | "escalate_human" | "escalate_coordinator";
export interface Conflict {
    id: string;
    parties: [ConflictParty, ConflictParty];
    description: string;
    severity: "minor" | "major" | "blocking";
    resolution?: ConflictResolution;
    justification?: string;
    timestamp: number;
}
export interface ConflictLog {
    conflicts: Conflict[];
}
export declare function createConflictLog(): ConflictLog;
export declare function resolveConflict(conflict: Pick<Conflict, "parties" | "description" | "severity">, revisionCount: number, maxRevisions: number): {
    resolution: ConflictResolution;
    justification: string;
};
export declare function recordConflict(log: ConflictLog, conflict: Omit<Conflict, "id" | "timestamp">): Conflict;
export declare function canOverride(overridingRole: ConflictParty, overriddenRole: ConflictParty, justification: string): {
    allowed: boolean;
    reason: string;
};
