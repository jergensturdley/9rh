/**
 * One agent session hosted in the Electron main process.
 *
 * Mirrors the CLI wiring in the engine's src/index.ts (makeAgent, withLedger,
 * runTeamPipeline, runTask, interactiveAskUser, interactiveToolApproval) with
 * the terminal replaced by an event stream plus a pending-request slot the
 * renderer answers over IPC.
 *
 * ponytail: runs in-process; move to an Electron utilityProcess with the same
 * public API if a tool ever blocks the UI thread.
 */

import { stat } from "fs/promises";
import {
  Agent,
  Orchestrator,
  SessionLedger,
  applyRewind,
  buildTurnDigest,
  compressUserInput,
  discoverSkills,
  getSandboxStatus,
  ninerhDir,
  planRewind,
} from "9rh";
import type {
  AgentConfig,
  AskUserRequest,
  AskUserResponse,
  Backend,
  ContinuationPolicy,
  LedgerTurn,
  ModelInfo,
  OrchestratorConfig,
  RewindResult,
  SkillManifestEntry,
  StoredToolResult,
  ToolApprovalDecision,
  ToolApprovalRequest,
  TurnDigest,
} from "9rh";
import type {
  FileDiff,
  PendingRequest,
  RewindPlanView,
  RunTaskInput,
  RunTaskOutcome,
  SessionCreateInput,
  SessionEvent,
  SessionEventEnvelope,
  SessionSnapshot,
  SessionStatus,
  TurnDigestLite,
  TurnSummary,
} from "@shared/ipc";
import { computeLineDiff } from "./diff";

export interface AgentLike {
  run(task: string): Promise<void>;
  abort(): void;
  requestStop(): void;
}

export interface OrchestratorLike {
  orchestrate(task: string): Promise<{ status: string; summary: string; escalationReason?: string }>;
}

export interface SessionHostDeps {
  backend: Backend;
  emit: (env: SessionEventEnvelope) => void;
  onChanged: (snap: SessionSnapshot) => void;
  /** Default: `new Agent(config)`. */
  createAgent?: (config: AgentConfig) => AgentLike;
  /** Default: `new Orchestrator(config)`. */
  createOrchestrator?: (config: OrchestratorConfig) => OrchestratorLike;
  now?: () => number;
  /** Flight recorder log directory. Default: `ninerhDir("runs")`. */
  runsDir?: string;
}

/** Retained envelopes per session for renderer reloads. */
const RING_CAP = 5000;

function workDirPrefix(workDir: string): string {
  return workDir.endsWith("/") ? workDir : `${workDir}/`;
}

