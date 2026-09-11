/**
 * IPC contract between the Electron main process and the renderer.
 *
 * This file is the single source of truth for channel names and the
 * request / response / event shapes on them. Both `src/preload/index.ts`
 * (which builds `window.ninerh`) and `src/main/ipc.ts` (which registers the
 * handlers) import from here, so the two sides cannot drift.
 *
 * Engine types come from the `9rh` package as type-only imports; they are
 * erased at build time, so the renderer never bundles Node code.
 */

import type {
  AgentEvent,
  ContinuationPolicy,
  ModelInfo,
  ProviderPreset,
  RewindResult,
  RewindSkip,
  RunLogInfo,
  SkillManifestEntry,
  StoredToolResult,
  ToolRiskLevel,
  TokenUsage,
  TurnDigest,
  UserConfig,
} from "9rh";
import type {
  RouterApiKey,
  RouterAuthStatus,
  RouterCombo,
  RouterComboInput,
  RouterHealth,
  RouterModel,
  RouterModelAvailability,
  RouterProvider,
  RouterSettingsSummary,
  RouterTunnelStatus,
  RouterUsageChartPoint,
  RouterUsageStats,
  RouterVersion,
} from "./routerTypes.js";

export type { AgentEvent, ModelInfo, ProviderPreset, TokenUsage, TurnDigest, UserConfig };

// ---------------------------------------------------------------------------
// Result envelope: every invoke-style handler resolves to this, never throws.
// ---------------------------------------------------------------------------

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: unknown): IpcResult<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type BackendMode = "auto" | "router" | "direct";

/** How a session should reach its LLM. `auto` runs 9rh's six-layer detection. */
export interface BackendChoice {
  mode: BackendMode;
  /** Router mode: OpenAI-compatible base URL (default http://127.0.0.1:20128/v1). */
  routerUrl?: string;
  /** Router mode: bearer key override. */
  routerKey?: string;
  /** Direct mode: provider preset id (openai | openrouter | ollama | lmstudio). */
  preset?: string;
  /** Direct mode: explicit base URL; wins over the preset. */
  directUrl?: string;
  /** Direct mode: API key. Kept in memory for the session only, never persisted. */
  directKey?: string;
}

export interface SessionCreateInput {
  workDir: string;
  model?: string;
  backend?: BackendChoice;
  maxIterations?: number;
  toolConcurrency?: number;
  continuationPolicy?: ContinuationPolicy;
  allowSkillInstall?: boolean;
  keepReports?: boolean;
  /** Start in team (orchestrator) mode. Toggleable later via setTeamMode. */
  teamMode?: boolean;
}

export type SessionStatus = "idle" | "running" | "waiting" | "error";

export type PendingRequest =
  | {
      kind: "ask";
      requestId: string;
      question: string;
      /** Recommended default first. Empty when free-form only. */
      options: string[];
      allowFreeText: boolean;
    }
  | {
      kind: "approval";
      requestId: string;
      name: string;
      args: Record<string, unknown>;
      risk: ToolRiskLevel;
      threshold: ToolRiskLevel;
    };

export interface SandboxChip {
  kind: "available" | "unavailable";
  /** Short label for the HUD: "seatbelt", "none". */
  label: string;
  detail?: string;
}

/** `TurnDigest` without the raw before/after file records (too large for IPC). */
export type TurnDigestLite = Omit<TurnDigest, "fileChangeRecords"> & {
  /** Paths that have before/after records available for `sessions.diff`. */
  diffablePaths: string[];
};

export interface TurnSummary {
  index: number;
  task: string;
  startedAt: number;
  endedAt?: number;
  status?: "completed" | "error" | string;
  tokens?: TokenUsage;
  digest?: TurnDigestLite;
  roleTokens?: Record<string, TokenUsage>;
}

