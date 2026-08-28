#!/usr/bin/env node
import { createInterface, cursorTo, emitKeypressEvents, moveCursor, clearScreenDown, clearLine, type Interface } from "readline";
import { resolve } from "path";
import { program } from "commander";
import chalk from "chalk";
import { Agent, type AgentEvent, type ContinuationPolicy, type ToolApprovalRequest, type ToolApprovalDecision, type AskUserRequest, type AskUserResponse } from "./agent.js";
import { executeSlashCommand, fetchModels, filterModels, type ModelInfo, type SessionState, toArray, getSlashCommands } from "./commands.js";
import { ensureRouter, readFirstApiKey, getCliToken } from "./init.js";
import { createTuiRenderer, printSplash, clampMenuFocus, menuWindow, pickFromList, readLineRaw, type PickItem } from "./tui.js";
import { detectBackend, getProviderPreset, listProviderPresetIds, type Backend } from "./backends/index.js";
import { compressUserInput } from "./inputCompression.js";
import { ReplInputCoalescer } from "./replInput.js";
import { readUserConfig, resolveConfiguredModel, updateUserConfig } from "./config.js";
import { existsSync, statSync } from "fs";
import { spawn } from "child_process";
import { Orchestrator } from "./orchestrator/index.js";
import { shouldSuggestTeam } from "./orchestrator/dispatch.js";
import { planRewind, applyRewind } from "./rewind.js";
import { listRunLogs, readEventLog, renderEventLog } from "./flightRecorder.js";
import { ninerhDir } from "./paths.js";
import {
  hasOption as hasOptionRaw,
  resolveMaxIter,
  buildContinuationPolicy,
  classifyInitCommand,
} from "./cliArgs.js";
import { Sandbox, getSandboxStatus, getDefaultSandboxConfig } from "./sandbox/index.js";
import { SessionLedger, buildTurnDigest } from "./ledger.js";

async function maybeAutoIndexCodeGraph(workDir: string): Promise<void> {
  const codegraphDir = resolve(workDir, ".codegraph");
  // Check if .codegraph directory exists and seems initialized
  const configPath = resolve(codegraphDir, "config.json");
  const dbPath = resolve(codegraphDir, "codegraph.db");
  const needsInit = !existsSync(configPath) || !existsSync(dbPath);
  if (needsInit) {
    try {
      // Run codegraph init -i to initialize and index
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("codegraph", ["init", "-i"], {
          cwd: workDir,
          stdio: "ignore" // silent; could pipe to stderr if desired
        });
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`codegraph init exited with code ${code}`));
        });
        proc.on("error", reject);
      });
      // Optionally inform user
      // process.stderr.write(`  CodeGraph initialized and indexed.\n`);
    } catch (err) {
      // Silently fail – don't block REPL on indexing errors
      // process.stderr.write(`  CodeGraph auto-index skipped: ${err.message}\n`);
    }
  }
}

/** Where run event logs live — read back by /replay. */
const RUNS_DIR = ninerhDir("runs");

const DEFAULTS = {
  url: process.env.NINE_ROUTER_URL ?? "http://127.0.0.1:20128/v1",
  key: process.env.NINE_ROUTER_KEY ?? "9router",
  model: process.env.NINE_ROUTER_MODEL ?? "kr/claude-sonnet-4.5",
  continuationModel: process.env.NINE_ROUTER_CONTINUATION_MODEL,
  continuationMax: process.env.NINE_ROUTER_CONTINUATION_MAX ?? "20",
  continuationIter: process.env.NINE_ROUTER_CONTINUATION_ITER,
  continuationSwitchAfter: process.env.NINE_ROUTER_CONTINUATION_SWITCH_AFTER,
  maxIter: 100,
  backend: process.env.NINE_ROUTER_BACKEND,
  directUrl: process.env.OPENAI_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? process.env.OPENROUTER_BASE_URL,
  directKey: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENROUTER_API_KEY,
};

program
  .name("9rh")
  .description("Local coding-agent harness with pluggable LLM backends (9router, OpenAI, OpenRouter, Ollama, LM Studio)")
  .version("1.0.0")
  .argument("[task]", "Task for the agent to perform")
  .option("-m, --model <model>", "Model to use (e.g. kr/claude-sonnet-4.5)", DEFAULTS.model)
  .option("-u, --url <url>", "9router API URL", DEFAULTS.url)
  .option("-k, --key <key>", "9router API key", DEFAULTS.key)
  .option("-d, --dir <dir>", "Working directory", process.cwd())
  .option("-i, --max-iter <n>", "Max agent iterations", String(DEFAULTS.maxIter))
  .option("-b, --backend <name>", "LLM backend: router | direct (default: auto-detect)", DEFAULTS.backend)
  .option("-p, --provider <name>", `Direct-mode provider preset: ${listProviderPresetIds().join(" | ")}`)
  .option("--direct-url <url>", "Direct backend base URL (e.g. https://api.openai.com/v1)", DEFAULTS.directUrl)
  .option("--direct-key <key>", "Direct backend API key (otherwise from OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY)", DEFAULTS.directKey)
  .option("--report-path <path>", "Override the run report path (default: ~/.9rh/last-run.html)")
  .option("--no-report", "Disable run report generation entirely")
  .option("--no-continue", "Disable automatic continuation after max iterations")
  .option("--continue-model <model>", "Model or 9router combo to use after max iterations", DEFAULTS.continuationModel)
  .option("--continue-max <n>", "Maximum continuation rounds", DEFAULTS.continuationMax)
  .option("--continue-iter <n>", "Iterations per continuation round", DEFAULTS.continuationIter)
  .option("--continue-switch-after <n>", "Continuation round that triggers model switch", DEFAULTS.continuationSwitchAfter)
  .option("--repl", "Start interactive REPL session")
  .option("--no-color", "Disable colored output")
  .option("--allow-skill-install", "Allow the agent to call install_skill without prompting (default: blocked in non-TTY, prompted in TTY)")
  .option("--set-default-model [model]", "Persist a default model for future runs; omit model to pick from the model list")
  .option("--set-default-provider <provider>", "Persist a default provider/prefix for future runs")
  .option("--show-config", "Show persisted 9rh defaults and exit")
  .option("--doctor", "Run pre-flight diagnostics and exit")
  .option("--orchestrate", "Route the task through the multi-role team pipeline (architect → implementer → security audit → test strategist → reviewer loop) instead of the streaming Agent loop. Without this flag, structured-looking tasks get a visible \"run as a team?\" prompt instead of silent rerouting.");

const rawArgs = process.argv.slice(2);
const isInit = rawArgs[0] === "init";

if (!isInit) {
  program.parse();
}

