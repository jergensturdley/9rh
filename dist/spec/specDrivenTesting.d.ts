export type RequirementKind = "functional" | "edge" | "constraint" | "non-goal" | "bug" | "ambiguous";
export type TestType = "unit" | "integration" | "edge" | "regression";
export type TestPath = "happy" | "failure";
export interface RequirementStatement {
    id: string;
    kind: RequirementKind;
    text: string;
    originalIndex: number;
}
export interface ParsedSpecification {
    original: string;
    functionalBehavior: RequirementStatement[];
    edgeCases: RequirementStatement[];
    constraints: RequirementStatement[];
    nonGoals: RequirementStatement[];
    bugReports: RequirementStatement[];
    ambiguities: RequirementStatement[];
}
export interface SynthesizedTest {
    id: string;
    type: TestType;
    path: TestPath;
    requirementIds: string[];
    title: string;
    intent: string;
    expectedInitialState: "unknown" | "failing";
}
export interface CoverageEntry {
    requirementId: string;
    statement: string;
    testIds: string[];
    status: "covered" | "gap";
    note?: string;
}
export interface SynthesizedTestPlan {
    tests: SynthesizedTest[];
    assumptions: string[];
    coverage: CoverageEntry[];
    gaps: CoverageEntry[];
    warnings: string[];
    canAutoProceed: boolean;
    confidence: "high" | "medium" | "low";
}
export declare function parseTaskSpecification(task: string): ParsedSpecification;
export declare function synthesizeTestPlan(spec: ParsedSpecification): SynthesizedTestPlan;
export declare function formatSpecDrivenPrompt(task: string): string;
export declare function shouldUseSpecDrivenTesting(task: string): boolean;
