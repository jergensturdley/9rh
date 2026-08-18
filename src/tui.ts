import chalk from "chalk";
import { cursorTo, moveCursor, clearScreenDown } from "readline";
import type { AgentEvent } from "./agent.js";
import { fmtTokens, fmtDurationMs, type LedgerView, type TurnDigest } from "./ledger.js";
import {
  applyAgentEvent,
  createRunVisualization,
  inspectStep,
  exportRunVisualizationGraphviz,
  renderRunVisualization,
  renderRunMapCompact,
  type RunVisualization,
} from "./visualization.js";
import { colorizeFrame, generatePlasmaFrame, shouldShowSplash, SPLASH_ROWS } from "./splash.js";

const SPINNER_SETS = [
  ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  ["◜", "◠", "◝", "◞", "◡", "◟"],
  ["✶", "✸", "✹", "✺", "✹", "✷"],
  ["▖", "▘", "▝", "▗"],
  ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
];

const THINKING_LABELS = [
  "licking the type system…",
  "asking the AST if it feels held…",
  "warming a tiny cache goblin…",
  "checking if undefined misses us…",
  "staring into /dev/null until it blinks…",
  "rearranging stack frames by mouthfeel…",
  "triangulating vibes from stale closures…",
  "negotiating with a haunted monorepo…",
  "asking null to provide references…",
  "combing lint out of the event loop…",
  "massaging covariance until it squeaks…",
  "putting breakpoints in emotionally vulnerable places…",
  "waiting for entropy to pass code review…",
  "teaching recursion about boundaries…",
  "holding a semaphore's tiny hand…",
  "checking if the heap has a pulse…",
  "turning race conditions into jazz…",
  "seasoning the call stack with regret…",
  "asking the compiler for a second opinion…",
  "reading tea leaves in a stack trace…",
  "performing light dental work on generics…",
  "convincing pointers to point less aggressively…",
  "inventorying cursed edge cases…",
  "defragmenting the vibe buffer…",
  "whispering SOLID principles to spaghetti…",
  "asking Big-O to use its indoor voice…",
  "polishing a suspicious abstraction…",
  "extracting truth from boolean soup…",
  "checking if the regex is sentient…",
  "giving the scheduler a little snack…",
  "waiting for promises to develop object permanence…",
  "trying not to make eye contact with YAML…",
  "measuring technical debt in bone density…",
  "teaching the token stream table manners…",
  "sanding burrs off the control flow…",
  "consulting the sacred flamegraph…",
  "turning undefined into a teachable moment…",
  "folding stack traces into tiny cranes…",
  "counting how many footguns are loaded…",
  "asking the module graph who hurt it…",
  "preheating the inference oven…",
  "performing an exorcism on stale state…",
  "synthesizing a tasteful amount of dread…",
  "debugging by smell, responsibly…",
  "checking cache freshness with a tiny spoon…",
  "watering the syntax tree…",
  "letting the optimizer chew first…",
  "putting the bug in a little jar…",
  "asking the repl if it has dreams…",
  "aligning the dependency chakras…",
  "scraping barnacles off the abstraction layer…",
  "checking if the branch predictor is lying…",
  "making the happy path less smug…",
  "reading the room, then the heap dump…",
  "summoning a minimal reproduction homunculus…",
  "stapling invariants to the wall…",
  "building a tiny bridge over undefined behavior…",
  "installing handrails on the happy path…",
  "asking the bug to step into better lighting…",
  "knitting a stack trace into a little scarf…",
  "teaching the build graph object permanence…",
  "putting the race condition in time-out…",
  "checking whether the abstraction has a permit…",
  "building a tasteful shrine to deterministic output…",
  "convincing the cache that secrets are not snacks…",
  "polishing the yak before shaving it responsibly…",
  "measuring vibes with a calibrated rubber duck…",
  "building a small fence around spooky action at a distance…",
  "asking the linter to use its inside voice…",
  "turning vague dread into actionable diffs…",
  "feeding breadcrumbs to the control flow…",
  "checking if the monorepo needs a weighted blanket…",
  "assembling a bug trap from promises and string cheese…",
  "building context scaffolding out of exact filenames…",
  "letting the type checker sniff the evidence…",
  "pressing the flaky test until it squeaks…",
];

const TOOL_LABELS = [
  "letting {tool} touch the wires…",
  "supervising {tool} with a clipboard and dread…",
  "pressing {tool} against the glass…",
  "feeding {tool} one ethically sourced byte…",
  "waiting for {tool} to stop making eye contact…",
  "asking {tool} to be normal for once…",
  "allowing {tool} near production-adjacent thoughts…",
  "watching {tool} chew through bytes…",
  "standing behind {tool} with a fire blanket…",
  "letting {tool} improvise near sharp objects…",
  "asking {tool} to hold the regex by the safe end…",
  "giving {tool} a helmet and rootless dreams…",
  "waiting while {tool} befriends stderr…",
  "observing {tool} in its little sandbox terrarium…",
  "letting {tool} sniff the filesystem…",
  "asking {tool} what it did with the newline…",
  "monitoring {tool} for sudden opinions…",
  "letting {tool} commune with POSIX ghosts…",
  "waiting for {tool} to return from the basement…",
  "checking whether {tool} brought snacks or errors…",
  "keeping {tool} away from the good scissors…",
  "asking {tool} to explain the smell…",
  "letting {tool} poke the dependency bruise…",
  "watching {tool} make terminal soup…",
  "giving {tool} exactly one adult supervision…",
  "waiting for {tool} to finish its tiny ritual…",
  "asking {tool} not to fork emotionally…",
  "letting {tool} stare into cwd…",
  "counting {tool}'s little syscalls…",
  "waiting for {tool} to cough up stdout…",
  "handing {tool} a map and a liability waiver…",
  "letting {tool} disturb the sediment…",
  "asking {tool} to stop licking file descriptors…",
  "waiting for {tool} to become legally output…",
  "keeping a respectful distance from {tool}…",
  "letting {tool} rearrange the furniture…",
  "asking {tool} if the exit code is in the room…",
  "watching {tool} negotiate with pipes…",
  "letting {tool} wear the ceremonial timeout…",
  "checking {tool}'s pockets for stack traces…",
  "waiting for {tool} to finish being folklore…",
  "asking {tool} to serialize its feelings…",
  "letting {tool} parse the forbidden fruit…",
  "standing by while {tool} meets reality…",
  "giving {tool} a stern look and stdin…",
  "waiting for {tool} to stop inventing whitespace…",
  "letting {tool} breathe near the repo…",
  "asking {tool} to use gentle hands…",
  "monitoring {tool} for feral globbing…",
  "waiting as {tool} consults the inode oracle…",
  "letting {tool} tap the glass of causality…",
  "asking {tool} why it smells like fork bombs…",
  "supervising {tool}'s relationship with PATH…",
  "waiting for {tool} to produce artisanal side effects…",
  "allowing {tool} one controlled scream…",
  "watching {tool} metabolize arguments…",
  "asking {tool} to make stdout pretty but not proud…",
  "letting {tool} count things with suspicious confidence…",
  "asking {tool} to build a tiny ramp for the bytes…",
  "letting {tool} operate the repo forklift very slowly…",
  "checking whether {tool} filed its side effects correctly…",
  "watching {tool} perform filesystem cartography…",
  "asking {tool} to bring back facts, not folklore…",
  "giving {tool} a reflective vest and a timeout…",
  "letting {tool} rummage through the evidence drawer…",
  "asking {tool} to keep stdout on a short leash…",
  "waiting while {tool} translates chaos into exit codes…",
  "letting {tool} build a little report out of crumbs…",
];

const BACKGROUND_LABELS = [
  "listening for kernel noises…",
  "counting suspiciously warm semicolons…",
  "waiting politely in O(n) silence…",
  "checking the basement for orphaned processes…",
  "letting the circuit breaker cool its little hooves…",
  "sweeping crumbs out of the sandbox…",
  "waiting for the incident log to stop breathing…",
  "asking telemetry to blink twice…",
  "putting a tarp over transient failures…",
  "checking if the repair agent bit anyone…",
  "listening to sockets whisper about DNS…",
  "counting retries like ceiling tiles…",
  "waiting for backoff to emotionally mature…",
  "taking the context window's temperature…",
  "checking whether the token budget has teeth…",
  "folding logs into unsettling shapes…",
  "watching the watchdog watch back…",
  "measuring latency with a damp ruler…",
  "asking the health check to cough…",
  "waiting for eventual consistency to arrive late…",
  "turning flaky signals into soup…",
  "checking if the sandbox needs enrichment…",
  "dusting fingerprints off the trace ID…",
  "listening for a panic in the walls…",
  "waiting under the mutex like a goblin…",
  "asking the replay log to remember gently…",
  "counting ghosts in the process table…",
  "checking if the rate limit is asleep…",
  "waiting for the queue to digest…",
  "making sure the timeout has a chaperone…",
  "building suspense in a strictly bounded buffer…",
  "rotating the tiny moon of progress…",
  "dusting the live map for fingerprints…",
  "checking whether context loss left footprints…",
  "watering the continuation packet…",
  "counting progress sparks in the terminal rafters…",
  "keeping the transcript warm by the compiler fire…",
  "asking the sandbox hamster wheel for telemetry…",
  "building a small lighthouse for the next tool call…",
  "listening for suspiciously confident silence…",
];