const opts = program.opts<{
  model?: string;
  url: string;
  key: string;
  dir: string;
  maxIter: string;
  backend?: string;
  provider?: string;
  directUrl?: string;
  directKey?: string;
  reportPath?: string;
  report?: boolean;
  continueModel?: string;
  continueMax?: string;
  continueIter?: string;
  continueSwitchAfter?: string;
  continue?: boolean;
  repl: boolean;
  color: boolean;
  doctor: boolean;
  showConfig: boolean;
  allowSkillInstall?: boolean;
  setDefaultModel?: string | boolean;
  setDefaultProvider?: string;
  orchestrate?: boolean;
}>();

const task = program.args[0];

function hasOption(...names: string[]): boolean {
  return hasOptionRaw(rawArgs, names);
}

if (isInit) {
  const { action, quiet } = classifyInitCommand(rawArgs);
  const log = (msg: string) => { if (!quiet) process.stderr.write(msg + "\n"); };

  if (action === "update") {
    // 9rh is installed from source (not published to npm), so self-update
    // means: pull + rebuild the checkout this binary runs from. dist/index.js
    // lives one level under the repo root; `npm link` resolves through the
    // symlink to the same place.
    Promise.all([import("child_process"), import("url")]).then(([{ execFileSync }, { fileURLToPath }]) => {
      const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
      if (!existsSync(resolve(repoRoot, ".git"))) {
        log(chalk.red(`  ✗ ${repoRoot} is not a git checkout — update by pulling your clone and running \`npm run build\``));
        process.exit(1);
      }
      log(chalk.blue(`  Updating 9rh from source (${repoRoot})...`));
      try {
        execFileSync("git", ["pull", "--ff-only"], { cwd: repoRoot, stdio: "inherit" });
        execFileSync("npm", ["install"], { cwd: repoRoot, stdio: "inherit" });
        execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
        log(chalk.green("  ✓ 9rh updated"));
        process.exit(0);
      } catch {
        log(chalk.red("  ✗ Update failed"));
        process.exit(1);
      }
    });
  } else if (action === "update-router") {
    log(chalk.blue("  Updating 9router via npm..."));
    import("child_process").then(({ execFileSync }) => {
      try {
        execFileSync("npm", ["install", "-g", "9router@latest"], { stdio: "inherit" });
        log(chalk.green("  ✓ 9router updated"));
      } catch {
        log(chalk.red("  ✗ Update failed"));
      }
      process.exit(0);
    });
  } else if (action === "install") {
    log(chalk.blue("  Initializing 9router..."));
    ensureRouter(DEFAULTS.url, DEFAULTS.key).then((init) => {
      if (init.error) { log(chalk.red(`  ✗ ${init.error}`)); process.exit(1); }
      log(chalk.green("  ✓ 9router ready at http://127.0.0.1:20128"));
      process.exit(0);
    }).catch((err) => { log(chalk.red(`  ✗ ${err.message}`)); process.exit(1); });
  } else if (action === "ready") {
    log(chalk.blue("  9router is ready — run `9rh --doctor` to verify"));
    process.exit(0);
  } else {
    log(chalk.red("  Unknown init option"));
    process.exit(1);
  }
}

// The pure parsers in cliArgs return a result rather than exiting; the CLI
// still wants bad --flag input to print to stderr and exit 1.
function parseMaxIter(): number {
  const r = resolveMaxIter(opts.maxIter, DEFAULTS.maxIter);
  if (!r.ok) {
    process.stderr.write(r.error + "\n");
    process.exit(1);
  }
  return r.value;
}

function parseContinuationPolicy(): ContinuationPolicy | undefined {
  const r = buildContinuationPolicy(opts);
  if (!r.ok) {
    process.stderr.write(r.error + "\n");
    process.exit(1);
  }
  return r.policy;
}

let _userConfigKeepReports: boolean | undefined;
async function loadUserConfigKeepReports(): Promise<boolean | undefined> {
  if (_userConfigKeepReports === undefined) {
    const cfg = await readUserConfig();
    _userConfigKeepReports = cfg.keepReports;
  }
  return _userConfigKeepReports;
}

/**
 * Interactive tool-approval callback for CLI/REPL mode.
 *
 * High-risk commands (e.g. `sudo`, `git reset --hard`) require explicit
 * confirmation when stdin is a TTY; they are auto-approved when stdin is
 * piped so non-interactive scripts keep working. Critical commands always
 * prompt or are rejected in non-TTY mode.
 */
async function interactiveToolApproval(
  req: ToolApprovalRequest,
  useColor: boolean,
): Promise<ToolApprovalDecision> {
  const argsPreview = JSON.stringify(req.args).slice(0, 120);
  const header = useColor
    ? chalk.yellow(`\n  ⚠  High-risk tool call detected`) + chalk.dim(` [${req.risk}]\n`) +
      `  ${chalk.bold(req.name)}  ${chalk.dim(argsPreview)}\n`
    : `\n  ⚠  High-risk tool call [${req.risk}]\n  ${req.name}  ${argsPreview}\n`;

  process.stderr.write(header);

  // Non-TTY stdin: auto-approve high, reject critical.
  if (!process.stdin.isTTY) {
    if (req.risk === "critical") {
      process.stderr.write("  ✗ Critical command rejected in non-interactive mode.\n");
      return { approved: false, reason: "critical command rejected in non-interactive mode" };
    }
    process.stderr.write("  ✓ Auto-approved (non-interactive mode).\n");
    return { approved: true };
  }

  // TTY: single-keypress confirmation.
  const question = useColor
    ? chalk.dim("  Allow? [y/N] ")
    : "  Allow? [y/N] ";
  process.stderr.write(question);

  const answer = await new Promise<string>((resolve) => {
    const wasRaw = (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      process.stdin.off("data", onData);
      try { process.stdin.setRawMode(wasRaw); } catch {}
      resolve(chunk.toString("utf8").toLowerCase().trim());
    };
    process.stdin.once("data", onData);
  });

  process.stderr.write(answer + "\n");
  if (answer === "y") {
    return { approved: true };
  }
  return { approved: false, reason: "rejected by user" };
}

/**
 * Compose the session ledger into an agent-event sink. The ledger folds the
 * event first so the TUI's dashboard redraw (triggered by the same event)
 * reads fresh session totals.
 */
function withLedger(
  ledger: SessionLedger | undefined,
  onEvent: (e: AgentEvent) => void,
): (e: AgentEvent) => void {
  if (!ledger) return onEvent;
  return (e: AgentEvent): void => {
    ledger.onAgentEvent(e);
    onEvent(e);
  };
}

