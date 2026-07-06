#!/usr/bin/env node
import { createInterface, cursorTo, emitKeypressEvents, moveCursor, clearScreenDown, clearLine } from "readline";
import { resolve } from "path";
import { program } from "commander";
import chalk from "chalk";
import { Agent, type AgentEvent, type ContinuationPolicy, type ToolApprovalRequest, type ToolApprovalDecision } from "./agent.js";
import { executeSlashCommand, fetchModels, filterModels, type ModelInfo, type SessionState, toArray, getSlashCommands } from "./commands.js";
import { ensureRouter, readFirstApiKey, getCliToken } from "./init.js";
import { createTuiRenderer, printSplash } from "./tui.js";
import { detectBackend, getProviderPreset, listProviderPresetIds, type Backend } from "./backends/index.js";
import { compressUserInput } from "./inputCompression.js";
import { ReplInputCoalescer } from "./replInput.js";
import { readUserConfig, resolveConfiguredModel, updateUserConfig } from "./config.js";
import { showSpinner, hideSpinner, pulseQueueBadge, showRightStats, hideRightStats, refreshStatusLine, formatStats, type StatsSnapshot } from "./ui.js";
import { existsSync, statSync } from "fs";
import { spawn } from "child_process";
import { Orchestrator, type OrchestratorEvent } from "./orchestrator/index.js";
import { shouldUseOrchestrator } from "./orchestrator/dispatch.js";
import {
  hasOption as hasOptionRaw,
  resolveMaxIter,
  buildContinuationPolicy,
  classifyInitCommand,
} from "./cliArgs.js";
import { Sandbox, getSandboxStatus, getDefaultSandboxConfig } from "./sandbox/index.js";

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

const DEFAULTS = {
  url: process.env.NINE_ROUTER_URL ?? "http://127.0.0.1:20128/v1",
  key: process.env.NINE_ROUTER_KEY ?? "9router",
  model: process.env.NINE_ROUTER_MODEL ?? "kr/claude-sonnet-4.5",
  continuationModel: process.env.NINE_ROUTER_CONTINUATION_MODEL,
  continuationMax: process.env.NINE_ROUTER_CONTINUATION_MAX ?? process.env.NINE_ROUTER_MAX_CONTINUATIONS ?? "20",
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
  .option("--orchestrate", "Route the task through the multi-role Orchestrator pipeline (architect → implementer → security audit → test strategist → reviewer loop) instead of the streaming Agent loop. Without this flag, dispatch falls back to the heuristic in `shouldUseOrchestrator`.");

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
    log(chalk.blue("  Updating 9rh via npm..."));
    import("child_process").then(({ execFileSync }) => {
      try {
        execFileSync("npm", ["install", "-g", "9rh@latest"], { stdio: "inherit" });
        log(chalk.green("  ✓ 9rh updated"));
      } catch {
        log(chalk.red("  ✗ Update failed"));
      }
      process.exit(0);
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
  });
}


/**
 * Telemetry — one-line stderr log per OrchestratorEvent so the user can
 * follow the multi-role pipeline in real time without the TUI plumbing.
 */
function emitOrchestratorTelemetry(useColor: boolean, event: OrchestratorEvent): void {
  let line = "";
  switch (event.type) {
    case "role_start":
      line = `▸ ${event.role}`;
      break;
    case "role_complete":
      line = `✓ ${event.role}`;
      break;
    case "role_skip":
      line = `⊘ ${event.role} (${event.reason})`;
      break;
    case "conflict":
      line = `⚠ conflict resolved: ${event.resolution}`;
      break;
    case "cache_hit":
      line = `↻ ${event.role} (cache hit)`;
      break;
    case "escalation":
      line = `↑ escalated: ${event.reason}`;
      break;
    case "task_complete":
      line = `done · ${event.status}`;
      break;
    case "task_failed":
      line = `✗ failed · ${event.error}`;
      break;
  }
  if (!line) return;
  const prefix = "  ";
  if (useColor) process.stderr.write(prefix + chalk.dim(line) + "\n");
  else process.stderr.write(prefix + line + "\n");
}