function cols(): number {
  return process.stdout.columns ?? 80;
}

function rows(): number {
  return process.stdout.rows ?? 24;
}

function dashboardWidth(termWidth = cols()): number {
  return Math.max(36, Math.min(Math.floor(termWidth * 0.28), 48));
}

function boxWidth(): number {
  return Math.min(cols() - 4, 76);
}

function contentWidth(): number {
  if (!process.stdout.isTTY) return boxWidth();
  return computeGeometry(cols(), rows()).wrapWidth;
}

/**
 * Two-column TUI geometry — pure function (testable in isolation).
 *
 * Right column: dashboard panel of `dashWidth` cols starting at `dashCol`.
 * Left column: `leftColWidth` cols with a 1-col gutter before the dashboard.
 *   `leftInner` accounts for the 2-space indent already used by spinners,
 *   tool lines, and the done-summary block. `wrapWidth` is what
 *   wrapStreamChunk() sees.
 *
 * A non-positive terminal dimension (no TTY / piped output / unconfigured
 * CI) falls back to the 80×24 defaults so callers don't need to handle
 * the degenerate case at every site.
 */
export interface Geometry {
  termCols: number;
  termRows: number;
  dashWidth: number;
  dashCol: number;
  leftColWidth: number;
  leftInner: number;
  wrapWidth: number;
  /** False on narrow terminals — the side dashboard is dropped and the
   *  streamed body gets the full width (a condensed HUD rides the spinner
   *  line instead; below MIN_HUD_COLS even that is dropped). */
  showDashboard: boolean;
}

/** Below this width the side dashboard would squeeze the body column into
 *  unreadability (dashWidth bottoms out at 36, leaving < 40 cols of body). */
export const NARROW_DASHBOARD_MIN_COLS = 78;
/** Below this width even the condensed spinner-line HUD is dropped. */
export const MIN_HUD_COLS = 50;

export function computeGeometry(termCols: number, termRows: number): Geometry {
  if (!Number.isFinite(termCols) || termCols <= 0) termCols = 80;
  if (!Number.isFinite(termRows) || termRows <= 0) termRows = 24;
  if (termCols < NARROW_DASHBOARD_MIN_COLS) {
    const leftColWidth = termCols;
    const leftInner = Math.max(0, leftColWidth - 2);
    return {
      termCols,
      termRows,
      dashWidth: 0,
      dashCol: termCols + 1,
      leftColWidth,
      leftInner,
      wrapWidth: leftInner,
      showDashboard: false,
    };
  }
  const dashWidth = dashboardWidth(termCols);
  const dashCol = termCols - dashWidth + 1;
  const leftColWidth = termCols - dashWidth - 1;
  const leftInner = Math.max(0, leftColWidth - 2);
  const wrapWidth = leftInner;
  return { termCols, termRows, dashWidth, dashCol, leftColWidth, leftInner, wrapWidth, showDashboard: true };
}

export function drawBox(
  label: string,
  body: string,
  borderFn: (s: string) => string,
  useColor: boolean,
  width: number = boxWidth(),
): string {
  const w = width;
  const inner = w - 2;
  const labelFull = ` ${label} `;
  const dashCount = Math.max(0, inner - labelFull.length - 1);
  const top = borderFn(`╭─${labelFull}${"─".repeat(dashCount)}╮`);

  const bodyLines = body
    .split("\n")
    .slice(0, 24)
    .map((line) => {
      // Truncate so the visible text + "…" fill the inner content slot
      // exactly (inner - 2 for the side gutters), keeping a consistent
      // right margin across every body line.
      const slot = inner - 2;
      const safe = line.length > slot ? line.slice(0, slot - 1) + "…" : line;
      const pad = " ".repeat(Math.max(0, slot - safe.length));
      return (
        borderFn("│") +
        " " +
        (useColor ? chalk.dim(safe) : safe) +
        pad +
        " " +
        borderFn("│")
      );
    });

  const bottom = borderFn(`╰${"─".repeat(inner)}╯`);
  return [top, ...bodyLines, bottom].join("\n");
}

export interface TuiOptions {
  getModel: () => string;
  getWorkDir: () => string;
  getBaseURL?: () => string;
  getStartedByRouter?: () => boolean | undefined;
  useColor: boolean;
  /** Called when a run report is written to disk. Receives the absolute path. */
  onReportWritten?: (path: string) => void;
  /** Session-ledger snapshot for the dashboard's goal/session panels and
   *  the narrow-terminal condensed HUD. Optional — panels degrade to the
   *  per-run view when absent. */
  getLedger?: () => LedgerView;
  /** Quiet mode (/quiet): suppress live thinking snapshots in the
   *  transcript. The dashboard's thinking panel, tool lines, receipts,
   *  and the final summary are unaffected. */
  getQuiet?: () => boolean;
}

function crop(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Pad a list of dashboard lines to `target` rows by appending blank
 * `│…│` rows sized to `innerWidth` content. If the input already exceeds
 * `target`, the input is returned unchanged (truncation is the caller's
 * responsibility — see drawDashboard).
 */
export function padDashboardToHeight(
  lines: string[],
  target: number,
  innerWidth: number,
): string[] {
  if (target <= 0) return lines;
  if (lines.length >= target) return lines;
  // Clamp at minimum 1 inner space so a 0-width slot still emits `│ │`,
  // preserving the panel visual contract.
  const fill = " ".repeat(Math.max(1, innerWidth));
  const blank = `│${fill}│`;
  const padRows: string[] = [];
  for (let i = 0; i < target - lines.length; i++) padRows.push(blank);
  return [...lines, ...padRows];
}

/**
 * Wrap each `\n`-delimited line of `text` to `width` chars independently,
 * preserving newlines (distinct from `wrapText`, which collapses paragraphs).
 * Returns each line wrapped via greedy word-wrap with hard-break for
 * overlong tokens. Empty / whitespace-only lines emit "" so row count
 * is preserved.
 *
 * ANSI in input: defer to caller. Wrap is per-character; an escape that
 * spans a wrap boundary will be split. Callers should strip ANSI before
 * passing (e.g. via `visibleLength` aware re-flow) if the source can
 * contain styled text.
 */
export function wrapStreamChunk(text: string, width: number): string {
  if (width <= 0) return text;
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim().length === 0) {
      out.push("");
      continue;
    }
    const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
    let buf = "";
    for (const w of words) {
      if (buf.length === 0) {
        buf = w;
      } else if (buf.length + 1 + w.length <= width) {
        buf = `${buf} ${w}`;
      } else {
        out.push(buf);
        buf = w;
      }
    }
    // Hard-break any remaining oversize token
    while (buf.length > width) {
      out.push(buf.slice(0, width));
      buf = buf.slice(width);
    }
    if (buf.length > 0) out.push(buf);
  }
  return out.join("\n");
}

/**
 * Clamp a focused index to `[0, count-1]`. Wraps on overflow: going past
 * the bottom wraps to the top, and past the top wraps to the bottom.
 * `delta` is in "rows" (typically ±1 from arrow keys, ±N from PgUp/PgDn).
 * Returns the unchanged index for empty/degenerate lists so callers can
 * render an empty state without a stray focus.
 */
export function clampMenuFocus(index: number, delta: number, count: number): number {
  if (count <= 0) return index;
  if (count === 1) return 0;
  // +count before modulo to keep the result non-negative in JS.
  return (((index + delta) % count) + count) % count;
}

/**
 * Scroll-window math for a focused menu list. Given the focused index, the
 * total item count, and the number of visible rows, returns the slice
 * `[start, end)` of items the viewport should show. Keeps the focused item
 * in view, preferring to keep the cursor centered when there's slack.
 *
 * Returns `{ start: 0, end: 0 }` for empty/degenerate inputs.
 */