function makeAgent(state: SessionState, onEvent: (e: AgentEvent) => void) {
  // state.lastReportPath semantics:
  //   null  → "use the Agent's default" (default: ~/.9rh/last-run.html)
  //   false → disabled
  //   string → use this path
  const reportPath: string | false | undefined =
    state.lastReportPath === null
      ? undefined
      : state.lastReportPath === false
      ? false
      : state.lastReportPath;
  return new Agent({
    baseURL: state.baseURL,
    apiKey: state.apiKey,
    model: state.model,
    maxIterations: parseMaxIter(),
    workDir: state.workDir,
    onEvent,
    continuationPolicy: state.continuationPolicy,
    reportPath,
    keepReports: _userConfigKeepReports,
    allowSkillInstall: opts.allowSkillInstall,
    onToolApproval: (req: ToolApprovalRequest): Promise<ToolApprovalDecision> =>
      interactiveToolApproval(req, state.useColor),
    onAskUser: (req: AskUserRequest): Promise<AskUserResponse> =>
      interactiveAskUser(req, state.useColor),
    // Flight recorder — every run's event log lands in ~/.9rh/runs so
    // /replay can re-render it later. Events are redacted before write.
    replay: { enabled: true, logDir: RUNS_DIR },
  });
}


/**
 * Team pipeline — run a task through `Orchestrator.orchestrate()`, streaming
 * OrchestratorEvents into the SAME AgentEvent channel the TUI renders
 * (transcript role sections + dashboard TEAM lanes). The turn closes with a
 * receipts digest like any other run; role token counts fold into the
 * session ledger via the `team` events.
 */
async function runTeamPipeline(
  state: SessionState,
  emit: (e: AgentEvent) => void,
  task: string,
): Promise<void> {
  const startedAt = Date.now();
  let rolesRun = 0;
  const orchestrator = new Orchestrator({
    baseURL: state.baseURL,
    apiKey: state.apiKey,
    model: state.model,
    workDir: state.workDir,
    onEvent: (event) => {
      if (event.type === "role_complete") rolesRun++;
      emit({ type: "team", event });
    },
  });
  try {
    const result = await orchestrator.orchestrate(task);
    // The ledger accumulated per-role tokens from the team events; read the
    // open turn's running total so the receipts headline can show it.
    const tokens = state.ledger?.view().turns.at(-1)?.tokens;
    const digest = buildTurnDigest(
      { task, startedAt, workDir: state.workDir, fileChanges: [], toolCalls: [] },
      { status: result.status === "completed" ? "completed" : "error", steps: rolesRun, tokens },
    );
    let text = result.summary;
    if (result.escalationReason) text += `\n\nEscalated: ${result.escalationReason}`;
    if (result.status === "completed") {
      emit({ type: "done", text, digest });
    } else {
      emit({ type: "error", message: text, digest });
    }
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Auto-suggest gate — when a task looks structured (shouldSuggestTeam), ASK
 * instead of silently rerouting: a two-item picker with the pipeline
 * preview. Non-interactive sessions always take the streaming agent.
 */
async function offerTeamPipeline(
  state: SessionState,
  onActiveChange?: (active: boolean) => void,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  process.stderr.write("\n");
  const picked = await pickFromList(
    [
      { id: "agent", label: "streaming agent", hint: "(default — single agent with live tools)", active: true },
      { id: "team", label: "team pipeline", hint: "architect → implementer → security audit → test strategist → reviewer" },
    ],
    { title: "❓ This looks multi-step — run it as a team?", useColor: state.useColor, onActiveChange },
  );
  return picked === "team";
}

async function runTask(state: SessionState, t: string): Promise<void> {
  const compressed = compressUserInput(t);
  if (compressed.notices.length > 0) {
    process.stderr.write(compressed.notices.map((notice) => `  ⧉ ${notice}`).join("\n") + "\n");
  }

  state.ledger?.beginTurn(compressed.text);

  const ledger = state.ledger;
  const tui = createTuiRenderer({
    getModel: () => state.model,
    getWorkDir: () => state.workDir,
    getBaseURL: () => state.baseURL,
    getStartedByRouter: () => state.wasStarted,
    useColor: state.useColor,
    onReportWritten: (path) => { state.lastReportPath = path; },
    getLedger: ledger ? () => ledger.view() : undefined,
    getQuiet: () => state.quiet === true,
  });
  const emit = withLedger(ledger, tui);

  // Team dispatch is explicit: --orchestrate forces the pipeline; otherwise
  // a structured-looking task triggers a visible suggestion prompt.
  const useTeam =
    state.useOrchestrate === true ||
    (shouldSuggestTeam(compressed.text) && (await offerTeamPipeline(state)));
  if (useTeam) {
    await runTeamPipeline(state, emit, compressed.text);
    return;
  }

  // Streaming Agent loop (default).
  const agent = makeAgent(state, emit);
  await agent.run(compressed.text);
}

/**
 * Model picker — thin wrapper over the generic pickFromList (src/tui.ts),
 * which carries the arrow-key/PgUp/wheel/Enter/Esc machinery shared with
 * ask_user and future sub-pickers.
 */
async function selectModelFromList(
  models: ModelInfo[],
  filter: string,
  currentModel: string,
  useColor: boolean,
  onActiveChange?: (active: boolean) => void,
): Promise<string | null> {
  return pickFromList(
    models.map((m) => ({
      id: m.id,
      label: m.id,
      hint: m.owned_by ? `[${m.owned_by}]` : undefined,
      active: m.id === currentModel,
    })),
    {
      title: `${models.length} model(s)${filter ? ` matching "${filter}"` : ""}`,
      useColor,
      onActiveChange,
    },
  );
}

/**
 * Interactive ask_user handler: renders the model's clarifying question as
 * an arrow-key picker (options first, recommended default on top), with an
 * optional free-text escape hatch. Non-TTY sessions auto-select the first
 * option and mark it as an assumption — the agent loop records it into the
 * turn receipts.
 */
async function interactiveAskUser(req: AskUserRequest, useColor: boolean): Promise<AskUserResponse> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return { answer: req.options[0] ?? "", assumed: true };
  }
  const FREE_ID = "__free_text__";
  const items: PickItem[] = req.options.map((option, i) => ({
    id: option,
    label: option,
    hint: i === 0 ? "(recommended)" : undefined,
  }));
  if (req.allowFreeText || items.length === 0) {
    items.push({ id: FREE_ID, label: "type a custom answer…" });
  }
  process.stderr.write("\n");
  const picked = await pickFromList(items, {
    title: `❓ ${req.question}`,
    useColor,
  });
  if (picked === null) return { answer: "" }; // dismissed with Esc
  if (picked === FREE_ID) {
    // ponytail: free-text may double-echo under a live REPL readline;
    // revisit with a proper input-owner arbiter if it bites in practice.
    const typed = await readLineRaw("↳ your answer:", useColor);
    return { answer: typed ?? "" };
  }
  return { answer: picked };
}

