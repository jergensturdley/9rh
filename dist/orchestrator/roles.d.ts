export type RoleName = "architect" | "implementer" | "reviewer" | "security_auditor" | "test_strategist";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export interface RoleDefinition {
    name: RoleName;
    displayName: string;
    systemPrompt: string;
    successCriteria: string[];
    riskThreshold: RiskLevel;
    authorityBoundaries: string[];
}
export declare function classifyRisk(task: string, plan?: string): RiskLevel;
export declare function requiresSecurityAudit(risk: RiskLevel): boolean;
export declare function requiresTestStrategy(task: string, plan?: string): boolean;
export declare function isTrivialEdit(task: string): boolean;
export declare const ROLE_DEFINITIONS: Record<RoleName, RoleDefinition>;