export function menuWindow(
  focused: number,
  count: number,
  visibleRows: number,
): { start: number; end: number } {
  if (count <= 0 || visibleRows <= 0) return { start: 0, end: 0 };
  const f = Math.max(0, Math.min(count - 1, focused));
  const rows = Math.min(visibleRows, count);
  // Keep the focused row in view; center it when there's slack above/below.
  const half = Math.floor(rows / 2);
  let start = f - half;
  if (start < 0) start = 0;
  if (start + rows > count) start = count - rows;
  start = Math.max(0, start);
  return { start, end: start + rows };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface TranscriptEntry {
  kind: "agent" | "tool" | "result" | "system" | "error";
  text: string;
}

export function renderRecentTranscript(entries: TranscriptEntry[], maxLines = 8): string {
  if (entries.length === 0) return "No agent messages yet.";
  const prefixes: Record<TranscriptEntry["kind"], string> = {
    agent: "agent",
    tool: "tool",
    result: "result",
    system: "system",
    error: "error",
  };
  return entries
    .slice(-maxLines)
    .map((entry) => `${prefixes[entry.kind]}: ${normalizeWhitespace(entry.text) || "(empty)"}`)
    .join("\n");
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) * 0.6);
  const tail = Math.floor((max - 1) * 0.4);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function describeToolIntent(tool: string, args: Record<string, unknown>): string {
  const target =
    typeof args.path === "string" ? args.path :
    typeof args.file_path === "string" ? args.file_path :
    typeof args.command === "string" ? args.command :
    typeof args.query === "string" ? args.query :
    typeof args.url === "string" ? args.url :
    undefined;
  const targetHint = target ? ` (${truncateMiddle(normalizeWhitespace(target), 42)})` : "";

  if (/^(read|agentgrep|grep|glob|ls|find|search|websearch|webfetch)/i.test(tool)) return `gather evidence with ${tool}${targetHint}`;
  if (/^(write|edit|multiedit|apply_patch|patch)/i.test(tool)) return `change workspace state with ${tool}${targetHint}`;
  if (/^(bash|test|npm|node)/i.test(tool)) return `execute or validate with ${tool}${targetHint}`;
  if (/^(browser|mcp__playwright)/i.test(tool)) return `inspect or operate a browser surface with ${tool}${targetHint}`;
  return `invoke ${tool}${targetHint}`;
}

