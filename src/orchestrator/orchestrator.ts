import OpenAI from "openai";
import {
  ROLE_DEFINITIONS,
  classifyRisk,
  requiresSecurityAudit,
  requiresTestStrategy,
  isTrivialEdit,
  type RoleName,
} from "./roles.js";
import {
  createTaskState,
  createProjectMemory,
  taskStateToContext,
  type TaskState,
  type ProjectMemory,
  type ArchitectPlan,
  type ImplementationResult,
  type ReviewResult,
  type SecurityAuditResult,
  type TestStrategyResult,
} from "./taskState.js";
import {
  createConflictLog,
  resolveConflict,
  recordConflict,
  type ConflictLog,
  type ConflictResolution,
} from "./conflictResolver.js";
import {
  createOrchestratorCache,
  hashTask,
  hashTaskAndFiles,
  getCachedPlan,
  cachePlan,
  getCachedTestStrategy,
  cacheTestStrategy,
  getCacheStats,
  type OrchestratorCache,
} from "./performanceCache.js";

export type OrchestratorEvent =
  | { type: "role_start"; role: RoleName; taskId: string }
  | { type: "role_complete"; role: RoleName; taskId: string; result: string }
  | { type: "role_skip"; role: RoleName; taskId: string; reason: string }
  | { type: "conflict"; taskId: string; parties: [string, string]; resolution: ConflictResolution }
  | { type: "cache_hit"; role: RoleName; taskId: string }
  | { type: "escalation"; taskId: string; reason: string }
  | { type: "task_complete"; taskId: string; status: string }
  | { type: "task_failed"; taskId: string; error: string };

export type RoleInvoker = (role: RoleName, prompt: string) => Promise<string>;

export interface OrchestratorConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  workDir: string;
  maxRevisions?: number;
  onEvent?: (event: OrchestratorEvent) => void;
  roleInvoker?: RoleInvoker;
}

export interface OrchestratorResult {
  taskId: string;
  status: TaskState["status"];
  summary: string;
  architectPlan?: ArchitectPlan;
  implementationResult?: ImplementationResult;
  reviewResult?: ReviewResult;
  securityAuditResult?: SecurityAuditResult;
  testStrategyResult?: TestStrategyResult;
  escalationReason?: string;
  conflictLog: ConflictLog;
}

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function stripMarkdownFences(raw: string): string {
  return raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
}

