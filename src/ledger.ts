/**
 * Session Ledger — the harness-computed record of what actually happened.
 *
 * One append-only per-session structure that accumulates across agent turns:
 * goals, outcomes, files touched, commands run, and token usage. The TUI
 * dashboard, the done-digest ("receipts"), and the /brief and /usage slash
 * commands are all views over this single substrate.
 *
 * Everything here is derived from tool results and stream metadata the
 * harness observed directly — never from the model's own claims. That is
 * the design contract: receipts, not vibes.
 */

import chalk from "chalk";
import type {
  TokenUsage,
  RunStatus,
  FileChangeRecord,
  ToolCallRecord,
} from "./reports/runReportData.js";

// ---------------------------------------------------------------------------
// Turn digest — the per-turn receipt attached to done/error events.
// ---------------------------------------------------------------------------

export interface DigestFileEntry {
  /** Path relative to the workDir (absolute if it was outside it). */
  path: string;
  operation: "create" | "edit";
  added: number;
  removed: number;
}

export interface DigestCommandEntry {
  command: string;
  ok: boolean;
}

export interface TurnDigest {
  task: string;
  status: RunStatus;
  durationMs: number;
  steps: number;
  /** Summed across every streamed completion in the turn. */
  tokens?: TokenUsage;
  files: DigestFileEntry[];
  commands: DigestCommandEntry[];
  toolCounts: Record<string, number>;
  /** Defaults the harness picked when nobody answered an ask_user call —
   *  silent decisions made visible. */
  assumptions?: string[];
  reportPath?: string;
  /** Raw before/after records behind `files` — retained so /rewind can
   *  restore the workdir to the state before this turn. Not rendered. */
  fileChangeRecords?: FileChangeRecord[];
}

export interface TurnDigestInput {
  task: string;
  startedAt: number;
  workDir: string;
  fileChanges: FileChangeRecord[];
  toolCalls: ToolCallRecord[];
}

export interface TurnDigestOptions {
  status: RunStatus;
  steps: number;
  tokens?: TokenUsage;
  reportPath?: string;
  assumptions?: string[];
  /** Injectable clock for deterministic tests. */
  now?: number;
}

/**
 * Count added/removed lines between two file bodies via a line-level LCS.
 * `before === undefined` means the file did not exist (pure creation).
 *
 * Guarded: report fields are capped at ~32KB upstream, so the DP table is
 * small in practice. If a pathological pair still exceeds the cell budget we
 * fall back to the gross line-count delta rather than burning CPU.
 * ponytail: gross-delta fallback undercounts same-length rewrites; upgrade
 * to a real diff lib only if receipts accuracy complaints appear.
 */
export function countLineChanges(
  before: string | undefined,
  after: string,
): { added: number; removed: number } {
  const b = after.split("\n");
  if (before === undefined) return { added: b.length, removed: 0 };
  if (before === after) return { added: 0, removed: 0 };
  const a = before.split("\n");
  if (a.length * b.length > 4_000_000) {
    const delta = b.length - a.length;
    return { added: Math.max(delta, 0), removed: Math.max(-delta, 0) };
  }
  // Two-row DP for LCS length.
  const prev = new Uint32Array(b.length + 1);
  const curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    prev.set(curr);
  }
  const lcs = prev[b.length];
  return { added: b.length - lcs, removed: a.length - lcs };
}

/**
 * Merge raw per-step file-change records into one entry per path:
 * first-seen `before` vs last-seen `after`, so a file edited five times in
 * a turn shows one honest net +/- line count. Paths are made workDir-relative
 * for display.
 */
export function summarizeFileChanges(
  changes: FileChangeRecord[],
  workDir: string,
): DigestFileEntry[] {
  const merged = new Map<string, { first: FileChangeRecord; last: FileChangeRecord }>();
  for (const c of changes) {
    const existing = merged.get(c.path);
    if (!existing) merged.set(c.path, { first: c, last: c });
    else existing.last = c;
  }
  const prefix = workDir.endsWith("/") ? workDir : `${workDir}/`;
  return [...merged.entries()].map(([path, { first, last }]) => {
    const { added, removed } = countLineChanges(first.before, last.after);
    return {
      path: path.startsWith(prefix) ? path.slice(prefix.length) : path,
      operation: first.operation,
      added,
      removed,
    };
  });
}