async function runTask(state: SessionState, t: string): Promise<void> {
  const compressed = compressUserInput(t);
  if (compressed.notices.length > 0) {
    process.stderr.write(compressed.notices.map((notice) => `  ⧉ ${notice}`).join("\n") + "\n");
  }

  // Path A — wire Orchestrator.orchestrate into CLI dispatch when the
  // gate decides the task is structured enough to benefit from the
  // multi-role pipeline (architect → implementer → security audit →
  // test strategist → reviewer loop).
  if (shouldUseOrchestrator(compressed.text, { force: state.useOrchestrate === true })) {
    const orchestrator = new Orchestrator({
      baseURL: state.baseURL,
      apiKey: state.apiKey,
      model: state.model,
      workDir: state.workDir,
      onEvent: (event) => emitOrchestratorTelemetry(state.useColor, event),
    });
    const result = await orchestrator.orchestrate(compressed.text);
    // Map OrchestratorResult → final-response shape (string). The REPL
    // downstream just prints whatever runTask emits; we write a short
    // banner plus the summary so users can see the pipeline output.
    process.stdout.write(`\n  orchestrator\n`);
    process.stdout.write(`${result.summary}\n`);
    return;
  }

  // Streaming Agent loop (default).
  const tui = createTuiRenderer({
    getModel: () => state.model,
    getWorkDir: () => state.workDir,
    getBaseURL: () => state.baseURL,
    getStartedByRouter: () => state.wasStarted,
    useColor: state.useColor,
    onReportWritten: (path) => { state.lastReportPath = path; },
  });
  const agent = makeAgent(state, tui);
  await agent.run(compressed.text);
}

async function selectModelFromList(
  models: ModelInfo[],
  filter: string,
  currentModel: string,
  useColor: boolean,
  onActiveChange?: (active: boolean) => void,
): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || models.length === 0) return null;

  const visibleRows = Math.max(6, Math.min(14, (process.stderr.rows ?? 24) - 8));
  let selected = Math.max(0, models.findIndex((model) => model.id === currentModel));
  if (selected < 0) selected = 0;
  let top = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), Math.max(0, models.length - visibleRows)));
  let renderedLines = 0;
  let done = false;
  let result: string | null = null;
  const input = process.stdin;

  function clampSelection(): void {
    selected = Math.max(0, Math.min(models.length - 1, selected));
    if (selected < top) top = selected;
    if (selected >= top + visibleRows) top = selected - visibleRows + 1;
    top = Math.max(0, Math.min(top, Math.max(0, models.length - visibleRows)));
  }

  function clearRender(): void {
    if (renderedLines === 0) return;
    moveCursor(process.stderr, 0, -renderedLines);
    cursorTo(process.stderr, 0);
    clearScreenDown(process.stderr);
    renderedLines = 0;
  }

  function line(text: string): string {
    const width = Math.max(40, (process.stderr.columns ?? 80) - 2);
    return text.length > width ? text.slice(0, width - 1) + "…" : text;
  }

  function render(): void {
    clearRender();
    const shown = models.slice(top, top + visibleRows);
    const title = `${models.length} model(s)${filter ? ` matching "${filter}"` : ""}`;
    const help = "↑/↓ scroll  PgUp/PgDn jump  wheel scroll  Enter select  Esc cancel";
    const lines: string[] = [
      "",
      useColor ? chalk.bold.cyan(`  ${title}`) : `  ${title}`,
      useColor ? chalk.dim(`  ${help}`) : `  ${help}`,
      "",
    ];
    for (let i = 0; i < shown.length; i++) {
      const index = top + i;
      const model = shown[i];
      const active = model.id === currentModel;
      const focused = index === selected;
      const marker = focused ? "›" : active ? "▶" : " ";
      const owner = model.owned_by ? `  [${model.owned_by}]` : "";
      let row = `  ${marker} ${model.id}${owner}`;
      if (useColor) row = focused ? chalk.inverse(row) : active ? chalk.cyan(row) : row;
      lines.push(line(row));
    }
    const hiddenBefore = top;
    const hiddenAfter = Math.max(0, models.length - top - shown.length);
    if (hiddenBefore || hiddenAfter) {
      lines.push(useColor ? chalk.dim(`  ${hiddenBefore} above, ${hiddenAfter} below`) : `  ${hiddenBefore} above, ${hiddenAfter} below`);
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
        finish(models[selected]?.id ?? null);
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
        input.setRawMode(wasRaw);
        onActiveChange?.(false);
        resolve(result);
      }
    };

    onActiveChange?.(true);
    input.setRawMode(true);
    input.resume();
    process.stderr.write("\x1b[?1000h\x1b[?1006h");
    input.on("data", onData);
    render();
  });
}