export function summarizeLiveModelInsight(
  recentThinking: string[],
  toolName: string,
  args: Record<string, unknown>,
): string {
  const text = normalizeWhitespace(recentThinking.join(" "));
  const excerpt = text ? crop(text, 180) : "waiting for explicit reasoning text from the model";
  const approxTokens = text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
  return [
    `intent: ${describeToolIntent(toolName, args)}`,
    `reasoning: ${excerpt}`,
    `signal: ${approxTokens} approx reasoning tokens since last action`,
  ].join("\n");
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function formatSessionClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRepositionSplashFrame(startMs: number, nowMs: number, timeoutMs: number): boolean {
  return nowMs - startMs < timeoutMs;
}

export function splashFrameDelayMs(): number {
  return 45;
}

export function splashAnimationFrameCount(): number {
  return 14;
}

export function splashCollapseFrameCount(): number {
  return 5;
}

function writeSplashFrame(text: string): void {
  process.stdout.write(text + "\n");
}

function rewindSplashFrame(): void {
  process.stdout.write(`\x1b[${SPLASH_ROWS}A`);
}

function clearSplashFrame(): void {
  for (let row = 0; row < SPLASH_ROWS; row++) {
    process.stdout.write("\r\x1b[2K");
    if (row < SPLASH_ROWS - 1) process.stdout.write("\x1b[1B");
  }
  rewindSplashFrame();
}

function collapseFrame(frame: string[], step: number, total: number): string[] {
  const center = Math.floor(SPLASH_ROWS / 2);
  const keepRadius = Math.max(0, Math.ceil(((total - step - 1) / total) * center));
  return frame.map((line, row) => {
    const distance = Math.abs(row - center);
    if (distance > keepRadius) return " ".repeat(line.length);
    if (step === total - 1) {
      const mark = "  9RH ▸";
      return mark.padStart(Math.floor((line.length + mark.length) / 2)).padEnd(line.length);
    }
    return line;
  });
}

export async function printSplash(useColor: boolean): Promise<void> {
  const isTTY = Boolean(process.stdout.isTTY);
  const columns = process.stdout.columns ?? 80;
  if (!shouldShowSplash({ useColor, isTTY, columns })) return;

  const frameMs = splashFrameDelayMs();
  const restoreCursor = (): void => {
    process.stdout.write("\x1b[?25h");
  };
  // SIGINT during the splash should skip the animation, not kill the
  // process — the user is interrupting the greeting, not the upcoming
  // agent run. We jump to the end frame and let the normal cleanup run.
  let interrupted = false;
  const sigintHandler = (): void => {
    interrupted = true;
  };

  process.on("SIGINT", sigintHandler);
  const frameCount = splashAnimationFrameCount();
  const collapseCount = splashCollapseFrameCount();
  let frameIndex = 0;
  process.stdout.write("\x1b[?25l");
  try {
    for (; frameIndex < frameCount; frameIndex++) {
      if (interrupted) break;
      const frame = generatePlasmaFrame(frameIndex);
      writeSplashFrame(colorizeFrame(frame, { useColor }));
      await sleep(frameMs);
      rewindSplashFrame();
    }

    if (!interrupted) {
      const finalFrame = generatePlasmaFrame(frameIndex);
      for (let step = 0; step < collapseCount; step++) {
        const frame = collapseFrame(finalFrame, step, collapseCount);
        writeSplashFrame(colorizeFrame(frame, { useColor }));
        await sleep(frameMs);
        rewindSplashFrame();
      }
    }

    clearSplashFrame();
  } finally {
    restoreCursor();
    process.removeListener("SIGINT", sigintHandler);
  }
}
export interface ToolHistoryEntry {
  status: "running" | "success" | "error";
  name: string;
  target: string;
}

/** One lane per orchestrator role in the dashboard's TEAM panel. */
export interface TeamLane {
  role: string;
  status: "active" | "done" | "skipped" | "cache";
  startedAt?: number;
  endedAt?: number;
  /** Total tokens across this role's invocations (revision loops add up). */
  tokens?: number;
}

/** Minimal shape of the orchestrator events the lanes consume. */
export type TeamLaneEvent = {
  type: string;
  role?: string;
  usage?: { total: number };
};

/**
 * Fold one orchestrator event into the lane list (first-seen role order).
 * Pure-ish (mutates `lanes` in place); exported for tests.
 */
export function applyTeamEvent(lanes: TeamLane[], event: TeamLaneEvent, now = Date.now()): void {
  if (!event.role) return;
  let lane = lanes.find((l) => l.role === event.role);
  if (!lane) {
    lane = { role: event.role, status: "active" };
    lanes.push(lane);
  }
  switch (event.type) {
    case "role_start":
      lane.status = "active";
      lane.startedAt ??= now;
      lane.endedAt = undefined;
      break;
    case "role_complete": {
      lane.status = "done";
      lane.endedAt = now;
      if (event.usage) lane.tokens = (lane.tokens ?? 0) + event.usage.total;
      break;
    }
    case "role_skip":
      lane.status = "skipped";
      break;
    case "cache_hit":
      lane.status = "cache";
      break;
  }
}

const TEAM_LANE_ICON: Record<TeamLane["status"], string> = {
  active: "⚙",
  done: "✓",
  skipped: "⊘",
  cache: "↻",
};

/** Render the TEAM panel lanes (no box borders — caller wraps). */
export function renderTeamLanes(lanes: TeamLane[], now = Date.now()): string[] {
  return lanes.map((lane) => {
    const parts = [`${TEAM_LANE_ICON[lane.status]} ${lane.role}`];
    if (lane.status === "active" && lane.startedAt !== undefined) {
      parts.push(fmtDurationMs(now - lane.startedAt));
    } else if (lane.status === "done" && lane.startedAt !== undefined && lane.endedAt !== undefined) {
      parts.push(fmtDurationMs(lane.endedAt - lane.startedAt));
    }
    if (lane.tokens) parts.push(`${fmtTokens(lane.tokens)} tok`);
    return parts.join(" · ");
  });
}

export interface DashboardState {
  startedAt: Date;
  iterCurrent: number;
  iterMax: number;
  activity: "idle" | "thinking" | "tool" | "done" | "error";
  thinkingCharCount: number;
  thinkingPreview: string;
  currentTool: string | null;
  currentToolTarget: string | null;
  toolHistory: ToolHistoryEntry[];
  // Session-ledger panels (optional — populated from TuiOptions.getLedger).
  goal?: string | null;
  goalActive?: boolean;
  sessionTurns?: number;
  sessionTokens?: { prompt: number; completion: number; total: number } | null;
  sessionFiles?: number;
  lastOutcome?: string | null;
  /** TEAM panel — populated while a multi-role pipeline is running. */
  teamLanes?: TeamLane[];
}

export function formatElapsed(start: Date): string {
  const ms = Date.now() - start.getTime();
  const secs = Math.floor(ms / 1000) % 60;
  const mins = Math.floor(ms / 60000) % 60;
  const hrs = Math.floor(ms / 3600000);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function toolTarget(args: Record<string, unknown>): string {
  const raw =
    typeof args.path === "string" ? args.path :
    typeof args.file_path === "string" ? args.file_path :
    typeof args.command === "string" ? args.command :
    typeof args.query === "string" ? args.query :
    typeof args.url === "string" ? args.url : "";
  return crop(normalizeWhitespace(raw), 30);
}

export function renderDashboardLines(state: DashboardState, useColor: boolean, w: number, runMap: RunVisualization): string[] {
  const inner = w - 4;
  if (inner < 10) return [];
  const lines: string[] = [];

  const model = crop("9rh", inner - 5);
  const headerText = ` 9rh · ${model} `;
  const dashFill = Math.max(1, w - 2 - headerText.length);
  lines.push(`╭${headerText}${"─".repeat(dashFill)}╮`);

  const elapsed = formatElapsed(state.startedAt);
  const iterStr = state.iterMax > 0 ? `iter ${state.iterCurrent}/${state.iterMax}` : "iter —";
  lines.push(`│ ` + `⏱ ${elapsed}    ${iterStr}`.padEnd(inner) + ` │`);

  // Session panels — goal / totals / last outcome, fed by the session
  // ledger. Rendered only when a ledger is wired so per-run consumers
  // (tests, programmatic use) keep the historical layout.
  if (state.goal) {
    const goalIcon = state.goalActive ? "◎" : "○";
    lines.push(`│ ${crop(`${goalIcon} ${normalizeWhitespace(state.goal)}`, inner).padEnd(inner)} │`);
  }
  if (state.sessionTokens || (state.sessionTurns ?? 0) > 0) {
    const tok = state.sessionTokens
      ? `${fmtTokens(state.sessionTokens.prompt)}↑ ${fmtTokens(state.sessionTokens.completion)}↓`
      : "0 tok";
    const sess = `Σ turn ${state.sessionTurns ?? 0} · ${tok} · ${state.sessionFiles ?? 0} files`;
    lines.push(`│ ${crop(sess, inner).padEnd(inner)} │`);
  }
  if (state.lastOutcome) {
    lines.push(`│ ${crop(`↩ ${state.lastOutcome}`, inner).padEnd(inner)} │`);
  }

  // TEAM panel — one lane per orchestrator role while a pipeline runs.
  if (state.teamLanes && state.teamLanes.length > 0) {
    lines.push(`│ ${"▸ team".padEnd(inner)} │`);
    for (const laneLine of renderTeamLanes(state.teamLanes)) {
      lines.push(`│ ${crop(laneLine, inner).padEnd(inner)} │`);
    }
  }

  lines.push(`│${" ".repeat(inner + 2)}│`);

  if (state.activity === "thinking") {
    const countStr = `${state.thinkingCharCount} chars`;
    const actLine = `⚡ thinking · ${countStr}`;
    lines.push(`│ ${actLine.padEnd(inner)} │`);
    if (state.thinkingPreview) {
      const preview = normalizeWhitespace(state.thinkingPreview);
      const snippet = preview.length > inner - 4 ? `…${preview.slice(-(inner - 5))}` : preview;
      lines.push(`│ ` + `…${snippet}`.padEnd(inner) + ` │`);
    } else {
      lines.push(`│${" ".repeat(inner + 2)}│`);
    }
  } else if (state.activity === "tool" && state.currentTool) {
    const toolLine = `⚙ ${state.currentTool}${state.currentToolTarget ? ` · ${crop(state.currentToolTarget, inner - 8)}` : ""}`;
    lines.push(`│ ${toolLine.padEnd(inner)} │`);
    lines.push(`│${" ".repeat(inner + 2)}│`);
  } else if (state.activity === "done") {
    lines.push(`│ ${"✓ done".padEnd(inner)} │`);
    lines.push(`│${" ".repeat(inner + 2)}│`);
  } else if (state.activity === "error") {
    lines.push(`│ ${"⚠ error".padEnd(inner)} │`);
    lines.push(`│${" ".repeat(inner + 2)}│`);
  } else {
    lines.push(`│ ${"idle".padEnd(inner)} │`);
    lines.push(`│${" ".repeat(inner + 2)}│`);
  }

  lines.push(`│${" ".repeat(inner + 2)}│`);

  const history = state.toolHistory.slice(-5);
  for (const entry of history) {
    const icon = entry.status === "running" ? "⚙" : entry.status === "error" ? "⚠" : "✓";
    const text = `${icon} ${entry.name}${entry.target ? ` · ${entry.target}` : ""}`;
    lines.push(`│ ${crop(text, inner).padEnd(inner)} │`);
  }
  const padCount = Math.max(0, 5 - history.length);
  for (let i = 0; i < padCount; i++) {
    lines.push(`│${" ".repeat(inner + 2)}│`);
  }

  lines.push(`│${" ".repeat(inner + 2)}│`);

  lines.push(`│ ${"▸ timeline".padEnd(inner)} │`);

  const mapLines = renderRunMapCompact(runMap, inner);
  const showing = mapLines.slice(-6);
  for (const ml of showing) {
    lines.push(`│ ${crop(ml, inner).padEnd(inner)} │`);
  }
  const mapPad = Math.max(0, 6 - showing.length);
  for (let i = 0; i < mapPad; i++) {
    lines.push(`│${" ".repeat(inner + 2)}│`);
  }

  lines.push(`│${" ".repeat(inner + 2)}│`);

  const sandStr = runMap.sandboxHealth
    ? `${runMap.sandboxHealth.sandboxed}/${runMap.sandboxHealth.direct}/${runMap.sandboxHealth.timedOut}`
    : "—";
  const checkStr = runMap.lastGoodCheckpointId ? crop(runMap.lastGoodCheckpointId, Math.max(1, inner - 22)) : "none";
  const footer = `sandbox ${sandStr}  check ${checkStr}`;
  lines.push(`│ ${footer.padEnd(inner)} │`);

  lines.push(`╰${"─".repeat(inner + 2)}╯`);

  if (useColor) {
    return lines.map((line, idx) => {
      if (idx === 0 || idx === lines.length - 1) return chalk.blue(line);
      return line;
    });
  }
  return lines;
}

const DIGEST_STATUS_ICON: Record<TurnDigest["status"], string> = {
  completed: "✓",
  aborted: "⏹",
  error: "✗",
  max_iterations: "⚠",
};

const DIGEST_STATUS_WORD: Record<TurnDigest["status"], string> = {
  completed: "done",
  aborted: "aborted",
  error: "error",
  max_iterations: "max iterations",
};

const DIGEST_MAX_FILES = 8;
const DIGEST_MAX_COMMANDS = 6;
const DIGEST_MAX_ASSUMPTIONS = 4;

/**
 * Receipts — plain (uncolored, unboxed) lines for the end-of-turn digest.
 * Everything here is harness-computed fact: files with net +/- line counts,
 * commands with pass/fail, steps, duration, tokens. The model's prose is
 * rendered separately, below.
 *
 * Pure + exported so tests can assert the exact rendering.
 */
export function renderDigestLines(digest: TurnDigest, width: number): string[] {
  const lines: string[] = [];
  const headline: string[] = [
    `${DIGEST_STATUS_ICON[digest.status]} ${DIGEST_STATUS_WORD[digest.status]}`,
    fmtDurationMs(digest.durationMs),
    `${digest.steps} step${digest.steps === 1 ? "" : "s"}`,
  ];
  if (digest.tokens) {
    headline.push(`${fmtTokens(digest.tokens.prompt)}↑ ${fmtTokens(digest.tokens.completion)}↓ tok`);
  }
  lines.push(crop(headline.join(" · "), width));

  const label = (name: string) => name.padEnd(7);
  const cont = " ".repeat(7);
  lines.push(crop(`${label("goal")}${normalizeWhitespace(digest.task)}`, width));

  if (digest.files.length === 0) {
    lines.push(`${label("files")}(none)`);
  } else {
    digest.files.slice(0, DIGEST_MAX_FILES).forEach((f, i) => {
      const delta = f.operation === "create" ? `new +${f.added}` : `+${f.added} −${f.removed}`;
      lines.push(crop(`${i === 0 ? label("files") : cont}${f.path}  ${delta}`, width));
    });
    if (digest.files.length > DIGEST_MAX_FILES) {
      lines.push(`${cont}(…${digest.files.length - DIGEST_MAX_FILES} more files)`);
    }
  }

  if (digest.commands.length > 0) {
    digest.commands.slice(0, DIGEST_MAX_COMMANDS).forEach((c, i) => {
      const icon = c.ok ? "✓" : "✗";
      lines.push(crop(`${i === 0 ? label("ran") : cont}${icon} ${normalizeWhitespace(c.command)}`, width));
    });
    if (digest.commands.length > DIGEST_MAX_COMMANDS) {
      lines.push(`${cont}(…${digest.commands.length - DIGEST_MAX_COMMANDS} more commands)`);
    }
  }

  // Assumptions — defaults the harness picked when nobody answered an
  // ask_user call. These must never be silent.
  const assumptions = digest.assumptions ?? [];
  if (assumptions.length > 0) {
    assumptions.slice(0, DIGEST_MAX_ASSUMPTIONS).forEach((a, i) => {
      lines.push(crop(`${i === 0 ? label("assume") : cont}⚠ ${normalizeWhitespace(a)}`, width));
    });
    if (assumptions.length > DIGEST_MAX_ASSUMPTIONS) {
      lines.push(`${cont}(…${assumptions.length - DIGEST_MAX_ASSUMPTIONS} more assumptions)`);
    }
  }

  return lines;
}

/**
 * Markdown-lite styling for the final summary: headers bold, fenced code
 * blocks dim. No reflowing, no inline parsing — just enough visual
 * hierarchy that a structured answer doesn't read as one gray slab.
 * Pure + exported for tests; returns input unchanged when useColor=false.
 */
export function markdownLite(lines: string[], useColor: boolean): string[] {
  if (!useColor) return lines;
  let inFence = false;
  return lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return chalk.dim(line);
    }
    if (inFence) return chalk.dim(line);
    if (/^#{1,6}\s/.test(trimmed)) return chalk.bold(line);
    return line;
  });
}