/** Mirror of 9rh's `LedgerView` with lite turns. */
export interface LedgerSnapshot {
  sessionStartedAt: number;
  turnCount: number;
  completedTurnCount: number;
  goal: string | null;
  goalActive: boolean;
  lastOutcome: string | null;
  tokens: TokenUsage;
  filesTouched: number;
  commandsRun: number;
  turns: TurnSummary[];
}

export interface SessionSnapshot {
  id: string;
  workDir: string;
  model: string;
  backendName: "router" | "direct" | "embedded";
  /** Human origin line, e.g. "router (connected) → http://127.0.0.1:20128/v1". */
  backendDescription: string;
  baseURL: string;
  hasNativeRouter: boolean;
  status: SessionStatus;
  createdAt: number;
  /** Set while a turn runs. */
  turnStartedAt: number | null;
  /** True after abort() until the turn ends: the engine cancels the stream but a running tool call returns first. */
  aborting?: boolean;
  ledger: LedgerSnapshot;
  sandbox: SandboxChip;
  pending: PendingRequest | null;
  quiet: boolean;
  teamMode: boolean;
  maxIterations: number;
  toolConcurrency: number;
  allowSkillInstall: boolean;
  keepReports: boolean;
  lastReportPath: string | null;
  warnings: string[];
  lastError: string | null;
}

export interface RunTaskInput {
  task: string;
  /** Override the session's team mode for this turn only. */
  team?: boolean;
}

export interface RunTaskOutcome {
  status: "completed" | "error" | "aborted";
  durationMs: number;
}

/**
 * Desktop-only events the session host adds around each turn. They are not
 * part of 9rh's `AgentEvent` union; the transcript uses them to render the
 * task text and to close a turn that ended without `done`/`error` (abort).
 */
export type DesktopEvent =
  | { type: "turn_start"; task: string; turnIndex: number; team: boolean }
  | { type: "turn_end"; turnIndex: number; status: RunTaskOutcome["status"]; durationMs: number };

export type SessionEvent = AgentEvent | DesktopEvent;

export interface SessionEventEnvelope {
  sessionId: string;
  /** Monotonic per session, starting at 1. */
  seq: number;
  ts: number;
  event: SessionEvent;
}

export interface RewindPlanView {
  targetTurnIndex: number;
  writes: string[];
  deletes: string[];
  skips: RewindSkip[];
}

export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  /** 1-based line number in the "before" text (context/remove). */
  oldLine?: number;
  /** 1-based line number in the "after" text (context/add). */
  newLine?: number;
}