async function runRepl(state: SessionState): Promise<void> {
  const replLedger = state.ledger;
  const tui = createTuiRenderer({
    getModel: () => state.model,
    getWorkDir: () => state.workDir,
    getBaseURL: () => state.baseURL,
    getStartedByRouter: () => state.wasStarted,
    useColor: state.useColor,
    onReportWritten: (path) => { state.lastReportPath = path; },
    getLedger: replLedger ? () => replLedger.view() : undefined,
    getQuiet: () => state.quiet === true,
  });

  const nativeBase = state.baseURL.replace(/\/v1\/?$/, "");
  if (process.stdout.isTTY) {
    // Clear screen and scrollback
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }
  await printSplash(state.useColor);

  const ALL_CMDS = getSlashCommands();

  function fuzzyScore(pattern: string, target: string): number {
    if (!pattern) return 1;
    const p = pattern.toLowerCase();
    const t = target.toLowerCase();
    let pi = 0;
    for (let ti = 0; ti < t.length && pi < p.length; ti++) {
      if (p[pi] === t[ti]) pi++;
    }
    return pi === p.length ? pi : 0;
  }

  function fuzzyFilter(partial: string): Array<{ name: string; description: string; usage: string }> {
    if (!partial) return ALL_CMDS;
    return ALL_CMDS
      .map(c => ({ c, score: fuzzyScore(partial, c.name) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ c }) => c);
  }

  function highlightMatch(name: string, partial: string): string {
    if (!partial || !opts.color) return opts.color ? chalk.dim(name) : name;
    const p = partial.toLowerCase();
    let pi = 0;
    let out = "";
    for (let ti = 0; ti < name.length; ti++) {
      if (pi < p.length && name[ti].toLowerCase() === p[pi]) {
        out += chalk.bold.cyan(name[ti]);
        pi++;
      } else {
        out += chalk.dim(name[ti]);
      }
    }
    return out;
  }

  let suggCount = 0;
  let lastSuggestionKey = "";
  let suggestionTop = 0;
  let lastSuggestionPartial = "";
  let lastSuggestionMatches: Array<{ name: string; description: string; usage: string }> = [];
  let renderToken = 0;
  let renderQueued = false;
  let pickerActive = false;
  // Focus cursor for the slash-command palette. 0 = the top match. When the
  // user hits Enter on a space-less line, the focused command runs; ↑/↓ move
  // focus and the viewport follows. Reset to 0 whenever the match set changes.
  let selectedIndex = 0;

  function stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-9;]*m/g, "");
  }

  function promptColumns(): number {
    const visible = stripAnsi(prompt());
    return visible.length;
  }

  function redrawLine(): void {
    cursorTo(process.stderr, 0);
    clearLine(process.stderr, 0);
    process.stderr.write(prompt() + rl.line);
    cursorTo(process.stderr, promptColumns() + rl.cursor);
  }

  // readline's Interface.line / Interface.cursor are mutable at runtime
  // (readline itself mutates them on every keystroke) but @types/node
  // declares them readonly. This helper is the single typed escape hatch
  // for programmatically resetting the input, used by Esc-cancel,
  // Tab-complete, and Ctrl+C. No `as any`.
  type MutableRL = Interface & { line: string; cursor: number };
  function setRlLine(text: string): void {
    const m = rl as MutableRL;
    m.line = text;
    m.cursor = text.length;
  }

  function showSuggestions(
    matches: Array<{ name: string; description: string; usage: string }>,
    partial: string,
  ): void {
    const visibleRows = Math.max(4, Math.min(12, (process.stderr.rows ?? 24) - 8));
    // New query (or freshly opened) → focus resets to the top match. This is
    // the common path: as you type, focus follows the best match so Enter
    // runs the thing you're probably aiming at.
    if (partial !== lastSuggestionPartial) {
      selectedIndex = 0;
      suggestionTop = 0;
    }
    if (matches.length === 0) { clearSuggestions(); return; }
    // Keep the focus cursor inside the (possibly re-filtered) list.
    selectedIndex = Math.min(selectedIndex, matches.length - 1);
    const win = menuWindow(selectedIndex, matches.length, visibleRows);
    suggestionTop = win.start;
    const items = matches.slice(win.start, win.end);
    const key = `${partial}|${win.start}|${selectedIndex}|${items.map((m) => m.name).join(";")}`;
    if (key === lastSuggestionKey) return;
    const hiddenBefore = win.start;
    const hiddenAfter = Math.max(0, matches.length - win.end);
    suggCount = items.length + 1; // +1 for the always-on hint line
    lastSuggestionKey = key;
    lastSuggestionPartial = partial;
    lastSuggestionMatches = matches;
    const maxLen = Math.max(...items.map(i => i.name.length));
    const lines = items.map(({ name, description, usage }, i) => {
      const idx = win.start + i;
      const focused = idx === selectedIndex;
      const marker = focused ? "❯" : " ";
      const hi = highlightMatch(name, partial);
      const pad = " ".repeat(Math.max(1, maxLen - name.length + 2));
      // Argument hint from the command's usage string (e.g. "[tail <lines>]")
      // so argful commands are discoverable from the palette itself.
      const argHint = usage.startsWith(`/${name} `) ? usage.slice(name.length + 2).trim() : "";
      const detail = (argHint ? `${argHint}  —  ${description}` : description).slice(0, 54);
      const desc = opts.color ? chalk.dim(detail) : detail;
      let row = `${marker} /${hi}${pad}${desc}`;
      if (focused && opts.color) row = chalk.inverse(row);
      return row;
    });
    // Always-visible keybind hint — keeps Tab/Esc/Enter/↑↓ discoverable
    // even on short filtered lists (where the old overflow-only hint never
    // appeared). Adds the count so users know how many commands match.
    const countLabel = matches.length === 1 ? "1 command" : `${matches.length} commands`;
    const overflowLabel = hiddenBefore || hiddenAfter
      ? `  (${hiddenBefore}↑ ${hiddenAfter}↓)`
      : "";
    const hint = `  ${countLabel}${overflowLabel}  ·  ↑↓ focus  Enter run  Tab complete  Esc cancel`;
    lines.push(opts.color ? chalk.dim(hint) : hint);
    cursorTo(process.stderr, 0);
    clearScreenDown(process.stderr);
    process.stderr.write(prompt() + rl.line + "\n");
    for (const line of lines) {
      process.stderr.write(line + "\n");
    }
    moveCursor(process.stderr, 0, -(lines.length + 1));
    cursorTo(process.stderr, promptColumns() + rl.cursor);
  }

  function clearSuggestions(): void {
    if (suggCount === 0) return;
    renderToken++;
    cursorTo(process.stderr, 0);
    clearScreenDown(process.stderr);
    suggCount = 0;
    lastSuggestionKey = "";
    lastSuggestionPartial = "";
    lastSuggestionMatches = [];
    suggestionTop = 0;
    selectedIndex = 0;
    redrawLine();
  }

  // Move the focus cursor by `delta` (±1 from arrows, ±N from PgUp/PgDn).
  // Wraps at the ends so the palette feels like a ring, not a dead-end.
  function moveFocus(delta: number): boolean {
    if (suggCount === 0 || lastSuggestionMatches.length === 0) return false;
    selectedIndex = clampMenuFocus(selectedIndex, delta, lastSuggestionMatches.length);
    lastSuggestionKey = ""; // force a re-render (focus marker moved)
    showSuggestions(lastSuggestionMatches, lastSuggestionPartial);
    return true;
  }

  function scheduleSuggestionRefresh(): void {
    const token = ++renderToken;
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      if (token !== renderToken) return;
      const line = rl.line;
      if (!line.startsWith("/")) {
        clearSuggestions();
        return;
      }
      const partial = line.slice(1);
      showSuggestions(fuzzyFilter(partial), partial);
    }, 0);
  }



  const prompt = () =>
    opts.color
      ? chalk.bold.cyan("❯ ") + chalk.dim(`[${state.model}] `)
      : `[${state.model}] > `;

  const started = state.wasStarted ?? false;
  if (started) {
    process.stderr.write(
      opts.color
        ? chalk.green("  ✓ 9router started automatically\n")
        : "  ✓ 9router started automatically\n"
    );
  }

  process.stderr.write(
    opts.color
      ? chalk.dim("type / for commands\n")
      : "type / for commands\n"
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: prompt(),
    completer: (line: string): [string[], string] => {
      if (!line.startsWith("/")) return [[], line];
      const partial = line.slice(1).toLowerCase();
      return [fuzzyFilter(partial).map(m => "/" + m.name), line];
    },
  });

  if (process.stdin.isTTY) {
    type KpData = { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean };
    type WithKp = { on(ev: "keypress", cb: (s: string | undefined, k: KpData | undefined) => void): void };
    emitKeypressEvents(process.stdin, rl);
    (process.stdin as typeof process.stdin & WithKp).on("keypress", (input, key) => {
      if (pickerActive) return;
      // Enter, when the palette is open and the line is a bare command
      // (no space yet → no args), RUNS the focused command. This turns the
      // menu into a real command palette: `/` ↓ ↓ Enter gets you to
      // /status with zero typing. If a space is present (args mode) or the
      // menu is closed, Enter submits whatever's in the buffer normally.
      if ((key?.name === "return" || key?.name === "enter") && suggCount > 0 && lastSuggestionMatches.length > 0) {
        const partial = rl.line.slice(1);
        if (!partial.includes(" ") && lastSuggestionMatches[selectedIndex]) {
          const focused = `/${lastSuggestionMatches[selectedIndex].name}`;
          clearSuggestions();
          setRlLine(focused);
          rl.write("\n"); // submit through the normal readline line event
          return;
        }
        clearSuggestions();
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        clearSuggestions();
        return;
      }
      // Esc cancels an open slash-command search: close the menu AND drop
      // the leading "/" so the next keystroke doesn't re-trigger fuzzy
      // search. With no menu open, Esc is a no-op (won't destroy typed
      // input). Matches fzf/claude cancel semantics.
      if (key?.name === "escape") {
        if (suggCount > 0) {
          clearSuggestions();
          setRlLine("");
          refreshPrompt();
        } else {
          clearSuggestions();
        }
        return;
      }
      // Tab completes to the FOCUSED command (not just the top match) when
      // the palette is open — the universal "complete" keystroke. If you've
      // moved focus with ↑/↓, Tab honors that choice. Replaces the line
      // with /<cmd><space> and closes the menu so you can type args.
      if (key?.name === "tab" && suggCount > 0 && lastSuggestionMatches.length > 0) {
        const choice = lastSuggestionMatches[Math.min(selectedIndex, lastSuggestionMatches.length - 1)];
        clearSuggestions();
        setRlLine(`/${choice.name} `);
        refreshPrompt();
        return;
      }
      if (key?.ctrl || key?.meta) return;
      // ↑/↓ move the focus cursor; the viewport follows via menuWindow.
      if (key?.name === "down" && moveFocus(1)) return;
      if (key?.name === "up" && moveFocus(-1)) return;
      if ((key?.name === "pagedown" || key?.sequence === "\u001b[6~") && moveFocus(8)) return;
      if ((key?.name === "pageup" || key?.sequence === "\u001b[5~") && moveFocus(-8)) return;
      const navKeys = new Set(["up", "down", "pageup", "pagedown", "left", "right", "tab"]);
      if (key?.name && navKeys.has(key.name)) return;
      // Typing a space dismisses the palette: once you're typing args
      // (e.g. `/switch claude-x`) the menu is useless and Enter should
      // submit literally, not run the top match. Command names have no
      // spaces, so this is the natural mode boundary.
      const typedSpace = typeof input === "string" && input === " ";
      const changedLine = typeof input === "string" && input.length > 0;
      const editingKey = key?.name === "backspace" || key?.name === "delete";
      if (typedSpace && suggCount > 0) {
        clearSuggestions();
        return;
      }
      if (!changedLine && !editingKey) return;
      scheduleSuggestionRefresh();
    });

    // Ctrl+C honors the universal REPL contract: a non-empty line (or an
    // open suggestion menu) is cleared and the prompt refreshed; Ctrl+C on
    // an empty line exits. readline traps Ctrl+C and emits a SIGINT *event*
    // on the interface rather than killing the process, so we own the
    // behavior here.
    rl.on("SIGINT", () => {
      if (suggCount > 0 || rl.line.length > 0) {
        clearSuggestions();
        setRlLine("");
        process.stderr.write("\n");
        refreshPrompt();
      } else {
        process.stderr.write("\n");
        process.exit(0);
      }
    });
  }

  const refreshPrompt = () => {
    rl.setPrompt(prompt());
    rl.prompt();
  };

  function parseSlash(line: string): { cmd: string; args: string[] } {
    const [rawCmd, ...args] = line.slice(1).trim().split(/\s+/);
    return { cmd: rawCmd?.toLowerCase() ?? "", args };
  }

  async function runModelsPicker(args: string[]): Promise<boolean> {
    const filter = args.join(" ").trim();
    const models = filterModels(await fetchModels(state), filter);
    if (!models.length) {
      process.stdout.write(`\n  (no models${filter ? ` matching "${filter}"` : ""})\n`);
      return true;
    }
    const selected = await selectModelFromList(models, filter, state.model, opts.color, (active) => { pickerActive = active; });
    if (!selected) return true;
    const prev = state.model;
    state.model = selected;
    process.stdout.write(`\n  switched: ${prev} → ${selected}\n`);
    return true;
  }

  async function runSwitchPicker(args: string[]): Promise<boolean> {
    const filterOrModel = args.join(" ").trim();
    const allModels = await fetchModels(state);
    if (filterOrModel && allModels.some((m) => m.id === filterOrModel)) {
      const prev = state.model;
      state.model = filterOrModel;
      process.stdout.write(`\n  switched: ${prev} → ${filterOrModel}\n`);
      return true;
    }
    const models = filterModels(allModels, filterOrModel);
    if (!models.length) {
      process.stdout.write(`\n  (no models${filterOrModel ? ` matching "${filterOrModel}"` : ""})\n`);
      return true;
    }
    const selected = await selectModelFromList(models, filterOrModel, state.model, opts.color, (active) => { pickerActive = active; });
    if (!selected) return true;
    const prev = state.model;
    state.model = selected;
    process.stdout.write(`\n  switched: ${prev} → ${selected}\n`);
    return true;
  }

  /** /team <task> — run the multi-role pipeline through the session TUI. */
  async function runTeamCommand(args: string[]): Promise<void> {
    const teamTask = args.join(" ").trim();
    if (!teamTask) {
      process.stdout.write("\n  Usage: /team <task>\n");
      return;
    }
    const compressed = compressUserInput(teamTask);
    replLedger?.beginTurn(compressed.text);
    try {
      await runTeamPipeline(state, withLedger(replLedger, tui), compressed.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(opts.color ? chalk.red(`\n✗ ${msg}\n`) : `\n✗ ${msg}\n`);
    }
  }

  /** /rewind — picker over ledger turns, restore workdir to before one. */
  async function runRewindPicker(): Promise<void> {
    const view = replLedger?.view();
    if (!view || view.turnCount === 0) {
      process.stdout.write("\n  (no turns yet — nothing to rewind)\n");
      return;
    }
    const candidates = view.turns.filter(
      (t) => t.endedAt !== undefined && planRewind(view.turns, t.index).actions.length > 0,
    );
    if (candidates.length === 0) {
      process.stdout.write("\n  (no restorable file changes recorded this session)\n");
      return;
    }
    const items: PickItem[] = candidates
      .slice()
      .reverse()
      .map((t) => {
        const files = t.digest?.files.length ?? 0;
        return {
          id: String(t.index),
          label: `before turn ${t.index} — ${t.task.replace(/\s+/g, " ").slice(0, 48)}`,
          hint: files > 0 ? `${files} file${files === 1 ? "" : "s"}` : undefined,
        };
      });
    const picked = await pickFromList(items, {
      title: "⏪ rewind — restore the workdir to BEFORE which turn?",
      useColor: opts.color,
      onActiveChange: (active) => { pickerActive = active; },
    });
    if (picked === null) return;
    const target = parseInt(picked, 10);
    const plan = planRewind(view.turns, target);
    const result = await applyRewind(plan, state.workDir);
    const lines: string[] = ["", `  ⏪ rewound to before turn ${target}`];
    for (const p of result.restored) lines.push(`  ✓ restored ${p}`);
    for (const p of result.deleted) lines.push(`  ✓ removed  ${p} (created by a rewound turn)`);
    for (const s of result.skipped) lines.push(`  ⚠ skipped  ${s.path} — ${s.reason}`);
    if (result.restored.length + result.deleted.length === 0) {
      lines.push("  (nothing restored)");
    }
    lines.push("  note: conversation history is unchanged — this rewinds files only", "");
    process.stdout.write(lines.map((l) => (opts.color && l.startsWith("  ⚠") ? chalk.yellow(l) : l)).join("\n") + "\n");
  }

  /** /replay [speed] — re-render a recorded run through the live renderer. */
  async function runReplayPicker(args: string[]): Promise<void> {
    const speedArg = args[0]?.replace(/^x/i, "");
    const speed = speedArg && /^\d+(\.\d+)?$/.test(speedArg) ? parseFloat(speedArg) : 2;
    const logs = await listRunLogs(RUNS_DIR);
    if (logs.length === 0) {
      process.stdout.write(`\n  (no recorded runs in ${RUNS_DIR} yet — run a task first)\n`);
      return;
    }
    const items: PickItem[] = logs.slice(0, 30).map((l) => ({
      id: l.path,
      label: `${new Date(l.mtimeMs).toLocaleString()} · ${l.runId}`,
      hint: l.eventCount !== undefined ? `${l.eventCount} events${l.reason ? ` · ${l.reason}` : ""}` : undefined,
    }));
    const picked = await pickFromList(items, {
      title: `▶ replay which run? (x${speed} speed)`,
      useColor: opts.color,
      onActiveChange: (active) => { pickerActive = active; },
    });
    if (picked === null) return;
    const events = await readEventLog(picked);
    if (events.length === 0) {
      process.stdout.write("\n  (event log is empty or unreadable)\n");
      return;
    }
    const banner = `\n  ▶ replay · x${speed} · ${events.length} events · press Esc or q to stop\n`;
    process.stdout.write(opts.color ? chalk.bold.cyan(banner) : banner);
    // Raw abort listener — Esc / q / Ctrl+C stops playback. pickerActive
    // mutes the REPL's own keypress handling for the duration.
    let abort = false;
    pickerActive = true;
    const wasRaw = process.stdin.isRaw ?? false;
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      if (s === "\u001b" || s === "q" || s === "\u0003") abort = true;
      if (s === "\u0003") process.emit("SIGINT");
    };
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    }
    try {
      const { rendered, aborted } = await renderEventLog(events, tui, {
        speed,
        shouldAbort: () => abort,
      });
      const footer = `\n  ▶ replay ${aborted ? "stopped" : "finished"} · ${rendered} events rendered\n`;
      process.stdout.write(opts.color ? chalk.dim(footer) : footer);
    } finally {
      if (process.stdin.isTTY) {
        process.stdin.off("data", onData);
        try { process.stdin.setRawMode(wasRaw); } catch {}
      }
      pickerActive = false;
    }
  }

  refreshPrompt();

  let queue: Promise<void> = Promise.resolve();

  async function processSubmittedInput(rawInput: string): Promise<void> {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      refreshPrompt();
      return;
    }
    if (trimmed === "exit" || trimmed === "quit") {
      process.exit(0);
    }

    if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
      const prevModel = state.model;
      const parsed = parseSlash(trimmed);

      if (parsed.cmd === "models") {
        await runModelsPicker(parsed.args);
        refreshPrompt();
        return;
      }
      if (parsed.cmd === "switch") {
        await runSwitchPicker(parsed.args);
        refreshPrompt();
        return;
      }
      if (parsed.cmd === "team") {
        await runTeamCommand(parsed.args);
        refreshPrompt();
        return;
      }
      if (parsed.cmd === "rewind") {
        await runRewindPicker();
        refreshPrompt();
        return;
      }
      if (parsed.cmd === "replay") {
        await runReplayPicker(parsed.args);
        refreshPrompt();
        return;
      }
      const result = await executeSlashCommand(trimmed, state);
      if (result !== null) {
        process.stderr.write(result);
        if (state.model !== prevModel) {
          process.stderr.write(
            opts.color
              ? chalk.dim(`  (model changed — prompt updated)\n`)
              : `  (model changed — prompt updated)\n`
          );
        }
      }
      refreshPrompt();
      return;
    }

    // Non-slash, non-multiline — just run immediately (legacy direct mode)
    const compressed = compressUserInput(trimmed);
    if (compressed.notices.length > 0) {
      const noticeText = compressed.notices.map((notice) => `  ⧉ ${notice}`).join("\n");
      process.stderr.write((opts.color ? chalk.dim(noticeText) : noticeText) + "\n");
    }

    replLedger?.beginTurn(compressed.text);
    const emit = withLedger(replLedger, tui);
    try {
      const useTeam =
        state.useOrchestrate === true ||
        (shouldSuggestTeam(compressed.text) &&
          (await offerTeamPipeline(state, (active) => { pickerActive = active; })));
      if (useTeam) {
        await runTeamPipeline(state, emit, compressed.text);
      } else {
        const agent = makeAgent(state, emit);
        await agent.run(compressed.text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        opts.color ? chalk.red(`\n✗ ${msg}\n`) : `\n✗ ${msg}\n`
      );
    }
    refreshPrompt();
  }

  const inputCoalescer = new ReplInputCoalescer({
    onSubmit: (input) => {
      queue = queue.then(async () => {
        await processSubmittedInput(input);
      });
    },
  });

  rl.on("line", (line: string) => {
    clearSuggestions();
    inputCoalescer.pushLine(line);
  });

  rl.on("close", () => {
    inputCoalescer.flush();
    void queue.finally(() => process.exit(0));
  });
}

