export { Agent } from "./agent.js";
export { TOOL_DEFINITIONS, executeTool } from "./tools.js";
export { ensureRouter } from "./init.js";
export {
  DirectBackend,
  RouterBackend,
  NINE_ROUTER_OPENAI,
  detectBackend,
  type Backend,
  type BackendName,
  type ComboInfo,
  type DetectOptions,
  type DetectResult,
  type HealthSnapshot,
  type KeyInfo,
  type ModelInfo,
  type ProviderInfo,
} from "./backends/index.js";
export {
  renderRunReport,
  escapeHtml,
  type RunReportData,
  type RunStatus,
  type TokenUsage,
  type ToolCallRecord,
  type ReasoningChunk,
  type FileChangeRecord,
  type FileChangeOperation,
  type ErrorRecord,
  type RepairRecord,
  type CompactionRecord,
} from "./reports/index.js";
export {
  formatSpecDrivenPrompt,
  parseTaskSpecification,
  shouldUseSpecDrivenTesting,
  synthesizeTestPlan,
} from "./spec/specDrivenTesting.js";
export {
  applyAgentEvent,
  applyReplayEvent,
  createRunVisualization,
  exportRunVisualization,
  renderRunVisualization,
  visibleSteps,
} from "./visualization.js";
export type { AgentConfig, AgentEvent, ContinuationModelSwitch, ContinuationPolicy } from "./agent.js";
export type { ToolResult, ExecuteToolOptions } from "./tools.js";
export type { InitResult } from "./init.js";
export type {
  CoverageEntry,
  ParsedSpecification,
  RequirementKind,
  RequirementStatement,
  SynthesizedTest,
  SynthesizedTestPlan,
  TestPath,
  TestType,
} from "./spec/specDrivenTesting.js";
export type {
  RunStage,
  RunVisualization,
  Severity,
  StepStatus,
  VisualEdge,
  VisualizationFilter,
  VisualStep,
} from "./visualization.js";
export { Orchestrator } from "./orchestrator/index.js";
export {
  createPlainDiff,
  createSemanticReview,
  filterSemanticChanges,
  formatSemanticReview,
} from "./semanticDiff.js";
export type {
  OrchestratorConfig,
  OrchestratorEvent,
  OrchestratorResult,
  RoleInvoker,
} from "./orchestrator/index.js";
export type {
  RoleName,
  RiskLevel,
  RoleDefinition,
} from "./orchestrator/index.js";
export type {
  TaskState,
  TaskStatus,
  ProjectMemory,
  ArchitectPlan,
  ImplementationResult,
  ReviewResult,
  SecurityAuditResult,
  TestStrategyResult,
} from "./orchestrator/index.js";
export type {
  Conflict,
  ConflictLog,
  ConflictParty,
  ConflictResolution,
} from "./orchestrator/index.js";
export type {
  BehaviorType,
  FileSnapshot,
  IntentRiskAssessment,
  SemanticChange,
  SemanticReview,
  SemanticReviewFilter,
  SemanticSeverity,
} from "./semanticDiff.js";

// ---------------------------------------------------------------------------
// Embedder surface (desktop app, programmatic harnesses). Additive re-exports
// of engines the CLI already wires: ledger, rewind, replay, config, router
// auth, presets, HITL types, and pure reducers. No behavior lives here.
// ---------------------------------------------------------------------------
export { SessionLedger, buildTurnDigest } from "./ledger.js";
export type {
  LedgerView,
  LedgerTurn,
  TurnDigest,
  DigestFileEntry,
  DigestCommandEntry,
  StoredToolResult,
} from "./ledger.js";
export { planRewind, applyRewind } from "./rewind.js";
export type { RewindPlan, RewindAction, RewindSkip, RewindResult } from "./rewind.js";
export { listRunLogs, readEventLog, renderEventLog, mapReplayEvent } from "./flightRecorder.js";
export type { RunLogInfo, ReplayRenderOptions } from "./flightRecorder.js";
export type { ReplayEvent } from "./replay/eventSchema.js";
export { readUserConfig, updateUserConfig, resolveConfiguredModel, configPath } from "./config.js";
export type { UserConfig, SandboxBackend } from "./config.js";
export { ninerhHome, ninerhDir } from "./paths.js";
export { getCliToken, readFirstApiKey } from "./init.js";
export { PROVIDER_PRESETS, getProviderPreset, listProviderPresetIds } from "./backends/presets.js";
export type { ProviderPreset } from "./backends/presets.js";
export { resolveAskUserCall } from "./agent.js";
export type {
  AskUserRequest,
  AskUserResponse,
  ToolApprovalRequest,
  ToolApprovalDecision,
} from "./agent.js";
export type { ToolRiskLevel } from "./orchestrator/roles.js";
export { compressUserInput } from "./inputCompression.js";
export { shouldSuggestTeam } from "./orchestrator/dispatch.js";
export { discoverSkills } from "./skills.js";
export type { SkillManifestEntry, SkillSource } from "./skills.js";
export { getSandboxStatus } from "./sandbox/index.js";
export type { SandboxStatus } from "./sandbox/sandboxer.js";
export { applyTeamEvent } from "./tui.js";
export type { TeamLane, TeamLaneEvent } from "./tui.js";