export function summarizeCommands(toolCalls: ToolCallRecord[]): DigestCommandEntry[] {
  return toolCalls
    .filter((t) => t.name === "run_bash")
    .map((t) => ({
      command: typeof t.args.command === "string" ? t.args.command : "(unknown command)",
      ok: !t.error,
    }));
}

export function buildTurnDigest(
  input: TurnDigestInput,
  opts: TurnDigestOptions,
): TurnDigest {
  const toolCounts: Record<string, number> = {};
  for (const t of input.toolCalls) {
    toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
  }
  return {
    task: input.task,
    status: opts.status,
    durationMs: Math.max(0, (opts.now ?? Date.now()) - input.startedAt),
    steps: opts.steps,
    tokens: opts.tokens,
    files: summarizeFileChanges(input.fileChanges, input.workDir),
    commands: summarizeCommands(input.toolCalls),
    toolCounts,
    assumptions: opts.assumptions && opts.assumptions.length > 0 ? [...opts.assumptions] : undefined,
    reportPath: opts.reportPath,
    fileChangeRecords: input.fileChanges.length > 0 ? [...input.fileChanges] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Session ledger — cross-turn accumulation.
// ---------------------------------------------------------------------------

export interface LedgerTurn {
  index: number;
  task: string;
  startedAt: number;
  endedAt?: number;
  status?: RunStatus;
  /** Live-updated during the turn from `usage` events; final from the digest. */
  tokens?: TokenUsage;
  digest?: TurnDigest;
  /** Per-role token usage when this turn ran the multi-role pipeline.
   *  Keys are role names; repeated invocations (revision loops) accumulate. */
  roleTokens?: Record<string, TokenUsage>;
}

export interface LedgerView {
  sessionStartedAt: number;
  turnCount: number;
  completedTurnCount: number;
  /** Task text of the open turn, or of the last turn when idle. */
  goal: string | null;
  goalActive: boolean;
  /** One-line outcome of the most recent completed turn. */
  lastOutcome: string | null;
  /** Session token totals, including the open turn's live count. */
  tokens: TokenUsage;
  filesTouched: number;
  commandsRun: number;
  turns: LedgerTurn[];
}

/** Minimal shape of the agent events the ledger consumes — structurally
 *  compatible with `AgentEvent` without importing agent.ts (no cycle). */
export type LedgerAgentEvent =
  | { type: "usage"; lastCompletion: TokenUsage; turn: TokenUsage }
  | { type: "done"; text: string; reportPath?: string; digest?: TurnDigest }
  | { type: "error"; message: string; reportPath?: string; digest?: TurnDigest }
  | { type: "tool_result"; name: string; output: string; error?: string }
  | { type: "team"; event: { type: string; role?: string; usage?: TokenUsage } }
  | { type: string };

export interface StoredToolResult {
  turnIndex: number;
  name: string;
  output: string;
  error?: string;
  truncated: boolean;
}

/** Ring-buffer bounds for /last — enough to revisit the current turn's
 *  tool outputs without holding a whole session of them in memory. */
const MAX_STORED_TOOL_RESULTS = 20;
const MAX_STORED_TOOL_OUTPUT_CHARS = 100_000;

export class SessionLedger {
  readonly startedAt: number;
  private turns: LedgerTurn[] = [];
  private toolResults: StoredToolResult[] = [];

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  /** Open a new turn. Any still-open previous turn is closed as errored —
   *  that only happens when a run died before emitting done/error. */
  beginTurn(task: string, now = Date.now()): void {
    const open = this.openTurn();
    if (open) {
      open.endedAt = now;
      open.status = "error";
    }
    this.turns.push({ index: this.turns.length + 1, task, startedAt: now });
  }

  /** Fold a live agent event into the open turn. Safe to call with every
   *  event type — non-ledger events are ignored. */
  onAgentEvent(event: LedgerAgentEvent, now = Date.now()): void {
    const open = this.openTurn();
    if (event.type === "usage" && open) {
      const e = event as { turn: TokenUsage };
      open.tokens = { ...e.turn };
      return;
    }
    if (event.type === "tool_result") {
      const e = event as { name: string; output: string; error?: string };
      const truncated = e.output.length > MAX_STORED_TOOL_OUTPUT_CHARS;
      this.toolResults.push({
        turnIndex: open?.index ?? this.turns.length,
        name: e.name,
        output: truncated ? e.output.slice(0, MAX_STORED_TOOL_OUTPUT_CHARS) : e.output,
        error: e.error,
        truncated,
      });
      if (this.toolResults.length > MAX_STORED_TOOL_RESULTS) {
        this.toolResults = this.toolResults.slice(-MAX_STORED_TOOL_RESULTS);
      }
      return;
    }
    if (event.type === "team" && open) {
      // Team pipeline turns don't stream `usage` events — per-role token
      // counts arrive on role_complete. Accumulate them into both the
      // per-role breakdown (/usage) and the turn total.
      const e = event as { event: { type: string; role?: string; usage?: TokenUsage } };
      const inner = e.event;
      if (inner.type === "role_complete" && inner.role && inner.usage) {
        open.roleTokens ??= {};
        const r = (open.roleTokens[inner.role] ??= { prompt: 0, completion: 0, total: 0 });
        r.prompt += inner.usage.prompt;
        r.completion += inner.usage.completion;
        r.total += inner.usage.total;
        const t = (open.tokens ??= { prompt: 0, completion: 0, total: 0 });
        t.prompt += inner.usage.prompt;
        t.completion += inner.usage.completion;
        t.total += inner.usage.total;
      }
      return;
    }
    if (event.type === "done" || event.type === "error") {
      const e = event as { digest?: TurnDigest };
      this.completeTurn(e.digest, event.type === "done" ? "completed" : "error", now);
    }
  }

  /** Most-recent-first slice of stored tool results (for /last). */
  recentToolResults(): readonly StoredToolResult[] {
    return [...this.toolResults].reverse();
  }

  /** Close the open turn. First completion wins (an aborted run emits both
   *  error and done); later calls are ignored. */
  completeTurn(digest?: TurnDigest, fallbackStatus: RunStatus = "completed", now = Date.now()): void {
    const open = this.openTurn();
    if (!open) return;
    open.endedAt = now;
    open.status = digest?.status ?? fallbackStatus;
    open.digest = digest;
    if (digest?.tokens) open.tokens = digest.tokens;
  }

  private openTurn(): LedgerTurn | null {
    const last = this.turns[this.turns.length - 1];
    return last && last.endedAt === undefined ? last : null;
  }

  view(now = Date.now()): LedgerView {
    const open = this.openTurn();
    const completed = this.turns.filter((t) => t.endedAt !== undefined);
    const tokens: TokenUsage = { prompt: 0, completion: 0, total: 0 };
    const files = new Set<string>();
    let commandsRun = 0;
    for (const t of this.turns) {
      if (t.tokens) {
        tokens.prompt += t.tokens.prompt;
        tokens.completion += t.tokens.completion;
        tokens.total += t.tokens.total;
      }
      if (t.digest) {
        for (const f of t.digest.files) files.add(f.path);
        commandsRun += t.digest.commands.length;
      }
    }
    const lastCompleted = completed[completed.length - 1];
    const lastGoal = this.turns[this.turns.length - 1];
    return {
      sessionStartedAt: this.startedAt,
      turnCount: this.turns.length,
      completedTurnCount: completed.length,
      goal: open?.task ?? lastGoal?.task ?? null,
      goalActive: open !== null,
      lastOutcome: lastCompleted ? outcomeLine(lastCompleted) : null,
      tokens,
      filesTouched: files.size,
      commandsRun,
      turns: this.turns,
    };
  }
}

function outcomeLine(turn: LedgerTurn): string {
  const icon = turn.status === "completed" ? "✓" : "✗";
  const parts = [`${icon} ${cropText(turn.task, 40)}`];
  if (turn.digest && turn.digest.files.length > 0) {
    parts.push(`${turn.digest.files.length} file${turn.digest.files.length === 1 ? "" : "s"}`);
  }
  if (turn.tokens) parts.push(`${fmtTokens(turn.tokens.total)} tok`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Formatting helpers — shared by the TUI dashboard and slash commands.
// ---------------------------------------------------------------------------

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const secs = Math.floor(ms / 1000) % 60;
  const mins = Math.floor(ms / 60000) % 60;
  const hrs = Math.floor(ms / 3600000);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function cropText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, Math.max(0, max - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Renderers for /brief and /usage.
// ---------------------------------------------------------------------------

export function renderBrief(view: LedgerView, useColor: boolean): string {
  const dim = (s: string) => (useColor ? chalk.dim(s) : s);
  const lines: string[] = [""];
  lines.push(useColor ? chalk.bold.cyan("  session brief") : "  session brief");
  if (view.turnCount === 0) {
    lines.push("  (no turns yet — give the agent a task first)");
    lines.push("");
    return lines.join("\n");
  }
  const goalLabel = view.goalActive ? "goal (active)" : "goal (last)";
  lines.push(`  ${goalLabel.padEnd(14)} ${cropText(view.goal ?? "", 60)}`);
  lines.push(`  ${"turns".padEnd(14)} ${view.turnCount} (${view.completedTurnCount} completed)`);
  lines.push(
    `  ${"tokens".padEnd(14)} ${fmtTokens(view.tokens.prompt)} in / ${fmtTokens(view.tokens.completion)} out (${fmtTokens(view.tokens.total)} total)`,
  );
  lines.push(`  ${"files".padEnd(14)} ${view.filesTouched} touched`);
  lines.push(`  ${"commands".padEnd(14)} ${view.commandsRun} run`);
  lines.push("");
  for (const t of view.turns) {
    const icon = t.endedAt === undefined ? "…" : t.status === "completed" ? "✓" : "✗";
    const tok = t.tokens ? ` · ${fmtTokens(t.tokens.total)} tok` : "";
    const dur = t.endedAt !== undefined ? ` · ${fmtDurationMs(t.endedAt - t.startedAt)}` : "";
    const filesCount = t.digest?.files.length ?? 0;
    const filesPart = filesCount > 0 ? ` · ${filesCount} file${filesCount === 1 ? "" : "s"}` : "";
    lines.push(`  ${t.index}. ${icon} ${cropText(t.task, 48)}${dim(`${filesPart}${tok}${dur}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderUsage(view: LedgerView, useColor: boolean): string {
  const lines: string[] = [""];
  const title = `  token usage — session ${fmtTokens(view.tokens.total)} total (${fmtTokens(view.tokens.prompt)} in / ${fmtTokens(view.tokens.completion)} out)`;
  lines.push(useColor ? chalk.bold.cyan(title) : title);
  if (view.turnCount === 0) {
    lines.push("  (no turns yet)");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`  ${"#".padEnd(4)}${"in".padStart(9)}${"out".padStart(9)}${"total".padStart(9)}  task`);
  for (const t of view.turns) {
    const u = t.tokens ?? { prompt: 0, completion: 0, total: 0 };
    const row = `  ${String(t.index).padEnd(4)}${fmtTokens(u.prompt).padStart(9)}${fmtTokens(u.completion).padStart(9)}${fmtTokens(u.total).padStart(9)}  ${cropText(t.task, 40)}`;
    lines.push(useColor && t.endedAt === undefined ? chalk.cyan(row) : row);
    // Per-role breakdown when this turn ran the multi-role pipeline.
    if (t.roleTokens) {
      for (const [role, ru] of Object.entries(t.roleTokens)) {
        const roleRow = `      ${fmtTokens(ru.prompt).padStart(9)}${fmtTokens(ru.completion).padStart(9)}${fmtTokens(ru.total).padStart(9)}  └ ${role}`;
        lines.push(useColor ? chalk.dim(roleRow) : roleRow);
      }
    }
  }
  lines.push("");
  lines.push(useColor ? chalk.dim("  counts come from provider stream metadata (tokens only — no cost estimates)") : "  counts come from provider stream metadata (tokens only — no cost estimates)");
  lines.push("");
  return lines.join("\n");
}