async function runRepl(state: SessionState): Promise<void> {
  const tui = createTuiRenderer({
    getModel: () => state.model,
    getWorkDir: () => state.workDir,
    getBaseURL: () => state.baseURL,
    getStartedByRouter: () => state.wasStarted,
    useColor: state.useColor,
    onReportWritten: (path) => { state.lastReportPath = path; },
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

  function fuzzyFilter(partial: string): Array<{ name: string; description: string }> {
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
  let lastSuggestionMatches: Array<{ name: string; description: string }> = [];
  let renderToken = 0;
  let renderQueued = false;
  let pickerActive = false;

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

  function showSuggestions(
    matches: Array<{ name: string; description: string }>,
    partial: string,
  ): void {
    const visibleRows = Math.max(4, Math.min(12, (process.stderr.rows ?? 24) - 8));
    if (partial !== lastSuggestionPartial) suggestionTop = 0;
    suggestionTop = Math.max(0, Math.min(suggestionTop, Math.max(0, matches.length - visibleRows)));
    const items = matches.slice(suggestionTop, suggestionTop + visibleRows);
    const key = `${partial}|${suggestionTop}|${items.map((m) => m.name).join(";")}`;
    if (key === lastSuggestionKey) return;
    if (items.length === 0) { clearSuggestions(); return; }
    const hiddenBefore = suggestionTop;
    const hiddenAfter = Math.max(0, matches.length - suggestionTop - items.length);
    const hasOverflow = hiddenBefore > 0 || hiddenAfter > 0;
    suggCount = items.length + (hasOverflow ? 1 : 0);
    lastSuggestionKey = key;
    lastSuggestionPartial = partial;
    lastSuggestionMatches = matches;
    const maxLen = Math.max(...items.map(i => i.name.length));
    const lines = items.map(({ name, description }) => {
      const hi = highlightMatch(name, partial);
      const pad = " ".repeat(Math.max(1, maxLen - name.length + 2));
      const desc = opts.color ? chalk.dim(description.slice(0, 44)) : description.slice(0, 44);
      return `  /${hi}${pad}${desc}`;
    });
    if (hasOverflow) {
      const more = `  ↑/↓ scroll  PgUp/PgDn jump${hiddenBefore ? `  ${hiddenBefore} above` : ""}${hiddenAfter ? `  ${hiddenAfter} below` : ""}`;
      lines.push(opts.color ? chalk.dim(more) : more);
    }
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
    redrawLine();
  }

  function scrollSuggestions(delta: number): boolean {
    if (suggCount === 0 || lastSuggestionMatches.length === 0) return false;
    suggestionTop += delta;
    lastSuggestionKey = "";
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
      if (key?.name === "return" || key?.name === "enter") {
        clearSuggestions();
        return;
      }
      if (key?.name === "escape") {
        clearSuggestions();
        return;
      }
      if (key?.ctrl || key?.meta) return;
      if (key?.name === "down" && scrollSuggestions(1)) return;
      if (key?.name === "up" && scrollSuggestions(-1)) return;
      if ((key?.name === "pagedown" || key?.sequence === "\u001b[6~") && scrollSuggestions(8)) return;
      if ((key?.name === "pageup" || key?.sequence === "\u001b[5~") && scrollSuggestions(-8)) return;
      const navKeys = new Set(["up", "down", "pageup", "pagedown", "left", "right", "tab"]);
      if (key?.name && navKeys.has(key.name)) return;
      const changedLine = typeof input === "string" && input.length > 0;
      const editingKey = key?.name === "backspace" || key?.name === "delete";
      if (!changedLine && !editingKey) return;
      scheduleSuggestionRefresh();
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

      // /run — flush the queue
      if (parsed.cmd === "run") {
        if (!state.queue.length) {
          process.stderr.write("\n  No queued messages. Type lines first, then /run.\n");
          refreshPrompt();
          return;
        }
        const fullInput = state.queue.join("\n");
        state.queue = [];
        hideRightStats();

        const compressed = compressUserInput(fullInput);
        if (compressed.notices.length > 0) {
          process.stderr.write(compressed.notices.map((notice) => `  ⧉ ${notice}`).join("\n") + "\n");
        }

        state._runStartMs = Date.now();
        state._toolCallCount = {};
        const agent = makeAgent(state, tui);
        try {
          await agent.run(compressed.text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(opts.color ? chalk.red(`\n✗ ${msg}\n`) : `\n✗ ${msg}\n`);
        }
        refreshPrompt();
        return;
      }

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

    const agent = makeAgent(state, tui);
    try {
      await agent.run(compressed.text);
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
    const probe = new Sandbox({ ...getDefaultSandboxConfig(state.workDir), warnOnProfileFallback: false });
    const degraded = probe.getProfile() === "(version 1)(allow default)";
    checks.push(
      degraded
        ? { label: "sandbox", status: "warn", msg: "sandbox-exec active but restrictive profile rejected on this host; strict isolation degraded to allow-all" }
        : { label: "sandbox", status: "ok", msg: "strict command isolation active (darwin-sandbox-exec)" },
    );
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