async function runDoctor(state: SessionState): Promise<boolean> {
  const native = state.baseURL.replace(/\/v1\/?$/, "");
async function apiFetch(path: string): Promise<Response> {
      const token = getCliToken();
      const cliHeaders: Record<string, string> = token ? { "x-9r-cli-token": token } : {};
      const bearerHeaders = { Authorization: `Bearer ${effectiveKey}` };
      const headers = Object.keys(cliHeaders).length ? cliHeaders : bearerHeaders;
      return fetch(`${native}${path}`, { headers, signal: AbortSignal.timeout(3000) });
    }

  const storedKey = readFirstApiKey();
  const effectiveKey = storedKey ?? state.apiKey;

  const results = await Promise.allSettled([
    apiFetch("/api/health"),
    apiFetch("/api/version"),
    apiFetch("/api/keys"),
    apiFetch("/api/providers"),
    fetch(`${state.baseURL}/models`, { headers: { Authorization: `Bearer ${effectiveKey}` }, signal: AbortSignal.timeout(3000) }),
  ]);

  const [health, version, keysData, providersData, modelsData] = results;
  const checks: Array<{ label: string; status: "ok" | "fail" | "warn"; msg: string }> = [];
  let allOk = true;

  if (health.status === "fulfilled" && health.value.ok) {
    const json = await health.value.json().catch(() => ({})) as { ok?: boolean };
    checks.push({ label: "9router server", status: json.ok ? "ok" : "fail", msg: json.ok ? `reachable at ${native}` : "unhealthy" });
    if (!json.ok) allOk = false;
  } else {
    const msg = health.status === "rejected" ? String(health.reason) : `HTTP ${(health.value as Response).status}`;
    checks.push({ label: "9router server", status: "fail", msg });
    allOk = false;
  }

  if (version.status === "fulfilled" && version.value.ok) {
    const v = await version.value.json().catch(() => ({})) as { currentVersion?: string; hasUpdate?: boolean };
    const updateHint = v.hasUpdate ? " (update available)" : "";
    checks.push({ label: "version", status: "ok", msg: `${v.currentVersion ?? "?"}${updateHint}` });
  } else {
    checks.push({ label: "version", status: "warn", msg: "could not fetch" });
  }

  let keys: Array<{ id?: unknown }> = [];
  if (keysData.status === "fulfilled" && keysData.value.ok) {
    keys = toArray<{ id?: unknown }>(((await keysData.value.json().catch(() => ({}))) as { keys?: unknown }).keys ?? []);
  }

  if (storedKey && !keys.length) {
    keys = [{ id: "stored" }];
  }

  if (keys.length > 0) {
    checks.push({ label: "API keys", status: "ok", msg: `${keys.length} key(s) configured` });
  } else {
    checks.push({ label: "API keys", status: "fail", msg: "no keys — visit http://127.0.0.1:20128/dashboard to add your key" });
    allOk = false;
  }

  let connections: Array<{ id?: unknown; isActive?: unknown }> = [];
  if (providersData.status === "fulfilled" && providersData.value.ok) {
    connections = toArray<{ id?: unknown; isActive?: unknown }>(((await providersData.value.json().catch(() => ({}))) as { connections?: unknown }).connections ?? []);
  }
  const active = connections.filter((c) => c.isActive !== false);
  if (connections.length > 0) {
    checks.push({ label: "providers", status: active.length > 0 ? "ok" : "warn", msg: `${connections.length} connection(s), ${active.length} active` });
    if (active.length === 0) allOk = false;
  } else {
    checks.push({ label: "providers", status: "fail", msg: "no providers — visit http://127.0.0.1:20128/dashboard to connect one" });
    allOk = false;
  }

  let models: Array<{ id?: unknown }> = [];
  if (modelsData.status === "fulfilled" && modelsData.value.ok) {
    models = toArray<{ id?: unknown }>(((await modelsData.value.json().catch(() => ({}))) as { data?: unknown }).data ?? []).filter((m) => typeof m.id === "string");
  }
  if (models.length > 0 && keys.length > 0 && active.length > 0) {
    checks.push({ label: "models", status: "ok", msg: `${models.length} models available` });
  } else if (models.length > 0) {
    checks.push({
      label: "models",
      status: "warn",
      msg: `${models.length} catalog model(s) visible, but configure an API key and provider to use them`,
    });
    allOk = false;
  } else {
    checks.push({ label: "models", status: "fail", msg: "no models found" });
    allOk = false;
  }

  // Surface whether run_bash actually gets OS-level isolation. On non-darwin
  // (or when sandbox-exec is missing) commands run with full user permissions;
  // on darwin the restrictive profile can also be silently downgraded to
  // allow-all if this host's sandbox-exec rejects it (e.g. the macOS 26 subpath
  // bug). This is a warning, not a failure — the app still runs.
  const sandboxStatus = getSandboxStatus();
  if (sandboxStatus.kind === "unavailable") {
    checks.push({
      label: "sandbox",
      status: "warn",
      msg: `no OS-level isolation — run_bash runs with full user permissions (${sandboxStatus.reason})`,
    });
  } else {
    const profile = new Sandbox({ ...getDefaultSandboxConfig(state.workDir), warnOnProfileFallback: false }).getProfile();
    if (profile === "(version 1)(allow default)") {
      checks.push({ label: "sandbox", status: "warn", msg: "sandbox-exec active but no restrictive profile accepted on this host; isolation degraded to allow-all" });
    } else if (profile.includes("(allow file-read* (subpath")) {
      checks.push({ label: "sandbox", status: "ok", msg: "strict command isolation active (darwin-sandbox-exec)" });
    } else {
      checks.push({ label: "sandbox", status: "ok", msg: "command isolation active; reads unrestricted on this host (macOS 26 workaround), writes + network confined" });
    }
  }

  process.stderr.write("\n  9rh doctor" + (allOk ? " — all checks passed\n\n" : " — issues found\n\n"));
  for (const check of checks) {
    const icon = check.status === "ok" ? (opts.color ? chalk.green("  ok") : "  ok")
      : check.status === "warn" ? (opts.color ? chalk.yellow("  warn") : "  warn")
      : (opts.color ? chalk.red("  fail") : "  fail");
    const label = (opts.color ? chalk.white(check.label.padEnd(16)) : check.label.padEnd(16));
    process.stderr.write(`${icon} ${label} ${check.msg}\n`);
  }
  if (connections.length === 0) {
    process.stderr.write(`\n  -> Open ${opts.color ? chalk.bold.cyan("http://127.0.0.1:20128/dashboard") : "http://127.0.0.1:20128/dashboard"} to connect a provider\n`);
  }
return allOk;
}

