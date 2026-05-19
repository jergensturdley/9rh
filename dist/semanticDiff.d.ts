export type BehaviorType = "control_flow" | "signature" | "side_effect" | "validation" | "data_access" | "security" | "formatting" | "module_scope";
export type SemanticSeverity = "info" | "low" | "medium" | "high" | "critical";
export interface FileSnapshot {
    path: string;
    before: string;
    after: string;
}
export interface SemanticChange {
    id: string;
    file: string;
    line?: number;
    severity: SemanticSeverity;
    behavior: BehaviorType;
    summary: string;
    evidence: string;
}
export interface IntentRiskAssessment {
    matchesIntent: boolean;
    mismatches: string[];
    scopeJustificationsRequired: string[];
    riskScore: number;
    riskLevel: SemanticSeverity;
    riskFactors: string[];
    downstreamEffects: string[];
}
export interface SemanticReview {
    plainDiff: string;
    semanticSummary: SemanticChange[];
    intentRisk: IntentRiskAssessment;
}
export interface SemanticReviewFilter {
    severity?: SemanticSeverity;
    module?: string;
    behavior?: BehaviorType;
}
export declare function createPlainDiff(files: FileSnapshot[]): string;
export declare function createSemanticReview(task: string, files: FileSnapshot[]): SemanticReview;
export declare function filterSemanticChanges(changes: SemanticChange[], filter: SemanticReviewFilter): SemanticChange[];
export declare function formatSemanticReview(review: SemanticReview, filter?: SemanticReviewFilter): string;