export interface PickItem {
  id: string;
  label: string;
  /** Dim suffix, e.g. an owner tag or argument hint. */
  hint?: string;
  /** Marks the currently-active choice with ▶ (e.g. the current model). */
  active?: boolean;
}

export interface PickFromListOptions {
  title: string;
  help?: string;
  useColor: boolean;
  /** Id to focus initially (falls back to the active item, then the top). */
  initialId?: string;
  /** Signals raw-mode ownership so a surrounding REPL can mute its own
   *  keypress handling while the picker is up. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Generic arrow-key picker on stderr. This is the machinery behind the
 * model picker, generalized so ask_user and future sub-pickers (/rewind,
 * /team) share one implementation: ↑/↓ move, PgUp/PgDn jump, mouse wheel
 * scrolls, Enter selects, Esc cancels (returns null).
 */
export async function pickFromList(
  items: PickItem[],
  opts: PickFromListOptions,
): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || items.length === 0) return null;

  const visibleRows = Math.max(6, Math.min(14, (process.stderr.rows ?? 24) - 8));
  const startId = opts.initialId ?? items.find((i) => i.active)?.id;
  let selected = Math.max(0, items.findIndex((i) => i.id === startId));
  if (selected < 0) selected = 0;
  let top = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), Math.max(0, items.length - visibleRows)));
  let renderedLines = 0;
  let done = false;
  let result: string | null = null;
  const input = process.stdin;

  function clampSelection(): void {
    selected = Math.max(0, Math.min(items.length - 1, selected));
    if (selected < top) top = selected;
    if (selected >= top + visibleRows) top = selected - visibleRows + 1;
    top = Math.max(0, Math.min(top, Math.max(0, items.length - visibleRows)));
  }

  function clearRender(): void {
    if (renderedLines === 0) return;
    moveCursor(process.stderr, 0, -renderedLines);
    cursorTo(process.stderr, 0);
    clearScreenDown(process.stderr);
    renderedLines = 0;
  }

  function fitLine(text: string): string {
    const width = Math.max(40, (process.stderr.columns ?? 80) - 2);
    return text.length > width ? text.slice(0, width - 1) + "…" : text;
  }

  function render(): void {
    clearRender();
    const shown = items.slice(top, top + visibleRows);
    const help = opts.help ?? "↑/↓ scroll  PgUp/PgDn jump  wheel scroll  Enter select  Esc cancel";
    const lines: string[] = [
      "",
      opts.useColor ? chalk.bold.cyan(`  ${opts.title}`) : `  ${opts.title}`,
      opts.useColor ? chalk.dim(`  ${help}`) : `  ${help}`,
      "",
    ];
    for (let i = 0; i < shown.length; i++) {
      const index = top + i;
      const item = shown[i];
      const focused = index === selected;
      const marker = focused ? "›" : item.active ? "▶" : " ";
      const hint = item.hint ? `  ${item.hint}` : "";
      let row = `  ${marker} ${item.label}${hint}`;
      if (opts.useColor) row = focused ? chalk.inverse(row) : item.active ? chalk.cyan(row) : row;
      lines.push(fitLine(row));
    }
    const hiddenBefore = top;
    const hiddenAfter = Math.max(0, items.length - top - shown.length);
    if (hiddenBefore || hiddenAfter) {
      lines.push(opts.useColor ? chalk.dim(`  ${hiddenBefore} above, ${hiddenAfter} below`) : `  ${hiddenBefore} above, ${hiddenAfter} below`);
    }
    process.stderr.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  }

  function move(delta: number): void {
    selected += delta;
    clampSelection();
    render();
  }

  function finish(value: string | null): void {
    done = true;
    result = value;
    clearRender();
  }

  return await new Promise<string | null>((resolve) => {
    const wasRaw = input.isRaw;
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (s === "\u0003") {
        finish(null);
        process.emit("SIGINT");
      } else if (s === "\r" || s === "\n") {
        finish(items[selected]?.id ?? null);
      } else if (s === "\u001b" || s === "\u001b[27~") {
        finish(null);
      } else if (s === "\u001b[A") {
        move(-1);
      } else if (s === "\u001b[B") {
        move(1);
      } else if (s === "\u001b[5~") {
        move(-visibleRows);
      } else if (s === "\u001b[6~") {
        move(visibleRows);
      } else if (/\u001b\[<64;\d+;\d+[mM]/u.test(s)) {
        move(-3);
      } else if (/\u001b\[<65;\d+;\d+[mM]/u.test(s)) {
        move(3);
      }

      if (done) {
        process.stderr.write("\x1b[?1000l\x1b[?1006l");
        input.off("data", onData);
        input.setRawMode(wasRaw ?? false);
        opts.onActiveChange?.(false);
        resolve(result);
      }
    };

    opts.onActiveChange?.(true);
    input.setRawMode(true);
    input.resume();
    process.stderr.write("\x1b[?1000h\x1b[?1006h");
    input.on("data", onData);
    render();
  });
}

/**
 * Minimal raw-mode line reader on stderr — used for ask_user free-text
 * answers while the main readline interface is parked behind a running
 * agent. Enter submits, Esc/Ctrl+C cancels (null), backspace edits.
 */