/** Same relativization as the engine's summarizeFileChanges. */
function relativePath(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function liteDigest(digest: TurnDigest, prefix: string): TurnDigestLite {
  const { fileChangeRecords, ...rest } = digest;
  const diffablePaths = [...new Set((fileChangeRecords ?? []).map((r) => relativePath(r.path, prefix)))];
  return { ...rest, diffablePaths };
}

function toTurnSummary(turn: LedgerTurn, prefix: string): TurnSummary {
  return {
    index: turn.index,
    task: turn.task,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    status: turn.status,
    tokens: turn.tokens ? { ...turn.tokens } : undefined,
    digest: turn.digest ? liteDigest(turn.digest, prefix) : undefined,
    roleTokens: turn.roleTokens ? { ...turn.roleTokens } : undefined,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SessionHost {
  readonly id: string;
  private readonly deps: SessionHostDeps;
  private readonly now: () => number;
  private readonly runsDir: string;
  private readonly createAgent: (config: AgentConfig) => AgentLike;
  private readonly createOrchestrator: (config: OrchestratorConfig) => OrchestratorLike;
  private readonly ledger: SessionLedger;
  private readonly createdAt: number;

  private status: SessionStatus = "idle";
  private seq = 0;
  private requestSeq = 0;
  private ring: SessionEventEnvelope[] = [];
  private pending: PendingRequest | null = null;
  // One slot is enough: ask_user and approval-gated calls are classified
  // above "low" risk, so the agent serializes them behind its mutation lock.
  private pendingResolve: ((value: unknown) => void) | null = null;
  private agent: AgentLike | null = null;
  private abortRequested = false;
  private disposed = false;
  /** Last done/error seen in the current turn, for the outcome. */
  private lastTerminal: "done" | "error" | null = null;

  private quiet = false;
  private teamMode: boolean;
  private model: string;
  private workDir: string;
  private readonly maxIterations: number;
  private readonly toolConcurrency: number;
  private readonly continuationPolicy: ContinuationPolicy | undefined;
  private readonly allowSkillInstall: boolean;
  private readonly keepReports: boolean;
  private lastReportPath: string | null = null;
  private warnings: string[] = [];
  private lastError: string | null = null;
  private turnStartedAt: number | null = null;

  constructor(id: string, input: SessionCreateInput, model: string, deps: SessionHostDeps) {
    this.id = id;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.runsDir = deps.runsDir ?? ninerhDir("runs");
    this.createAgent =
      deps.createAgent ??
      ((config) => {
        // Agent.run resolves the final text; the host only needs completion.
        const agent = new Agent(config);
        return {
          run: async (task) => {
            await agent.run(task);
          },
          abort: () => agent.abort(),
          requestStop: () => agent.requestStop(),
        };
      });
    this.createOrchestrator = deps.createOrchestrator ?? ((config) => new Orchestrator(config));
    this.createdAt = this.now();
    this.ledger = new SessionLedger(this.createdAt);
    this.model = model;
    this.workDir = input.workDir;
    this.teamMode = input.teamMode ?? false;
    this.maxIterations = input.maxIterations ?? 100;
    this.toolConcurrency = input.toolConcurrency ?? 4;
    this.continuationPolicy = input.continuationPolicy;
    this.allowSkillInstall = input.allowSkillInstall ?? false;
    this.keepReports = input.keepReports ?? false;
  }

  // -------------------------------------------------------------------------
  // Snapshot and history
  // -------------------------------------------------------------------------

  snapshot(): SessionSnapshot {
    const view = this.ledger.view(this.now());
    const prefix = workDirPrefix(this.workDir);
    const sandbox = getSandboxStatus();
    const { backend } = this.deps;
    return {
      id: this.id,
      workDir: this.workDir,
      model: this.model,
      backendName: backend.name,
      backendDescription: backend.describe(),
      baseURL: backend.baseURL,
      hasNativeRouter: backend.hasNativeRouter,
      status: this.status,
      createdAt: this.createdAt,
      turnStartedAt: this.turnStartedAt,
      ledger: {
        sessionStartedAt: view.sessionStartedAt,
        turnCount: view.turnCount,
        completedTurnCount: view.completedTurnCount,
        goal: view.goal,
        goalActive: view.goalActive,
        lastOutcome: view.lastOutcome,
        tokens: { ...view.tokens },
        filesTouched: view.filesTouched,
        commandsRun: view.commandsRun,
        turns: view.turns.map((t) => toTurnSummary(t, prefix)),
      },
      sandbox: {
        kind: sandbox.kind,
        label: sandbox.kind === "available" ? "seatbelt" : "none",
        detail: sandbox.kind === "unavailable" ? sandbox.reason : undefined,
      },
      pending: this.pending,
      quiet: this.quiet,
      teamMode: this.teamMode,
      maxIterations: this.maxIterations,
      toolConcurrency: this.toolConcurrency,
      allowSkillInstall: this.allowSkillInstall,
      keepReports: this.keepReports,
      lastReportPath: this.lastReportPath,
      warnings: [...this.warnings],
      lastError: this.lastError,
    };
  }

  history(sinceSeq = 0): SessionEventEnvelope[] {
    return this.ring.filter((e) => e.seq > sinceSeq);
  }

  recentToolResults(): StoredToolResult[] {
    return [...this.ledger.recentToolResults()];
  }

  // -------------------------------------------------------------------------
  // Running a turn
  // -------------------------------------------------------------------------

  async run(input: RunTaskInput): Promise<RunTaskOutcome> {
    if (this.isRunning()) throw new Error("session busy");
    const text = compressUserInput(input.task).text;
    const team = input.team ?? this.teamMode;
    const startedAt = this.now();

    this.abortRequested = false;
    this.lastTerminal = null;
    this.lastError = null;
    this.ledger.beginTurn(text, startedAt);
    this.turnStartedAt = startedAt;
    this.status = "running";
    const turnIndex = this.ledger.view().turnCount;
    this.emitEvent({ type: "turn_start", task: text, turnIndex, team });
    this.changed();

    let threw = false;
    try {
      if (team) await this.runTeam(text, startedAt);
      else await this.runAgent(text);
    } catch (err) {
      threw = true;
      this.lastError = errorMessage(err);
      if (this.ledger.view().goalActive) {
        this.emitEvent({ type: "error", message: this.lastError });
      }
    }

    const status: RunTaskOutcome["status"] = this.abortRequested
      ? "aborted"
      : threw || this.lastTerminal === "error"
        ? "error"
        : "completed";
    const durationMs = Math.max(0, this.now() - startedAt);
    this.status = status === "error" ? "error" : "idle";
    this.pending = null;
    this.pendingResolve = null;
    this.turnStartedAt = null;
    this.emitEvent({ type: "turn_end", turnIndex, status, durationMs });
    this.changed();
    return { status, durationMs };
  }

  private async runAgent(text: string): Promise<void> {
    const { backend } = this.deps;
    const agent = this.createAgent({
      baseURL: backend.baseURL,
      apiKey: backend.apiKey,
      model: this.model,
      maxIterations: this.maxIterations,
      toolConcurrency: this.toolConcurrency,
      workDir: this.workDir,
      onEvent: (e) => this.emitEvent(e),
      continuationPolicy: this.continuationPolicy,
      keepReports: this.keepReports,
      // Parallel sessions must not share the engine's single last-run.html.
      reportPath: this.keepReports ? undefined : ninerhDir("reports", `${this.id}-last-run.html`),
      allowSkillInstall: this.allowSkillInstall,
      onToolApproval: (req) => this.awaitApproval(req),
      onAskUser: (req) => this.awaitAsk(req),
      replay: { enabled: true, logDir: this.runsDir },
    });
    this.agent = agent;
    try {
      await agent.run(text);
    } finally {
      this.agent = null;
    }
  }

  /** Mirrors runTeamPipeline in the engine's src/index.ts. */
  private async runTeam(task: string, startedAt: number): Promise<void> {
    const { backend } = this.deps;
    let rolesRun = 0;
    // ponytail: the orchestrator has no abort hook; abort() only marks the
    // outcome and the pipeline runs to completion.
    const orchestrator = this.createOrchestrator({
      baseURL: backend.baseURL,
      apiKey: backend.apiKey,
      model: this.model,
      workDir: this.workDir,
      onEvent: (event) => {
        if (event.type === "role_complete") rolesRun++;
        this.emitEvent({ type: "team", event });
      },
    });
    try {
      const result = await orchestrator.orchestrate(task);
      const tokens = this.ledger.view().turns.at(-1)?.tokens;
      const digest = buildTurnDigest(
        { task, startedAt, workDir: this.workDir, fileChanges: [], toolCalls: [] },
        { status: result.status === "completed" ? "completed" : "error", steps: rolesRun, tokens, now: this.now() },
      );
      let text = result.summary;
      if (result.escalationReason) text += `\n\nEscalated: ${result.escalationReason}`;
      if (result.status === "completed") {
        this.emitEvent({ type: "done", text, digest });
      } else {
        this.emitEvent({ type: "error", message: text, digest });
      }
    } catch (err) {
      this.emitEvent({ type: "error", message: errorMessage(err) });
      throw err;
    }
  }

  /** Fold into the ledger first (like withLedger), then push to the ring and renderer. */
  private emitEvent(event: SessionEvent): void {
    if (this.disposed) return;
    let outbound: SessionEvent = event;
    if (event.type !== "turn_start" && event.type !== "turn_end") {
      this.ledger.onAgentEvent(event, this.now());
      if (event.type === "done" || event.type === "error") {
        this.lastTerminal = event.type;
        if (event.reportPath) this.lastReportPath = event.reportPath;
        // The ledger keeps the raw before/after records for rewind and diff;
        // the renderer gets the lite digest with workDir-relative diffable paths.
        if (event.digest) outbound = { ...event, digest: liteDigest(event.digest, workDirPrefix(this.workDir)) };
      }
    }
    const env: SessionEventEnvelope = { sessionId: this.id, seq: ++this.seq, ts: this.now(), event: outbound };
    this.ring.push(env);
    // ponytail: shift() is O(n) but the cap is small; a circular index if it shows up in a profile.
    if (this.ring.length > RING_CAP) this.ring.shift();
    this.deps.emit(env);
    if (event.type === "usage" || event.type === "done" || event.type === "error") this.changed();
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  stop(): void {
    this.agent?.requestStop();
  }

  abort(): void {
    if (!this.isRunning()) return;
    this.abortRequested = true;
    this.agent?.abort();
    this.dismissPending();
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
    this.changed();
  }

  setTeamMode(teamMode: boolean): void {
    this.teamMode = teamMode;
    this.changed();
  }

  setModel(model: string): void {
    this.assertIdle("change the model");
    this.model = model;
    this.changed();
  }

  async setWorkDir(workDir: string): Promise<void> {
    this.assertIdle("change the working directory");
    const info = await stat(workDir);
    if (!info.isDirectory()) throw new Error(`not a directory: ${workDir}`);
    this.workDir = workDir;
    this.changed();
  }

  async listModels(filter?: string): Promise<ModelInfo[]> {
    const models = await this.deps.backend.listModels();
    if (!filter) return models;
    const needle = filter.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(needle));
  }

  skills(): Promise<SkillManifestEntry[]> {
    return discoverSkills(this.workDir);
  }

  // -------------------------------------------------------------------------
  // Human in the loop
  // -------------------------------------------------------------------------

  private awaitAsk(req: AskUserRequest): Promise<AskUserResponse> {
    return this.waitFor<AskUserResponse>({
      kind: "ask",
      requestId: this.nextRequestId(),
      question: req.question,
      options: [...req.options],
      allowFreeText: req.allowFreeText,
    });
  }

  private awaitApproval(req: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    return this.waitFor<ToolApprovalDecision>({
      kind: "approval",
      requestId: this.nextRequestId(),
      name: req.name,
      args: req.args,
      risk: req.risk,
      threshold: req.threshold,
    });
  }

  answerAsk(requestId: string, answer: string): void {
    this.assertPending("ask", requestId);
    this.resolvePending({ answer });
  }

  decideApproval(requestId: string, approved: boolean, reason?: string): void {
    this.assertPending("approval", requestId);
    this.resolvePending({ approved, reason: reason ?? (approved ? undefined : "rejected by user") });
  }

  private waitFor<T>(request: PendingRequest): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pending = request;
      this.pendingResolve = resolve as (value: unknown) => void;
      this.status = "waiting";
      this.changed();
    });
  }

  private assertPending(kind: PendingRequest["kind"], requestId: string): void {
    if (!this.pending || this.pending.kind !== kind || this.pending.requestId !== requestId) {
      throw new Error(`no pending ${kind} request ${requestId}`);
    }
  }

  private resolvePending(value: AskUserResponse | ToolApprovalDecision): void {
    const resolve = this.pendingResolve;
    this.pending = null;
    this.pendingResolve = null;
    if (this.status === "waiting") this.status = "running";
    this.changed();
    resolve?.(value);
  }

  /** Dismiss semantics match the TUI's Esc: empty answer, approval refused. */
  private dismissPending(): void {
    if (!this.pending) return;
    this.resolvePending(this.pending.kind === "ask" ? { answer: "" } : { approved: false, reason: "aborted" });
  }

  private nextRequestId(): string {
    return `${this.id}:req-${++this.requestSeq}`;
  }

  // -------------------------------------------------------------------------
  // Rewind and diff
  // -------------------------------------------------------------------------

  rewindPlan(targetTurnIndex: number): RewindPlanView {
    const plan = planRewind(this.ledger.view().turns, targetTurnIndex);
    return {
      targetTurnIndex,
      writes: plan.actions.filter((a) => a.kind === "write").map((a) => a.path),
      deletes: plan.actions.filter((a) => a.kind === "delete").map((a) => a.path),
      skips: plan.skips,
    };
  }

  async rewindApply(targetTurnIndex: number): Promise<RewindResult> {
    this.assertIdle("rewind");
    return applyRewind(planRewind(this.ledger.view().turns, targetTurnIndex), this.workDir);
  }

  diff(turnIndex: number, path: string): FileDiff {
    const prefix = workDirPrefix(this.workDir);
    const turn = this.ledger.view().turns.find((t) => t.index === turnIndex);
    const records = (turn?.digest?.fileChangeRecords ?? []).filter(
      (r) => r.path === path || relativePath(r.path, prefix) === path,
    );
    const first = records[0];
    const last = records[records.length - 1];
    if (!first || !last) throw new Error(`no file change record for ${path} in turn ${turnIndex}`);
    const { lines, added, removed } = computeLineDiff(first.before, last.after);
    return {
      path,
      operation: first.operation,
      added,
      removed,
      lines,
      beforeTruncated: first.beforeTruncated,
      afterTruncated: last.afterTruncated,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private isRunning(): boolean {
    return this.status === "running" || this.status === "waiting";
  }

  private assertIdle(what: string): void {
    if (this.isRunning()) throw new Error(`cannot ${what} while a turn is running`);
  }

  private changed(): void {
    if (this.disposed) return;
    this.deps.onChanged(this.snapshot());
  }
}
