import { cursorTo, clearLine } from "readline";
import chalk from "chalk";

const THEME = {
  queue: chalk.magenta,
 ok: chalk.green,
  err: chalk.red,
  spinner: chalk.yellow,
  busy: chalk.yellow,
  progress: chalk.blue,
  spinnerFrames: ["\u28FE","\u28FD","\u283B","\u28F5","\u28F9","\u28FA","\u28E7","\u2877"],
  busyFrames: ["\u27F8","\u27F9","\u27FA","\u27FB"],
  queueFrames: ["\u25CF","\u25CB"],
  funMessages: [
    "consulting the docs",
    "reticulating splines",
    "computing clever response",
    "thinking really hard",
    "asking the tokens nicely",
    "loading loading loading",
    "brewing context window",
    "pinging the void",
    "unscrambling embeddings",
    "doing the robot dance",
    "consulting stack overflow",
    "counting parameters",
    "aligning attention heads",
    "shuffling weight matrices",
    "deleting bugs... just kidding",
  ],
};

let spinnerIdx = 0;
let busyIdx = 0;
let queueFillIdx = 0;
let funIdx = 0;

function termRows(): number { return (process.stderr as NodeJS.WriteStream).rows ?? 24; }
function termCols(): number { return (process.stderr as NodeJS.WriteStream).columns ?? 80; }

function cursorToStatus(): void {
  cursorTo(process.stderr, 0, termRows() - 2);
}

export function clearStatus(): void {
  cursorToStatus();
  clearLine(process.stderr, 0);
}

export function showSpinner(msg = "Processing"): void {
  const frame = THEME.spinnerFrames[spinnerIdx % THEME.spinnerFrames.length];
  const fun = THEME.funMessages[funIdx % THEME.funMessages.length];
  spinnerIdx++;
  funIdx++;
  cursorToStatus();
  clearLine(process.stderr, 0);
  process.stderr.write(`${THEME.spinner(msg)} ${chalk.dim(fun)} ${frame}`);
}

export function hideSpinner(): void { clearStatus(); }

export function pulseQueueBadge(queueLength: number): void {
  queueFillIdx = (queueFillIdx + 1) % THEME.queueFrames.length;
  const badge = THEME.queueFrames[queueFillIdx];
  cursorToStatus();
  clearLine(process.stderr, 0);
  process.stderr.write(`${THEME.queue(badge)} Queued: ${queueLength}`);
}

export interface StatsSnapshot {
  queueLength: number;
  stepIndex: number;
  elapsedMs?: number;
  toolCalls?: Record<string, number>;
}

export function formatStats(s: StatsSnapshot): string {
  const parts: string[] = [];
  if (s.stepIndex > 0) parts.push(`step:${s.stepIndex}`);
  if (s.elapsedMs !== undefined) {
    parts.push(`${(s.elapsedMs / 1000).toFixed(1)}s`);
  }
  if (s.toolCalls && Object.keys(s.toolCalls).length) {
    parts.push(Object.entries(s.toolCalls).map(([n, c]) => `${n}\u00d7${c}`).join(" "));
  }
  return THEME.queue(parts.join(" \u2502 "));
}

export function showRightStats(text: string, col = 45): void {
  const width = termCols();
  cursorTo(process.stderr, 0, termRows() - 2);
  process.stderr.write(`\x1b[${col}G`);
  const display = text.length > width - col ? text.slice(0, width - col - 1) + "\u2026" : text;
  process.stderr.write(display);
}

export function hideRightStats(): void { clearStatus(); }

export function refreshStatusLine(snapshot: StatsSnapshot): void {
  pulseQueueBadge(snapshot.queueLength);
  showRightStats(formatStats(snapshot));
}

export function showBusy(msg = "Waiting"): void {
  const frame = THEME.busyFrames[busyIdx % THEME.busyFrames.length];
  busyIdx++;
  cursorToStatus();
  clearLine(process.stderr, 0);
  process.stderr.write(`${THEME.busy(msg)} ${frame}`);
}

export function hideBusy(): void { clearStatus(); }
