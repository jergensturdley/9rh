#!/usr/bin/env node
import { createInterface, cursorTo, emitKeypressEvents, moveCursor, clearScreenDown } from "readline";
import { resolve } from "path";
import { program } from "commander";
import chalk from "chalk";
import { Agent, type AgentEvent } from "./agent.js";
import { executeSlashCommand, fetchModels, filterModels, type ModelInfo, type SessionState, toArray, getSlashCommands } from "./commands.js";
import { ensureRouter, readFirstApiKey, getCliToken } from "./init.js";
import { createTuiRenderer, printSplash } from "./tui.js";
import { compressUserInput } from "./inputCompression.js";
import { ReplInputCoalescer } from "./replInput.js";

const DEFAULTS = {
  url: process.env.NINE_ROUTER_URL ?? "http://localhost:20128/v1",
  key: process.env.NINE_ROUTER_KEY ?? "9router",
  model: process.env.NINE_ROUTER_MODEL ?? "kr/claude-sonnet-4.5",
  maxIter: 100,
};

program
  .name("9rh")
  .description("Coding agent harness for 9router")
  .version("1.0.0")
  .argument("[task]", "Task for the agent to perform")
  .option("-m, --model <model>", "Model to use (e.g. kr/claude-sonnet-4.5)", DEFAULTS.model)
  .option("-u, --url <url>", "9router API URL", DEFAULTS.url)
  .option("-k, --key <key>", "9router API key", DEFAULTS.key)
  .option("-d, --dir <dir>", "Working directory", process.cwd())
  .option("-i, --max-iter <n>", "Max agent iterations", String(DEFAULTS.maxIter))
  .option("--repl", "Start interactive REPL session")
  .option("--no-color", "Disable colored output")
  .option("--doctor", "Run pre-flight diagnostics and exit");

const rawArgs = process.argv.slice(2);
const isInit = rawArgs[0] === "init";

if (!isInit) {
  program.parse();
}

const opts = program.opts<{
  model: string;
  url: string;
  key: string;
  dir: string;
  maxIter: string;
  repl: boolean;
  color: boolean;
  doctor: boolean;
}>();

const task = program.args[0];

if (isInit) {
  const rawArgs = process.argv.slice(2);
  const initArgv = rawArgs.slice(1).filter((a: string) => !a.startsWith("-"));
  const initOpts = rawArgs.slice(1).filter((a: string) => a.startsWith("-"));
  const quiet = initOpts.includes("--quiet") || initOpts.includes("-q");
  const log = (msg: string) => { if (!quiet) process.stderr.write(msg + "\n"); };

  if (initOpts.includes("--update") || initOpts.includes("-U")) {
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
  } else if (initOpts.includes("--update-router")) {
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
  } else if (initOpts.includes("--install")) {
    log(chalk.blue("  Initializing 9router..."));
    ensureRouter(DEFAULTS.url, DEFAULTS.key).then((init) => {
      if (init.error) { log(chalk.red(`  ✗ ${init.error}`)); process.exit(1); }
      log(chalk.green("  ✓ 9router ready at http://localhost:20128"));
      process.exit(0);
    }).catch((err) => { log(chalk.red(`  ✗ ${err.message}`)); process.exit(1); });
  } else if (initArgv.length === 0) {
    log(chalk.blue("  9router is ready — run `9rh --doctor` to verify"));
    process.exit(0);
  } else {
    log(chalk.red("  Unknown init option"));
    process.exit(1);
  }
}

function parseMaxIter(): number {
  const n = parseInt(opts.maxIter, 10);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`--max-iter must be a positive integer, got: ${opts.maxIter}\n`);
    process.exit(1);
  }
  return n;
}

function makeAgent(state: SessionState, onEvent: (e: AgentEvent) => void) {
  return new Agent({
    baseURL: state.baseURL,
    apiKey: state.apiKey,
    model: state.model,
    maxIterations: parseMaxIter(),
    workDir: state.workDir,
    onEvent,
  });
}


async function runTask(state: SessionState, t: string): Promise<void> {
  const tui = createTuiRenderer({
    getModel: () => state.model,
    getWorkDir: () => state.workDir,
    getBaseURL: () => state.baseURL,
    getStartedByRouter: () => state.wasStarted,
    useColor: state.useColor,
  });
  const agent = makeAgent(state, tui);
  const compressed = compressUserInput(t);
  if (compressed.notices.length > 0) {
    process.stderr.write(compressed.notices.map((notice) => `  ⧉ ${notice}`).join("\n") + "\n");
  }
  await agent.run(compressed.text);
}