export async function readLineRaw(prompt: string, useColor: boolean): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const input = process.stdin;
  process.stderr.write(useColor ? chalk.cyan(`  ${prompt} `) : `  ${prompt} `);
  return await new Promise<string | null>((resolve) => {
    const wasRaw = input.isRaw;
    let buffer = "";
    const finish = (value: string | null): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw ?? false);
      process.stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (s === "\u0003" || s === "\u001b") {
        finish(null);
        if (s === "\u0003") process.emit("SIGINT");
      } else if (s === "\r" || s === "\n") {
        finish(buffer);
      } else if (s === "\u007f" || s === "\b") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stderr.write("\b \b");
        }
      } else if (s >= " " || s === "\t") {
        buffer += s;
        process.stderr.write(s);
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export function createTuiRenderer(opts: TuiOptions): (event: AgentEvent) => void {
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let thinkingSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerFrame = 0;
  let spinnerLabelIndex = 0;
  let activeSpinnerFrames = SPINNER_SETS[0];
  let spinnerActive = false;
  let thinkingActive = false;
  let recentThinking: string[] = [];
  let activeThinking = "";
  let iterCurrent = 0;
  let iterMax = 0;
  let lastThinkingSnapshot = 0;
  const sessionStartedAt = new Date();
  const visualization = createRunVisualization();
  const argsStringCache = new WeakMap<Record<string, unknown>, string>();
  const dashboard: DashboardState = {
    startedAt: sessionStartedAt,
    iterCurrent: 0,
    iterMax: 0,
    activity: "idle",
    thinkingCharCount: 0,
    thinkingPreview: "",
    currentTool: null,
    currentToolTarget: null,
    toolHistory: [],
  };
  let lastDashboardHeight = 0;
  let lastDashboardCol = 0;
  let geometry = computeGeometry(cols(), rows());
  let drawing = false; // SIGWINCH mid-write guard (R2)
  let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  let resizePending = false;
  // Tracks whether the last stdout write was a streaming partial_output
  // chunk with no trailing newline. The next non-partial event must emit
  // \n first or it will overwrite/interleave with the streamed text.
  let pendingPartial = false;
  // An aborted run emits error AND done carrying the same digest object;
  // render the receipts box once, not twice.
  let lastRenderedDigest: TurnDigest | null = null;

  /** Receipts box — the harness-computed end-of-turn digest. */
  function writeDigestBox(digest: TurnDigest): void {
    if (digest === lastRenderedDigest) return;
    lastRenderedDigest = digest;
    const w = contentWidth() + 2;
    const inner = w - 2;
    const sep = "═".repeat(inner);
    const borderFn = !opts.useColor
      ? (s: string) => s
      : digest.status === "completed"
      ? chalk.green
      : digest.status === "error"
      ? chalk.red
      : chalk.yellow;
    const rows = renderDigestLines(digest, Math.max(10, inner - 4));
    process.stdout.write("\n\n");
    process.stdout.write(borderFn(`╔${sep}╗`) + "\n");
    rows.forEach((row, idx) => {
      const body = padVisible(`  ${row}`, inner);
      const styled = !opts.useColor ? body : idx === 0 ? chalk.bold.white(body) : chalk.white(body);
      process.stdout.write(borderFn("║") + styled + borderFn("║") + "\n");
    });
    process.stdout.write(borderFn(`╚${sep}╝`) + "\n\n");
  }

  function recomputeGeometry(): void {
    geometry = computeGeometry(cols(), rows());
  }
  // SIGWINCH — re-anchor dashboard + re-wrap streamed output on terminal
  // resize. Debounced: 'resize' can fire dozens of times during a single
  // drag-resize (and on some terminals fires on every cursor move). Without
  // a debounce, the synchronous write storm stalls stdout and the agent
  // appears to hang.
  function onResize(): void {
    if (resizeDebounce) {
      resizePending = true;
      return;
    }
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      if (!resizePending) return;
      resizePending = false;
      recomputeGeometry();
      // Erase the previous dashboard footprint BEFORE redrawing — the old
      // dashCol may now be inside the new left column, and characters
      // left there would ghost over the streamed body.
      erasePreviousDashboard();
      drawDashboard();
    }, 80);
  }
  if (process.stdout.isTTY) {
    process.stdout.on("resize", onResize);
  }

  function erasePreviousDashboard(): void {
    if (!process.stdout.isTTY) return;
    if (lastDashboardHeight === 0 || lastDashboardCol <= 0) return;
    for (let i = 0; i < lastDashboardHeight; i++) {
      process.stdout.write(`\x1b[${2 + i};${lastDashboardCol}H\x1b[0K`);
    }
  }

  function stringifyArgs(args: Record<string, unknown>): string {
    const cached = argsStringCache.get(args);
    if (cached) return cached;
    const value = JSON.stringify(args);
    argsStringCache.set(args, value);
    return value;
  }

  function syncLedgerPanels(): void {
    const ledger = opts.getLedger?.();
    if (!ledger) return;
    dashboard.goal = ledger.goal;
    dashboard.goalActive = ledger.goalActive;
    dashboard.sessionTurns = ledger.turnCount;
    dashboard.sessionTokens = ledger.tokens;
    dashboard.sessionFiles = ledger.filesTouched;
    dashboard.lastOutcome = ledger.lastOutcome;
  }

  function drawDashboard(): void {
    if (!process.stdout.isTTY) return;
    // Narrow terminal → no side dashboard; the condensed HUD rides the
    // spinner line instead (see startSpinner).
    if (!geometry.showDashboard) return;
    if (drawing) return; // R2 — drop a redraw rather than corrupt the screen
    drawing = true;
    try {
      syncLedgerPanels();
      const dashWidth = geometry.dashWidth;
      const dashCol = geometry.dashCol;
      const lines = renderDashboardLines(dashboard, opts.useColor, dashWidth, visualization);
      if (lines.length === 0) return;
      // Pad to fill the right column from row 2 down to (termRows - 1).
      // Cap at termRows - 1 to avoid clearing the last terminal row.
      const target = Math.max(lines.length, geometry.termRows - 1);
      const padded = padDashboardToHeight(lines, target, Math.max(0, dashWidth - 2));
      // Erase the OLD footprint first (lastDashboardCol / lastDashboardHeight)
      // — after a shrink the previous dashCol may now overlap the body
      // column, so clearing only the new position would leave ghosts.
      if (lastDashboardHeight > 0 && lastDashboardCol > 0) {
        for (let i = 0; i < lastDashboardHeight; i++) {
          process.stdout.write(`\x1b[${2 + i};${lastDashboardCol}H\x1b[0K`);
        }
      }
      // Clear current column for the new padded area
      for (let i = 0; i < padded.length; i++) {
        process.stdout.write(`\x1b[${2 + i};${dashCol}H\x1b[0K`);
      }
      // Draw padded lines
      for (let i = 0; i < padded.length; i++) {
        process.stdout.write(`\x1b[${2 + i};${dashCol}H${padded[i]}`);
      }
      lastDashboardHeight = padded.length;
      lastDashboardCol = dashCol;
    } finally {
      drawing = false;
    }
  }

  function printThinkingSnapshot(): void {
    if (!activeThinking) return;
    const now = Date.now();
    if (now - lastThinkingSnapshot < 1000) return;
    lastThinkingSnapshot = now;
    // Quiet mode: keep the dashboard's thinking panel live but stay out of
    // the transcript.
    if (opts.getQuiet?.() !== true) {
      const snippet = normalizeWhitespace(activeThinking).slice(-200);
      const wrapWidth = Math.max(1, geometry.wrapWidth - 2);
      const wrapped = wrapStreamChunk(snippet, wrapWidth);
      process.stdout.write("\n  ⚡ ");
      if (opts.useColor) process.stdout.write(chalk.cyan(wrapped));
      else process.stdout.write(wrapped);
    }
    // Update dashboard with latest thinking state
    dashboard.thinkingCharCount = activeThinking.length;
    dashboard.thinkingPreview = activeThinking.slice(-200);
    drawDashboard();
  }

  function startSpinner(label: string): void {
    if (spinnerActive) return;
    spinnerActive = true;
    spinnerFrame = 0;
    const spinnerStartedAt = Date.now();
    activeSpinnerFrames = SPINNER_SETS[(spinnerLabelIndex + label.length) % SPINNER_SETS.length] ?? SPINNER_SETS[0];
    spinnerTimer = setInterval(() => {
      const frame = activeSpinnerFrames[spinnerFrame % activeSpinnerFrames.length];
      const secs = Math.floor((Date.now() - spinnerStartedAt) / 1000);
      // Elapsed always; on narrow terminals (no side dashboard) the spinner
      // line doubles as a condensed HUD: iter + session tokens. Below
      // MIN_HUD_COLS even that is dropped — just spinner + label.
      const hudParts: string[] = [];
      if (secs >= 1) hudParts.push(`${secs}s`);
      if (!geometry.showDashboard && geometry.termCols >= MIN_HUD_COLS) {
        if (iterMax > 0) hudParts.push(`iter ${iterCurrent}/${iterMax}`);
        const ledger = opts.getLedger?.();
        if (ledger && ledger.tokens.total > 0) hudParts.push(`${fmtTokens(ledger.tokens.total)} tok`);
      }
      const hud = hudParts.length > 0 ? ` · ${hudParts.join(" · ")}` : "";
      const plain = crop(`  ${frame} ${label}${hud}`, Math.max(10, cols() - 2));
      const line = opts.useColor
        ? `  ${chalk.cyan(frame)} ${chalk.dim(crop(`${label}${hud}`, Math.max(6, cols() - 6)))}`
        : plain;
      process.stdout.write(`\r\x1b[2K${line}`);
      spinnerFrame++;
    }, 200);
  }

  function oddLabel(labels: string[], replacements: Record<string, string> = {}): string {
    const template = labels[spinnerLabelIndex++ % labels.length];
    return Object.entries(replacements).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, value),
      template,
    );
  }

  function thinkingLabel(): string {
    return oddLabel(THINKING_LABELS);
  }

  function toolLabel(tool: string): string {
    return oddLabel(TOOL_LABELS, { tool });
  }

  function backgroundLabel(): string {
    return oddLabel(BACKGROUND_LABELS);
  }

  function stopSpinner(): void {
    if (!spinnerActive) return;
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    process.stdout.write("\r\x1b[2K");
    spinnerActive = false;
  }

  function printIterHeader(): void {
    const w = contentWidth() + 2;
    const inner = w - 2;
    const model = opts.getModel();
    const dir = opts.getWorkDir().replace(process.env.HOME ?? "", "~");
    const iterStr = `iter ${iterCurrent}/${iterMax}`;

    if (iterCurrent === 1) {
      const sep = "═".repeat(inner);
      const router = opts.getBaseURL?.().replace(/\/v1\/?$/, "") ?? "local";
      const routerMode = opts.getStartedByRouter?.() ? "auto-started" : "connected";
      const cwdName = dir.split("/").filter(Boolean).at(-1) ?? dir;
      const title = `  9rh  ·  ${model}`;
      const right = `${cwdName}  ·  ${formatSessionClock(sessionStartedAt)}  `;
      const gap = " ".repeat(Math.max(0, inner - title.length - right.length));
      const body = (title + gap + right).slice(0, inner).padEnd(inner);
      const metaPlain = [
        iterStr,
        `router ${crop(router, 28)}`,
        routerMode,
        `cwd ${crop(dir, 30)}`,
      ].join("  ·  ");
      const meta = opts.useColor ? chalk.dim(`  ${crop(metaPlain, inner - 4)}`) : `  ${crop(metaPlain, inner - 4)}`;

      process.stdout.write("\n");
      if (opts.useColor) {
        process.stdout.write(chalk.bold.blue(`╔${sep}╗`) + "\n");
        process.stdout.write(
          chalk.bold.blue("║") +
            chalk.bold.white(body) +
            chalk.bold.blue("║") +
            "\n",
        );
        process.stdout.write(chalk.bold.blue("║") + padVisible(meta, inner) + chalk.bold.blue("║") + "\n");
        process.stdout.write(chalk.bold.blue(`╚${sep}╝`) + "\n\n");
      } else {
        process.stdout.write(`╔${sep}╗\n║${body}║\n║${padVisible(meta, inner)}║\n╚${sep}╝\n\n`);
      }
    } else {
      const line = opts.useColor
        ? `\n  ${chalk.dim("─── " + iterStr + " ───")}\n`
        : `\n  --- ${iterStr} ---\n`;
      process.stdout.write(line);
    }
  }

  const onEvent = function (event: AgentEvent): void {
    applyAgentEvent(visualization, event);
    // If the previous event was a streaming partial_output (no trailing
    // newline) and this one is not, emit \n first so the next spinner /
    // tool header / dashboard redraw starts on its own line rather than
    // overwriting the streamed body.
    if (pendingPartial && event.type !== "partial_output") {
      process.stdout.write("\n");
      pendingPartial = false;
    }
    switch (event.type) {
      case "iteration":
        iterCurrent = event.current;
        iterMax = event.max;
        dashboard.iterCurrent = event.current;
        dashboard.iterMax = event.max;
        dashboard.activity = "thinking";
        thinkingActive = false;
        stopSpinner();
        printIterHeader();
        drawDashboard();
        startSpinner(thinkingLabel());
        break;

      case "thinking":
        if (!thinkingActive) {
          stopSpinner();
          thinkingActive = true;
        }
        recentThinking.push(event.text);
        activeThinking += event.text;
        if (recentThinking.join("").length > 1200) {
          recentThinking = [recentThinking.join("").slice(-1200)];
        }
        if (activeThinking.length > 2_000) activeThinking = activeThinking.slice(-2_000);
        // Throttled snapshot instead of streaming every char
        printThinkingSnapshot();
        break;

      case "tool_call": {
        stopSpinner();
        const target = toolTarget(event.args);
        // Compact 2-line summary instead of full drawBox
        const intent = describeToolIntent(event.name, event.args);
        const line1 = opts.useColor ? chalk.cyan(`⚙ ${event.name}`) : `⚙ ${event.name}`;
        const line2 = opts.useColor ? chalk.dim(`  ${intent}`) : `  ${intent}`;
        process.stdout.write(`\n${line1}\n${line2}\n`);
        // (The thinking snapshot already streamed live via
        // printThinkingSnapshot and the dashboard carries its own
        // thinking panel — no need to re-echo a reasoning excerpt here.)
        // Update dashboard state
        dashboard.activity = "tool";
        dashboard.currentTool = event.name;
        dashboard.currentToolTarget = target || null;
        dashboard.thinkingCharCount = 0;
        dashboard.thinkingPreview = "";
        dashboard.toolHistory.push({ status: "running", name: event.name, target: target || "" });
        if (dashboard.toolHistory.length > 20) dashboard.toolHistory = dashboard.toolHistory.slice(-20);
        drawDashboard();
        thinkingActive = false;
        activeThinking = "";
        recentThinking = [];
        startSpinner(toolLabel(event.name));
        break;
      }

      case "tool_result": {
        stopSpinner();
        // Mark the matching tool in history as done/failed
        const lastRunning = [...dashboard.toolHistory].reverse().find(h => h.status === "running");
        if (lastRunning) {
          lastRunning.status = event.error ? "error" : "success";
        }
        dashboard.activity = "idle";
        dashboard.currentTool = null;
        dashboard.currentToolTarget = null;
        if (event.error) {
          const content = [event.error, event.output].filter(Boolean).join("\n");
          const borderFn = opts.useColor ? chalk.red : (s: string) => s;
          process.stdout.write(
            "\n" + drawBox("✗  error", content, borderFn, opts.useColor, geometry.wrapWidth + 2) + "\n",
          );
        } else {
          const lines = event.output.split("\n");
          const preview = lines.slice(0, 6).join("\n");
          const wrappedPreview = wrapStreamChunk(preview, Math.max(1, geometry.wrapWidth - 4));
          const moreHint =
            lines.length > 6
              ? opts.useColor
                ? chalk.dim(`\n  … ${lines.length - 6} more lines`)
                : `\n  … ${lines.length - 6} more lines`
              : "";
          const tick = opts.useColor ? chalk.green("✓") : "✓";
          process.stdout.write(
            `\n  ${tick}  ${opts.useColor ? chalk.dim(wrappedPreview) : wrappedPreview}${moreHint}\n`,
          );
        }
        drawDashboard();
        thinkingActive = false;
        startSpinner(thinkingLabel());
        break;
      }

      case "compact":
        stopSpinner();
        process.stdout.write(
          "\n" +
            (opts.useColor
              ? chalk.yellow(`  ⟳  compacting context — ${event.summary}`)
              : `  compacting context — ${event.summary}`) +
            "\n\n",
        );
        drawDashboard();
        break;

      case "continuation":
        stopSpinner();
        process.stdout.write(
          "\n" +
            (opts.useColor
              ? chalk.yellow(`  ⟳  continuing ${event.count}/${event.max}`)
              : `  continuing ${event.count}/${event.max}`) +
            "\n\n",
        );
        drawDashboard();
        startSpinner(thinkingLabel());
        break;

      case "model_switch":
        stopSpinner();
        process.stdout.write(
          "\n" +
            (opts.useColor
              ? chalk.cyan(`  ⇄  switching model ${event.from} → ${event.to}`)
              : `  switching model ${event.from} → ${event.to}`) +
            "\n\n",
        );
        drawDashboard();
        startSpinner(thinkingLabel());
        break;

      case "spec_plan": {
        stopSpinner();
        const borderFn = opts.useColor ? chalk.magentaBright : (s: string) => s;
        process.stdout.write("\n" + drawBox("☑  generated test plan", event.summary, borderFn, opts.useColor, geometry.wrapWidth + 2) + "\n");
        drawDashboard();
        thinkingActive = false;
        break;
      }

      case "done": {
        stopSpinner();
        if (event.digest) {
          writeDigestBox(event.digest);
        } else {
          // No digest (programmatic caller without receipts) — keep the
          // historical plain done banner.
          const w = contentWidth() + 2;
          const sep = "═".repeat(w - 2);
          const body = "  ✓  done".padEnd(w - 2);
          process.stdout.write("\n\n");
          if (opts.useColor) {
            process.stdout.write(chalk.green(`╔${sep}╗`) + "\n");
            process.stdout.write(
              chalk.green("║") + chalk.bold.white(body) + chalk.green("║") + "\n",
            );
            process.stdout.write(chalk.green(`╚${sep}╝`) + "\n\n");
          } else {
            process.stdout.write(`╔${sep}╗\n║${body}║\n╚${sep}╝\n\n`);
          }
        }
        // Show the summary (existing behavior) and the report path link.
        const finalText = (event.text ?? "").trim();
        if (finalText) {
          // Preserve the model's structure (newlines, code blocks, bullet
          // lists) instead of collapsing to a single run-on line — a coding
          // agent's final answer is usually structured. Only collapse
          // 3+ consecutive blank lines so we don't get huge vertical gaps.
          const normalized = finalText.replace(/\n{3,}/g, "\n\n");
          // ponytail: 2000 char preview (~25 rows at 80 cols) covers the
          // common case where the agent's answer fits on screen. Beyond
          // this, point the user at /report open rather than dumping
          // thousands of lines into the scrollback.
          const MAX_FINAL = 2000;
          const overflow = normalized.length > MAX_FINAL;
          const shown = overflow
            ? `${normalized.slice(0, MAX_FINAL)}…`
            : normalized;
          const header = opts.useColor ? chalk.bold.cyan("  summary") : "  summary";
          process.stdout.write(`${header}\n`);
          const indent = "  ";
          const wrapWidth = Math.max(1, geometry.wrapWidth - 2);
          const wrapped = wrapStreamChunk(shown, wrapWidth);
          for (const line of markdownLite(wrapped.split("\n"), opts.useColor)) {
            process.stdout.write(`${indent}${line}\n`);
          }
          if (overflow) {
            const hint = `(…${normalized.length - MAX_FINAL} more chars — full text in the run report)`;
            const hintLine = opts.useColor ? chalk.dim(`${indent}${hint}`) : `${indent}${hint}`;
            process.stdout.write(`${hintLine}\n`);
          }
          process.stdout.write("\n");
        }
        if (event.reportPath) {
          const reportLine = `  report: file://${event.reportPath}  (open with /report open)`;
          process.stdout.write(opts.useColor ? chalk.cyan(reportLine) : reportLine);
          process.stdout.write("\n");
          opts.onReportWritten?.(event.reportPath);
        }
        dashboard.activity = "done";
        drawDashboard();
        break;
      }

      case "error":
        stopSpinner();
        process.stdout.write(
          "\n" +
            (opts.useColor
              ? chalk.red(`  ⚠  ${event.message}`)
              : `  ⚠  ${event.message}`) +
            "\n\n",
        );
        if (event.digest) {
          writeDigestBox(event.digest);
        }
        if (event.reportPath) {
          const reportLine = `  report: file://${event.reportPath}  (open with /report open)`;
          process.stdout.write(opts.useColor ? chalk.cyan(reportLine) : reportLine);
          process.stdout.write("\n\n");
          opts.onReportWritten?.(event.reportPath);
        }
        dashboard.activity = "error";
        drawDashboard();
        break;

      case "usage":
        // Session token totals changed — refresh the dashboard panels
        // without touching the spinner (usage lands mid-run).
        drawDashboard();
        break;

      case "repair_start":
      case "repair_success":
      case "escalate":
      case "circuit_open":
      case "sandbox_health":
      case "branch_create":
      case "incident":
        stopSpinner();
        drawDashboard();
        startSpinner(backgroundLabel());
        break;
      case "team": {
        // Orchestrator pipeline progress — transcript sections per role plus
        // live TEAM lanes in the dashboard.
        const te = event.event;
        const dim = (s: string) => (opts.useColor ? chalk.dim(s) : s);
        switch (te.type) {
          case "role_start":
            stopSpinner();
            process.stdout.write(`\n  ${dim(`─── ${te.role} ───`)}\n`);
            dashboard.teamLanes ??= [];
            applyTeamEvent(dashboard.teamLanes, te);
            dashboard.activity = "thinking";
            drawDashboard();
            startSpinner(`team · ${te.role}`);
            break;
          case "role_complete": {
            stopSpinner();
            const tok = te.usage ? ` · ${fmtTokens(te.usage.total)} tok` : "";
            const line = `  ✓ ${te.role}${tok}`;
            process.stdout.write((opts.useColor ? chalk.green(line) : line) + "\n");
            dashboard.teamLanes ??= [];
            applyTeamEvent(dashboard.teamLanes, te);
            drawDashboard();
            break;
          }
          case "role_skip":
            process.stdout.write(dim(`  ⊘ ${te.role} — ${te.reason}`) + "\n");
            dashboard.teamLanes ??= [];
            applyTeamEvent(dashboard.teamLanes, te);
            drawDashboard();
            break;
          case "cache_hit":
            process.stdout.write(dim(`  ↻ ${te.role} (cache hit)`) + "\n");
            dashboard.teamLanes ??= [];
            applyTeamEvent(dashboard.teamLanes, te);
            drawDashboard();
            break;
          case "conflict": {
            const line = `  ⚠ conflict resolved: ${te.resolution}`;
            process.stdout.write((opts.useColor ? chalk.yellow(line) : line) + "\n");
            break;
          }
          case "escalation": {
            stopSpinner();
            const line = `  ↑ escalated: ${te.reason}`;
            process.stdout.write((opts.useColor ? chalk.red(line) : line) + "\n");
            break;
          }
          case "task_complete":
          case "task_failed":
            stopSpinner();
            if (te.type === "task_failed") {
              const line = `  ✗ team failed: ${te.error}`;
              process.stdout.write((opts.useColor ? chalk.red(line) : line) + "\n");
            }
            // Pipeline over — the TEAM panel clears; the receipts digest
            // (emitted by the team runner as a done/error event) is the
            // durable record.
            dashboard.teamLanes = undefined;
            drawDashboard();
            break;
        }
        break;
      }

      case "step_inspect": {
        stopSpinner();
        const step = inspectStep(visualization, event.stepId);
        if (!step) break;
        const details: string[] = [];
        if (event.params) details.push(`params:\n${event.params}`);
        if (event.output) details.push(`output:\n${event.output}`);
        if (event.diff) details.push(`diff:\n${event.diff}`);
        if (event.trace) details.push(`trace:\n${event.trace}`);
        if (event.policy) details.push(`policy:\n${event.policy}`);
        if (!details.length) break;
        const borderFn = opts.useColor ? chalk.blueBright : (s: string) => s;
        process.stdout.write("\n" + drawBox(`▸ inspect ${event.stepId}`, details.join("\n\n"), borderFn, opts.useColor, geometry.wrapWidth + 2) + "\n");
        drawDashboard();
        break;
      }
      case "partial_output": {
        const step = visualization.steps.find((s) => s.id === event.stepId);
        if (step) {
          const wrapWidth = Math.max(1, geometry.wrapWidth - 2);
          const wrapped = wrapStreamChunk(event.text, wrapWidth);
          // The assistant's streamed answer is the highest-value content in
          // the UI — render at normal weight, not dim. Dim reads as system
          // noise and tanks contrast against the dashboard background.
          process.stdout.write(wrapped);
          // Streamed text has no trailing newline; flag so the next
          // non-partial event closes the line.
          pendingPartial = true;
        }
        break;
      }
    }
  };

  // Attach a dispose() so long-lived REPLs can release the SIGWINCH
  // listener + pending timers when the renderer is replaced. Without
  // this, every createTuiRenderer() call in a session that re-inits
  // per task leaks a listener and redraws N times per resize.
  (onEvent as { dispose?: () => void }).dispose = (): void => {
    if (resizeDebounce) {
      clearTimeout(resizeDebounce);
      resizeDebounce = null;
    }
    resizePending = false;
    if (thinkingSnapshotTimer) {
      clearTimeout(thinkingSnapshotTimer);
      thinkingSnapshotTimer = null;
    }
    stopSpinner();
    if (process.stdout.isTTY) {
      process.stdout.off("resize", onResize);
    }
  };

  return onEvent;
}