const state: SessionState = {
  baseURL: opts.url,
  apiKey: opts.key,
  model: DEFAULTS.model,
  workDir: resolve(opts.dir),
  useColor: opts.color,
  wasStarted: false,
  continuationPolicy: parseContinuationPolicy(),
  queue: [],
  lastReportPath: null, // null = "auto" (write to default). false = disabled. string = override.
  allowSkillInstall: opts.allowSkillInstall === true,
  useOrchestrate: opts.orchestrate === true,
  _runStartMs: undefined,
  _toolCallCount: {},
  ledger: new SessionLedger(),
};

async function main() {
  const argv = process.argv.slice(2);
  const isInit = argv[0] === "init" && argv.length > 0;
  const wantsDoctor = opts.doctor;

  if (isInit) {
    return;
  }

  const userConfig = await readUserConfig();
  const modelWasExplicit = hasOption("-m", "--model") || Boolean(process.env.NINE_ROUTER_MODEL);
  state.model = resolveConfiguredModel(modelWasExplicit ? opts.model : undefined, userConfig);

  // Resolve the report path: --no-report disables; --report-path overrides; else user config; else default.
  if (opts.report === false) {
    state.lastReportPath = false;
  } else if (opts.reportPath) {
    state.lastReportPath = opts.reportPath;
  } else if (userConfig.reportPath) {
    state.lastReportPath = userConfig.reportPath;
  }
  // Pre-load keepReports so makeAgent() can read it without an extra await.
  await loadUserConfigKeepReports();

  if (opts.showConfig) {
    process.stdout.write(JSON.stringify({ ...userConfig, effectiveModel: state.model }, null, 2) + "\n");
    return;
  }

  if (opts.setDefaultModel || opts.setDefaultProvider) {
    let defaultModel = typeof opts.setDefaultModel === "string" ? opts.setDefaultModel.trim() : userConfig.defaultModel;
    if (opts.setDefaultModel === true) {
      const init = await ensureRouter(opts.url, opts.key);
      state.baseURL = init.baseURL;
      state.apiKey = init.apiKey;
      state.wasStarted = init.wasStarted;
      if (init.error) {
        process.stderr.write(opts.color ? chalk.red(`  ✗ ${init.error}\n`) : `  ✗ ${init.error}\n`);
      }
      const models = filterModels(await fetchModels(state), "");
      if (!models.length) {
        process.stderr.write("  no models available to choose from\n");
        return;
      }
      defaultModel = await selectModelFromList(models, "", state.model, opts.color) ?? defaultModel;
      if (!defaultModel) {
        process.stderr.write("  default model unchanged\n");
        return;
      }
    }
    const next = await updateUserConfig({
      defaultModel: defaultModel || userConfig.defaultModel,
      defaultProvider: opts.setDefaultProvider?.trim() || userConfig.defaultProvider,
    });
    const effectiveModel = resolveConfiguredModel(undefined, next);
    process.stderr.write(`  saved defaults: model=${next.defaultModel ?? "(unset)"}, provider=${next.defaultProvider ?? "(unset)"}\n`);
    process.stderr.write(`  effective default model: ${effectiveModel}\n`);
    return;
  }

  if (wantsDoctor) {
    const init = await ensureRouter(opts.url, opts.key);
    state.baseURL = init.baseURL;
    state.apiKey = init.apiKey;
    state.wasStarted = init.wasStarted;
    const ok = await runDoctor(state);
    process.exit(ok ? 0 : 1);
  } else if (opts.repl) {
    ensureRouter(opts.url, opts.key).then(async (init) => {
      state.baseURL = init.baseURL;
      state.apiKey = init.apiKey;
      state.wasStarted = init.wasStarted;
      if (init.error) {
        process.stderr.write(opts.color ? chalk.red(`  ✗ ${init.error}\n`) : `  ✗ ${init.error}\n`);
      }
      // Auto-index the current workspace with CodeGraph if not already done
      await maybeAutoIndexCodeGraph(state.workDir);
      runRepl(state).catch((err) => {
        process.stderr.write(String(err) + "\n");
        process.exit(1);
      });
    }).catch((err) => {
      process.stderr.write(String(err) + "\n");
      process.exit(1);
    });
  } else if (task) {
    ensureRouter(opts.url, opts.key).then((init) => {
      state.baseURL = init.baseURL;
      state.apiKey = init.apiKey;
      state.wasStarted = init.wasStarted;
      if (init.error) {
        process.stderr.write(opts.color ? chalk.red(`  ✗ ${init.error}\n`) : `  ✗ ${init.error}\n`);
      }
      runTask(state, task).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(opts.color ? chalk.red(`\n✗ ${msg}\n`) : `\n✗ ${msg}\n`);
        process.exit(1);
      });
    }).catch((err) => {
      process.stderr.write(String(err) + "\n");
      process.exit(1);
    });
  } else {
    ensureRouter(opts.url, opts.key).then((init) => {
      state.baseURL = init.baseURL;
      state.apiKey = init.apiKey;
      state.wasStarted = init.wasStarted;
      if (init.error) {
        process.stderr.write(opts.color ? chalk.red(`  ✗ ${init.error}\n`) : `  ✗ ${init.error}\n`);
      }
      runRepl(state).catch((err) => {
        process.stderr.write(String(err) + "\n");
        process.exit(1);
      });
    }).catch((err) => {
      process.stderr.write(String(err) + "\n");
      process.exit(1);
    });
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