async function runRepl(state: SessionState): Promise<void> {
  const tui = createTuiRenderer({
    getModel: () => state.model,
    getWorkDir: () => state.workDir,
    getBaseURL: () => state.baseURL,
    getStartedByRouter: () => state.wasStarted,
    useColor: state.useColor,
  });

  const nativeBase = state.baseURL.replace(/\/v1\/?$/, "");
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

  function promptColumns(): number {
    const cols = process.stdout.columns ?? 80;
    const modelLen = state.model.length;
    return Math.min(cols - 1, opts.color ? 2 + modelLen + 3 : modelLen + 4);
  }

  function redrawLine(): void {
    cursorTo(process.stderr, 0);
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
      const more = `  ↑/↓ scroll${hiddenBefore ? `  ${hiddenBefore} above` : ""}${hiddenAfter ? `  ${hiddenAfter} below` : ""}`;
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
      const navKeys = new Set(["up", "down", "left", "right", "tab"]);
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

  async function selectModel(models: ModelInfo[], filter: string): Promise<string | null> {
    if (!process.stdin.isTTY || !process.stderr.isTTY || models.length === 0) return null;

    const visibleRows = Math.max(6, Math.min(14, (process.stderr.rows ?? 24) - 8));
    let selected = Math.max(0, models.findIndex((model) => model.id === state.model));
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

    function move(delta: number): void {
      selected += delta;
      clampSelection();
      render();
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
      const help = "↑/↓ scroll  wheel scroll  Enter select  Esc cancel";
      const lines: string[] = [
        "",
        opts.color ? chalk.bold.cyan(`  ${title}`) : `  ${title}`,
        opts.color ? chalk.dim(`  ${help}`) : `  ${help}`,
        "",
      ];
      for (let i = 0; i < shown.length; i++) {
        const index = top + i;
        const model = shown[i];
        const active = model.id === state.model;
        const focused = index === selected;
        const marker = focused ? "›" : active ? "▶" : " ";
        const owner = model.owned_by ? `  [${model.owned_by}]` : "";
        let row = `  ${marker} ${model.id}${owner}`;
        if (opts.color) {
          row = focused ? chalk.inverse(row) : active ? chalk.cyan(row) : row;
        }
        lines.push(line(row));
      }
      if (top + visibleRows < models.length) lines.push(opts.color ? chalk.dim("  …") : "  …");
      process.stderr.write(lines.join("\n") + "\n");
      renderedLines = lines.length;
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
          pickerActive = false;
          resolve(result);
        }
      };

      pickerActive = true;
      input.setRawMode(true);
      input.resume();
      process.stderr.write("\x1b[?1000h\x1b[?1006h");
      input.on("data", onData);
      render();
    });
  }

  async function runModelsPicker(args: string[]): Promise<boolean> {
    const filter = args.join(" ").trim();
    const models = filterModels(await fetchModels(state), filter);
    if (!models.length) {
      process.stdout.write(`\n  (no models${filter ? ` matching "${filter}"` : ""})\n`);
      return true;
    }
    const selected = await selectModel(models, filter);
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
      if (parsed.cmd === "models") {
        await runModelsPicker(parsed.args);
        refreshPrompt();
        return;
      }
      const result = await executeSlashCommand(trimmed, state);
      if (result !== null) {
        process.stdout.write(result);
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
    checks.push({ label: "API keys", status: "fail", msg: "no keys — visit http://localhost:20128/dashboard to add your key" });
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
    checks.push({ label: "providers", status: "fail", msg: "no providers — visit http://localhost:20128/dashboard to connect one" });
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

  process.stderr.write("\n  9rh doctor" + (allOk ? " — all checks passed\n\n" : " — issues found\n\n"));
  for (const check of checks) {
    const icon = check.status === "ok" ? (opts.color ? chalk.green("  ok") : "  ok")
      : check.status === "warn" ? (opts.color ? chalk.yellow("  warn") : "  warn")
      : (opts.color ? chalk.red("  fail") : "  fail");
    const label = (opts.color ? chalk.white(check.label.padEnd(16)) : check.label.padEnd(16));
    process.stderr.write(`${icon} ${label} ${check.msg}\n`);
  }
  if (connections.length === 0) {
    process.stderr.write(`\n  -> Open ${opts.color ? chalk.bold.cyan("http://localhost:20128/dashboard") : "http://localhost:20128/dashboard"} to connect a provider\n`);
  }
return allOk;
}

const state: SessionState = {
  baseURL: opts.url,
  apiKey: opts.key,
  model: opts.model,
  workDir: resolve(opts.dir),
  useColor: opts.color,
  wasStarted: false,
};

async function main() {
  const argv = process.argv.slice(2);
  const isInit = argv[0] === "init" && argv.length > 0;
  const wantsDoctor = opts.doctor;

  if (isInit) {
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