export interface FileDiff {
  path: string;
  operation: "create" | "edit";
  added: number;
  removed: number;
  lines: DiffLine[];
  beforeTruncated?: boolean;
  afterTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// Backend detection (used by the new-session form and settings)
// ---------------------------------------------------------------------------

export interface BackendSummary {
  name: "router" | "direct" | "embedded";
  description: string;
  baseURL: string;
  hasNativeRouter: boolean;
  reachable: boolean;
  healthDetail?: string;
  warnings: string[];
  ambiguous: boolean;
}

// ---------------------------------------------------------------------------
// App state persisted in ~/.9rh/desktop.json
// ---------------------------------------------------------------------------

export interface AppState {
  recentWorkDirs: string[];
  lastModel?: string;
  lastBackend?: BackendChoice;
  window?: { width: number; height: number; x?: number; y?: number };
  /** Renderer preferences. */
  quietByDefault?: boolean;
  routerPollMs?: number;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayStartInput {
  path: string;
  /** Playback speed multiplier. Default 2. */
  speed?: number;
}

export interface ReplayEventEnvelope {
  replayId: string;
  seq: number;
  event: AgentEvent;
}

export interface ReplayStatus {
  replayId: string;
  path: string;
  state: "playing" | "done" | "aborted" | "error";
  rendered: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Router process control
// ---------------------------------------------------------------------------

export interface RouterProcessResult {
  reachable: boolean;
  /** True when this call started 9router (as opposed to finding it running). */
  started: boolean;
  baseURL: string;
  error?: string;
}

export interface RouterStatusBundle {
  health: RouterHealth;
  version: RouterVersion | null;
  auth: RouterAuthStatus | null;
  tunnel: RouterTunnelStatus | null;
}

// ---------------------------------------------------------------------------
// Router updates. 9router's own updater runs `npm i -g` into npm's global
// prefix and relaunches the cli.js path it was started from, so a machine
// with two prefixes (one on PATH, one npm's default) or a daemon that never
// restarted stays on the old version. The desktop updater targets the
// install PATH resolves, can force every install, and verifies the version
// the restarted daemon reports.
// ---------------------------------------------------------------------------

export interface RouterInstall {
  /** Package directory, e.g. /opt/homebrew/lib/node_modules/9router. */
  dir: string;
  /** package.json version on disk, null when unreadable. */
  version: string | null;
  /** npm prefix that owns this install (the `--prefix` to update it). */
  prefix: string;
  /** True when a `9router` bin on PATH resolves here; rank 0 is what runs. */
  onPath: boolean;
  pathRank: number | null;
  /** True when this is the install under `npm prefix -g`. */
  npmDefault: boolean;
}

export interface RouterUpdateInfo {
  /** Version the running daemon reports over /api/version. */
  runningVersion: string | null;
  runningPid: number | null;
  /** Package directory the daemon was started from, when a process is found. */
  runningDir: string | null;
  /** Latest published version (registry, else 9router's own check). */
  latestVersion: string | null;
  npmPrefix: string | null;
  installs: RouterInstall[];
  /** Plain-language findings about why an update may not have taken. */
  diagnosis: string[];
  canUpdate: boolean;
}

export interface RouterUpdateInput {
  /** Update every install, kill every 9router process, then start and verify. */
  force?: boolean;
}

export interface RouterUpdateProgress {
  phase: "inspect" | "install" | "stop" | "start" | "verify" | "done";
  line: string;
}

export interface RouterUpdateResult {
  ok: boolean;
  /** Version the daemon reported before the update. */
  before: string | null;
  /** Version the restarted daemon reports, null when it did not come back. */
  after: string | null;
  latest: string | null;
  updatedInstalls: string[];
  restarted: boolean;
  /** Tail of the npm and updater output. */
  log: string[];
  error?: string;
  diagnosis: string[];
}

// ---------------------------------------------------------------------------
// The bridge exposed on window.ninerh
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

export interface SessionsApi {
  create(input: SessionCreateInput): Promise<IpcResult<SessionSnapshot>>;
  list(): Promise<IpcResult<SessionSnapshot[]>>;
  get(id: string): Promise<IpcResult<SessionSnapshot>>;
  remove(id: string): Promise<IpcResult<void>>;
  /** Resolves when the turn finishes (done, error, or abort). */
  run(id: string, input: RunTaskInput): Promise<IpcResult<RunTaskOutcome>>;
  /** Graceful: finish the current tool call, then stop. */
  stop(id: string): Promise<IpcResult<void>>;
  /** Immediate: cancel the in-flight stream. */
  abort(id: string): Promise<IpcResult<void>>;
  answerAsk(id: string, requestId: string, answer: string): Promise<IpcResult<void>>;
  decideApproval(id: string, requestId: string, approved: boolean, reason?: string): Promise<IpcResult<void>>;
  setQuiet(id: string, quiet: boolean): Promise<IpcResult<void>>;
  setTeamMode(id: string, teamMode: boolean): Promise<IpcResult<void>>;
  setModel(id: string, model: string): Promise<IpcResult<void>>;
  setWorkDir(id: string, workDir: string): Promise<IpcResult<void>>;
  listModels(id: string, filter?: string): Promise<IpcResult<ModelInfo[]>>;
  /** Replays the retained event ring buffer (for renderer reloads). */
  history(id: string, sinceSeq?: number): Promise<IpcResult<SessionEventEnvelope[]>>;
  recentToolResults(id: string): Promise<IpcResult<StoredToolResult[]>>;
  suggestTeam(task: string): Promise<IpcResult<boolean>>;
  rewindPlan(id: string, targetTurnIndex: number): Promise<IpcResult<RewindPlanView>>;
  rewindApply(id: string, targetTurnIndex: number): Promise<IpcResult<RewindResult>>;
  diff(id: string, turnIndex: number, path: string): Promise<IpcResult<FileDiff>>;
  skills(id: string): Promise<IpcResult<SkillManifestEntry[]>>;
}

export interface RouterApi {
  status(): Promise<IpcResult<RouterStatusBundle>>;
  start(): Promise<IpcResult<RouterProcessResult>>;
  stop(): Promise<IpcResult<void>>;
  restart(): Promise<IpcResult<RouterProcessResult>>;
  settings(): Promise<IpcResult<RouterSettingsSummary>>;
  providers(): Promise<IpcResult<RouterProvider[]>>;
  testProvider(id: string): Promise<IpcResult<unknown>>;
  setProviderActive(id: string, isActive: boolean): Promise<IpcResult<void>>;
  deleteProvider(id: string): Promise<IpcResult<void>>;
  combos(): Promise<IpcResult<RouterCombo[]>>;
  createCombo(input: RouterComboInput): Promise<IpcResult<RouterCombo>>;
  updateCombo(id: string, input: RouterComboInput): Promise<IpcResult<RouterCombo>>;
  deleteCombo(id: string): Promise<IpcResult<void>>;
  keys(): Promise<IpcResult<RouterApiKey[]>>;
  createKey(name: string): Promise<IpcResult<RouterApiKey>>;
  deleteKey(id: string): Promise<IpcResult<void>>;
  models(): Promise<IpcResult<RouterModel[]>>;
  availability(): Promise<IpcResult<RouterModelAvailability[]>>;
  usageStats(): Promise<IpcResult<RouterUsageStats>>;
  usageChart(): Promise<IpcResult<RouterUsageChartPoint[]>>;
  usageLogs(limit?: number): Promise<IpcResult<string[]>>;
  /** Open the SSE usage stream; totals arrive on events.onRouterUsage. */
  usageStreamStart(): Promise<IpcResult<void>>;
  usageStreamStop(): Promise<IpcResult<void>>;
  /** Dashboard URL for the embedded webview. */
  dashboardUrl(): Promise<IpcResult<string>>;
  /** Installs, running version, latest version, and why an update may be stuck. */
  updateInfo(): Promise<IpcResult<RouterUpdateInfo>>;
  /** Update (and restart) 9router; progress lines arrive on events.onRouterUpdateProgress. */
  update(input: RouterUpdateInput): Promise<IpcResult<RouterUpdateResult>>;
}

export interface ReplaysApi {
  list(): Promise<IpcResult<RunLogInfo[]>>;
  start(input: ReplayStartInput): Promise<IpcResult<ReplayStatus>>;
  stop(replayId: string): Promise<IpcResult<void>>;
}

export interface BackendApi {
  detect(choice: BackendChoice): Promise<IpcResult<BackendSummary>>;
  presets(): Promise<IpcResult<ProviderPreset[]>>;
}

export interface ConfigApi {
  get(): Promise<IpcResult<UserConfig>>;
  set(patch: UserConfig): Promise<IpcResult<UserConfig>>;
  appState(): Promise<IpcResult<AppState>>;
  setAppState(patch: Partial<AppState>): Promise<IpcResult<AppState>>;
}

export interface ShellApi {
  pickDirectory(): Promise<IpcResult<string | null>>;
  openPath(path: string): Promise<IpcResult<void>>;
  openExternal(url: string): Promise<IpcResult<void>>;
  /** Read a run report HTML file for the in-app viewer. */
  readReport(path: string): Promise<IpcResult<string>>;
  platform(): Promise<IpcResult<{ platform: NodeJS.Platform; home: string; version: string }>>;
}

export interface EventsApi {
  onSessionEvent(cb: (e: SessionEventEnvelope) => void): Unsubscribe;
  onSessionChanged(cb: (s: SessionSnapshot) => void): Unsubscribe;
  onSessionRemoved(cb: (id: string) => void): Unsubscribe;
  onReplayEvent(cb: (e: ReplayEventEnvelope) => void): Unsubscribe;
  onReplayStatus(cb: (s: ReplayStatus) => void): Unsubscribe;
  onRouterUsage(cb: (stats: RouterUsageStats) => void): Unsubscribe;
  onRouterUpdateProgress(cb: (p: RouterUpdateProgress) => void): Unsubscribe;
}

export interface NinerhApi {
  sessions: SessionsApi;
  router: RouterApi;
  replays: ReplaysApi;
  backend: BackendApi;
  config: ConfigApi;
  shell: ShellApi;
  events: EventsApi;
}

declare global {
  interface Window {
    ninerh: NinerhApi;
  }
}

// ---------------------------------------------------------------------------
// Channel names. Invoke channels are "<group>:<method>"; push channels
// (main → renderer) are "<group>:on-<event>".
// ---------------------------------------------------------------------------

export const CH = {
  sessions: {
    create: "sessions:create",
    list: "sessions:list",
    get: "sessions:get",
    remove: "sessions:remove",
    run: "sessions:run",
    stop: "sessions:stop",
    abort: "sessions:abort",
    answerAsk: "sessions:answerAsk",
    decideApproval: "sessions:decideApproval",
    setQuiet: "sessions:setQuiet",
    setTeamMode: "sessions:setTeamMode",
    setModel: "sessions:setModel",
    setWorkDir: "sessions:setWorkDir",
    listModels: "sessions:listModels",
    history: "sessions:history",
    recentToolResults: "sessions:recentToolResults",
    suggestTeam: "sessions:suggestTeam",
    rewindPlan: "sessions:rewindPlan",
    rewindApply: "sessions:rewindApply",
    diff: "sessions:diff",
    skills: "sessions:skills",
  },
  router: {
    status: "router:status",
    start: "router:start",
    stop: "router:stop",
    restart: "router:restart",
    settings: "router:settings",
    providers: "router:providers",
    testProvider: "router:testProvider",
    setProviderActive: "router:setProviderActive",
    deleteProvider: "router:deleteProvider",
    combos: "router:combos",
    createCombo: "router:createCombo",
    updateCombo: "router:updateCombo",
    deleteCombo: "router:deleteCombo",
    keys: "router:keys",
    createKey: "router:createKey",
    deleteKey: "router:deleteKey",
    models: "router:models",
    availability: "router:availability",
    usageStats: "router:usageStats",
    usageChart: "router:usageChart",
    usageLogs: "router:usageLogs",
    usageStreamStart: "router:usageStreamStart",
    usageStreamStop: "router:usageStreamStop",
    dashboardUrl: "router:dashboardUrl",
    updateInfo: "router:updateInfo",
    update: "router:update",
  },
  replays: {
    list: "replays:list",
    start: "replays:start",
    stop: "replays:stop",
  },
  backend: {
    detect: "backend:detect",
    presets: "backend:presets",
  },
  config: {
    get: "config:get",
    set: "config:set",
    appState: "config:appState",
    setAppState: "config:setAppState",
  },
  shell: {
    pickDirectory: "shell:pickDirectory",
    openPath: "shell:openPath",
    openExternal: "shell:openExternal",
    readReport: "shell:readReport",
    platform: "shell:platform",
  },
  push: {
    sessionEvent: "sessions:on-event",
    sessionChanged: "sessions:on-changed",
    sessionRemoved: "sessions:on-removed",
    replayEvent: "replays:on-event",
    replayStatus: "replays:on-status",
    routerUsage: "router:on-usage",
    routerUpdateProgress: "router:on-update-progress",
  },
} as const;
