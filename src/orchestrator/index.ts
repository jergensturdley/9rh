export { Orchestrator } from "./orchestrator.js";
export type { OrchestratorConfig, OrchestratorEvent, OrchestratorResult, RoleInvoker } from "./orchestrator.js";

export { ROLE_DEFINITIONS, classifyRisk, requiresSecurityAudit, requiresTestStrategy, isTrivialEdit, assessToolRisk, riskAtOrAbove, DEFAULT_TOOL_RISK_THRESHOLD } from "./roles.js";
export type { RoleName, RiskLevel, RoleDefinition, ToolCall, ToolRiskLevel } from "./roles.js";

export {
  createTaskState,
  createProjectMemory,
  taskStateToContext,
  getArchitectContext,
  getImplementerContext,
  getReviewerContext,
  getSecurityAuditContext,
  getTestStrategyContext,
} from "./taskState.js";
export type {
  TaskState,
  TaskStatus,
  ProjectMemory,
  ArchitectPlan,
  ImplementationResult,
  ReviewResult,
  SecurityAuditResult,
  TestStrategyResult,
} from "./taskState.js";

export {
  createConflictLog,
  resolveConflict,
  recordConflict,
  canOverride,
} from "./conflictResolver.js";
export type { Conflict, ConflictLog, ConflictParty, ConflictResolution } from "./conflictResolver.js";

export {
  createOrchestratorCache,
  hashTask,
  hashTaskAndFiles,
  getCachedPlan,
  cachePlan,
  getCachedTestStrategy,
  cacheTestStrategy,
  getCacheStats,
  clearExpiredCache,
} from "./performanceCache.js";
export type { OrchestratorCache, CacheEntry } from "./performanceCache.js";