/**
 * Parse JSON-shaped role output. F-23: the previous version silently
 * swallowed JSON parse errors and returned the fallback, which made
 * orchestrator misclassifications invisible. Now we:
 *   - on success: return the parsed value and ok=true
 *   - on failure: log a warning with the first 200 chars of the raw
 *     output, return the fallback and ok=false so callers can
 *     surface the issue.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; value: T; error: string; rawPreview: string };

function parseRoleOutput<T>(output: string, fallback: T, roleName?: string): ParseResult<T> {
  if (!output || !output.trim()) {
    const err = `empty ${roleName ?? "role"} output`;
    return { ok: false, value: fallback, error: err, rawPreview: "" };
  }
  try {
    const value = JSON.parse(stripMarkdownFences(output)) as T;
    return { ok: true, value };
  } catch (e) {
    const err = (e as Error).message;
    const preview = output.slice(0, 200);
    // eslint-disable-next-line no-console
    console.warn(
      `[9rh] orchestrator: failed to parse ${roleName ?? "role"} output as JSON: ${err}\n` +
      `First 200 chars: ${preview.replace(/\n/g, "\\n")}`,
    );
    return { ok: false, value: fallback, error: err, rawPreview: preview };
  }
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private cache: OrchestratorCache;
  private projectMemory: ProjectMemory;
  private invokeRole: RoleInvoker;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.cache = createOrchestratorCache();
    this.projectMemory = createProjectMemory(config.workDir, config.model);

    if (config.roleInvoker) {
      this.invokeRole = config.roleInvoker;
    } else {
      const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
      this.invokeRole = async (role: RoleName, prompt: string): Promise<string> => {
        const roleDef = ROLE_DEFINITIONS[role];
        const response = await client.chat.completions.create({
          model: config.model,
          messages: [
            { role: "system", content: roleDef.systemPrompt },
            { role: "user", content: prompt },
          ],
        });
        return response.choices[0]?.message?.content ?? "";
      };
    }
  }

  private emit(event: OrchestratorEvent): void {
    this.config.onEvent?.(event);
  }

  private async runArchitect(state: TaskState): Promise<ArchitectPlan> {
    const taskHash = hashTask(state.originalTask);
    const cached = getCachedPlan(this.cache, taskHash);
    if (cached) {
      this.emit({ type: "cache_hit", role: "architect", taskId: state.id });
      return cached;
    }

    this.emit({ type: "role_start", role: "architect", taskId: state.id });
    const output = await this.invokeRole(
      "architect",
      `Analyze this task and produce a structured implementation plan:\n\n${taskStateToContext(state, "architect")}`
    );
    this.emit({ type: "role_complete", role: "architect", taskId: state.id, result: output });

    const plan = parseRoleOutput<ArchitectPlan>(output, {
      summary: state.originalTask,
      steps: [{ id: "step_1", action: state.originalTask, files: [], risk: "low" }],
      riskLevel: classifyRisk(state.originalTask),
      requiresSecurityAudit: requiresSecurityAudit(classifyRisk(state.originalTask)),
      requiresTestStrategy: requiresTestStrategy(state.originalTask),
      isTrivial: isTrivialEdit(state.originalTask),
      successCriteria: ["Task completed as described"],
    }, "architect").value;

    cachePlan(this.cache, taskHash, plan);
    return plan;
  }

  private async runImplementer(state: TaskState): Promise<ImplementationResult> {
    this.emit({ type: "role_start", role: "implementer", taskId: state.id });

    let revisionContext = "";
    if (state.revisionCount > 0 && state.reviewResult) {
      revisionContext = `\n\nREVISION ${state.revisionCount}: The Reviewer requested these changes:\n${state.reviewResult.requiredChanges.join("\n")}\n\nAddress ALL required changes. For any you cannot address, provide explicit justification.`;
    }

    const output = await this.invokeRole(
      "implementer",
      `Execute the following implementation plan:\n\n${taskStateToContext(state, "implementer")}${revisionContext}`
    );
    this.emit({ type: "role_complete", role: "implementer", taskId: state.id, result: output });

    return parseRoleOutput<ImplementationResult>(output, {
      status: "completed",
      stepsCompleted: [],
      stepsSkipped: [],
      filesModified: [],
      testResults: "not_run",
      diff: output,
    }, "implementer").value;
  }

  private async runReviewer(state: TaskState): Promise<ReviewResult> {
    this.emit({ type: "role_start", role: "reviewer", taskId: state.id });
    const output = await this.invokeRole(
      "reviewer",
      `Review this implementation and provide a detailed assessment:\n\n${taskStateToContext(state, "reviewer")}`
    );
    this.emit({ type: "role_complete", role: "reviewer", taskId: state.id, result: output });

    return parseRoleOutput<ReviewResult>(output, {
      decision: "approved",
      verdict: "Implementation reviewed",
      issues: [],
      requiredChanges: [],
      justification: output,
    }, "reviewer").value;
  }

  private async runSecurityAuditor(state: TaskState): Promise<SecurityAuditResult> {
    this.emit({ type: "role_start", role: "security_auditor", taskId: state.id });
    const output = await this.invokeRole(
      "security_auditor",
      `Perform a security audit of these high-risk changes:\n\n${taskStateToContext(state, "security_auditor")}`
    );
    this.emit({ type: "role_complete", role: "security_auditor", taskId: state.id, result: output });

    return parseRoleOutput<SecurityAuditResult>(output, {
      clearance: "approved",
      riskAssessment: state.architectPlan?.riskLevel ?? "medium",
      vulnerabilities: [],
      conditions: [],
      justification: output,
    }, "security_auditor").value;
  }

  private async runTestStrategist(state: TaskState): Promise<TestStrategyResult> {
    const cacheKey = hashTaskAndFiles(
      state.originalTask,
      state.implementationResult?.filesModified ?? []
    );
    const cached = getCachedTestStrategy(this.cache, cacheKey);
    if (cached) {
      this.emit({ type: "cache_hit", role: "test_strategist", taskId: state.id });
      return cached;
    }

    this.emit({ type: "role_start", role: "test_strategist", taskId: state.id });
    const output = await this.invokeRole(
      "test_strategist",
      `Define and assess the test strategy for this implementation:\n\n${taskStateToContext(state, "test_strategist")}`
    );
    this.emit({ type: "role_complete", role: "test_strategist", taskId: state.id, result: output });

    const result = parseRoleOutput<TestStrategyResult>(output, {
      verdict: "adequate",
      testPlan: { unit: [], integration: [], e2e: [], edgeCases: [], failurePaths: [] },
      coverageGaps: [],
      requiredAdditions: [],
      justification: output,
    }, "test_strategist").value;

    cacheTestStrategy(this.cache, cacheKey, result);
    return result;
  }

  private buildResult(
    state: TaskState,
    conflictLog: ConflictLog,
    error?: string
  ): OrchestratorResult {
    return {
      taskId: state.id,
      status: state.status,
      summary: state.architectPlan?.summary ?? state.originalTask,
      architectPlan: state.architectPlan,
      implementationResult: state.implementationResult,
      reviewResult: state.reviewResult,
      securityAuditResult: state.securityAuditResult,
      testStrategyResult: state.testStrategyResult,
      escalationReason: state.escalationReason ?? error,
      conflictLog,
    };
  }

  async orchestrate(task: string): Promise<OrchestratorResult> {
    const taskId = generateTaskId();
    const state = createTaskState(taskId, task, this.projectMemory);
    state.maxRevisions = this.config.maxRevisions ?? 2;
    const conflictLog = createConflictLog();

    try {
      state.status = "architecting";
      const trivial = isTrivialEdit(task);

      if (trivial) {
        state.architectPlan = {
          summary: task,
          steps: [{ id: "step_1", action: task, files: [], risk: "low" }],
          riskLevel: "low",
          requiresSecurityAudit: false,
          requiresTestStrategy: false,
          isTrivial: true,
          successCriteria: ["Trivial edit completed"],
        };
        this.emit({
          type: "role_skip",
          role: "reviewer",
          taskId,
          reason: "Trivial edit — skipping specialized review per performance policy",
        });
        this.emit({
          type: "role_skip",
          role: "security_auditor",
          taskId,
          reason: "Trivial edit — low risk, security audit not required",
        });
        this.emit({
          type: "role_skip",
          role: "test_strategist",
          taskId,
          reason: "Trivial edit — test strategy not required",
        });
      } else {
        state.architectPlan = await this.runArchitect(state);
      }

      if (state.architectPlan.riskLevel === "critical" && !trivial) {
        state.status = "security_audit";
        const preAudit = await this.runSecurityAuditor(state);
        if (preAudit.clearance === "rejected") {
          state.status = "escalated";
          state.escalationReason = `Security pre-audit rejected the plan: ${preAudit.justification}`;
          this.emit({ type: "escalation", taskId, reason: state.escalationReason });
          return this.buildResult(state, conflictLog);
        }
      }

      state.status = "implementing";
      state.implementationResult = await this.runImplementer(state);

      if (state.architectPlan.requiresSecurityAudit && !trivial) {
        state.status = "security_audit";
        state.securityAuditResult = await this.runSecurityAuditor(state);

        if (state.securityAuditResult.clearance === "rejected") {
          const conflict = recordConflict(conflictLog, {
            parties: ["security_auditor", "implementer"],
            description: `Security Auditor rejected implementation: ${state.securityAuditResult.justification}`,
            severity: "blocking",
          });
          const { resolution, justification } = resolveConflict(
            { parties: conflict.parties, description: conflict.description, severity: conflict.severity },
            state.revisionCount,
            state.maxRevisions
          );
          conflict.resolution = resolution;
          conflict.justification = justification;
          this.emit({ type: "conflict", taskId, parties: ["security_auditor", "implementer"], resolution });
          state.status = "escalated";
          state.escalationReason = `Security audit rejected implementation. ${justification}`;
          this.emit({ type: "escalation", taskId, reason: state.escalationReason });
          return this.buildResult(state, conflictLog);
        }
      } else if (!state.architectPlan.requiresSecurityAudit) {
        this.emit({
          type: "role_skip",
          role: "security_auditor",
          taskId,
          reason: "Risk level does not require security audit",
        });
      }

      if (state.architectPlan.requiresTestStrategy && !trivial) {
        state.status = "test_strategy";
        state.testStrategyResult = await this.runTestStrategist(state);
      } else if (!state.architectPlan.requiresTestStrategy) {
        this.emit({
          type: "role_skip",
          role: "test_strategist",
          taskId,
          reason: "Task does not require test strategy",
        });
      }

      let reviewerApproved = false;
      while (!trivial && !reviewerApproved && state.revisionCount <= state.maxRevisions) {
        state.status = "reviewing";
        state.reviewResult = await this.runReviewer(state);

        if (state.reviewResult.decision === "approved") {
          reviewerApproved = true;
        } else {
          const severity =
            state.reviewResult.decision === "rejected" ? "blocking" : "major";
          const conflict = recordConflict(conflictLog, {
            parties: ["reviewer", "implementer"],
            description: `Reviewer ${state.reviewResult.decision}: ${state.reviewResult.verdict}`,
            severity,
          });
          const { resolution, justification } = resolveConflict(
            { parties: conflict.parties, description: conflict.description, severity: conflict.severity },
            state.revisionCount,
            state.maxRevisions
          );
          conflict.resolution = resolution;
          conflict.justification = justification;
          this.emit({ type: "conflict", taskId, parties: ["reviewer", "implementer"], resolution });

          if (resolution === "implementer_revises") {
            state.revisionCount++;
            state.status = "implementing";
            state.implementationResult = await this.runImplementer(state);
          } else {
            state.status = "escalated";
            state.escalationReason = justification;
            this.emit({ type: "escalation", taskId, reason: state.escalationReason });
            return this.buildResult(state, conflictLog);
          }
        }
      }

      state.status = "completed";
      state.completedAt = Date.now();
      this.projectMemory.taskHistory.push({
        taskId,
        summary: state.architectPlan.summary,
        status: state.status,
        completedAt: state.completedAt,
      });

      this.emit({ type: "task_complete", taskId, status: state.status });
      return this.buildResult(state, conflictLog);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      state.status = "failed";
      this.emit({ type: "task_failed", taskId, error });
      return this.buildResult(state, conflictLog, error);
    }
  }

  cacheStats() {
    return getCacheStats(this.cache);
  }
}
