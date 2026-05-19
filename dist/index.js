#!/usr/bin/env node
import { createInterface, cursorTo, emitKeypressEvents, moveCursor, clearScreenDown, clearLine } from "readline";
import { resolve } from "path";
import { program } from "commander";
import chalk from "chalk";
import { Agent } from "./agent.js";
import { executeSlashCommand, fetchModels, filterModels, toArray, getSlashCommands } from "./commands.js";
import { ensureRouter, readFirstApiKey, getCliToken } from "./init.js";
import { createTuiRenderer, printSplash } from "./tui.js";
import { compressUserInput } from "./inputCompression.js";
import { ReplInputCoalescer } from "./replInput.js";
import { readUserConfig, resolveConfiguredModel, updateUserConfig } from "./config.js";
const DEFAULTS = {
    url: process.env.NINE_ROUTER_URL ?? "http://localhost:20128/v1",
    key: process.env.NINE_ROUTER_KEY ?? "9router",
    model: process.env.NINE_ROUTER_MODEL ?? "kr/claude-sonnet-4.5",
    continuationModel: process.env.NINE_ROUTER_CONTINUATION_MODEL,
    continuationMax: process.env.NINE_ROUTER_CONTINUATION_MAX ?? process.env.NINE_ROUTER_MAX_CONTINUATIONS,
    continuationIter: process.env.NINE_ROUTER_CONTINUATION_ITER,
    continuationSwitchAfter: process.env.NINE_ROUTER_CONTINUATION_SWITCH_AFTER,
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
    .option("--continue-model <model>", "Model or 9router combo to use after max iterations", DEFAULTS.continuationModel)
    .option("--continue-max <n>", "Maximum continuation rounds", DEFAULTS.continuationMax)
    .option("--continue-iter <n>", "Iterations per continuation round", DEFAULTS.continuationIter)
    .option("--continue-switch-after <n>", "Continuation round that triggers model switch", DEFAULTS.continuationSwitchAfter)
    .option("--repl", "Start interactive REPL session")
    .option("--no-color", "Disable colored output")
    .option("--set-default-model [model]", "Persist a default model for future runs; omit model to pick from the model list")
    .option("--set-default-provider <provider>", "Persist a default provider/prefix for future runs")
    .option("--show-config", "Show persisted 9rh defaults and exit")
    .option("--doctor", "Run pre-flight diagnostics and exit");
const rawArgs = process.argv.slice(2);
const isInit = rawArgs[0] === "init";
if (!isInit) {
    program.parse();
}
const opts = program.opts();
const task = program.args[0];
function hasOption(...names) {
    return rawArgs.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}
if (isInit) {
    const rawArgs = process.argv.slice(2);
    const initArgv = rawArgs.slice(1).filter((a) => !a.startsWith("-"));
    const initOpts = rawArgs.slice(1).filter((a) => a.startsWith("-"));
    const quiet = initOpts.includes("--quiet") || initOpts.includes("-q");
    const log = (msg) => { if (!quiet)
        process.stderr.write(msg + "\n"); };
    if (initOpts.includes("--update") || initOpts.includes("-U")) {
        log(chalk.blue("  Updating 9rh via npm..."));
        import("child_process").then(({ execFileSync }) => {
            try {
                execFileSync("npm", ["install", "-g", "9rh@latest"], { stdio: "inherit" });
                log(chalk.green("  ✓ 9rh updated"));
            }
            catch {
                log(chalk.red("  ✗ Update failed"));
            }
            process.exit(0);
        });
    }
    else if (initOpts.includes("--update-router")) {
        log(chalk.blue("  Updating 9router via npm..."));
        import("child_process").then(({ execFileSync }) => {
            try {
                execFileSync("npm", ["install", "-g", "9router@latest"], { stdio: "inherit" });
                log(chalk.green("  ✓ 9router updated"));
            }
            catch {
                log(chalk.red("  ✗ Update failed"));
            }
            process.exit(0);
        });
    }
    else if (initOpts.includes("--install")) {
        log(chalk.blue("  Initializing 9router..."));
        ensureRouter(DEFAULTS.url, DEFAULTS.key).then((init) => {
            if (init.error) {
                log(chalk.red(`  ✗ ${init.error}`));
                process.exit(1);
            }
            log(chalk.green("  ✓ 9router ready at http://localhost:20128"));
            process.exit(0);
        }).catch((err) => { log(chalk.red(`  ✗ ${err.message}`)); process.exit(1); });
    }
    else if (initArgv.length === 0) {
        log(chalk.blue("  9router is ready — run `9rh --doctor` to verify"));
        process.exit(0);
    }
    else {
        log(chalk.red("  Unknown init option"));
        process.exit(1);
    }
}
function parsePositiveInt(raw, label) {
    if (raw === undefined || raw === "")
        return undefined;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1) {
        process.stderr.write(`${label} must be a positive integer, got: ${raw}\n`);
        process.exit(1);
    }
    return n;
}
function parseMaxIter() {
    return parsePositiveInt(opts.maxIter, "--max-iter") ?? DEFAULTS.maxIter;
}
function parseContinuationPolicy() {
    const hasContinuationConfig = Boolean(opts.continueModel || opts.continueMax || opts.continueIter || opts.continueSwitchAfter);
    if (!hasContinuationConfig)
        return undefined;
    const maxContinuations = parsePositiveInt(opts.continueMax, "--continue-max") ?? 1;
    const iterationsPerContinuation = parsePositiveInt(opts.continueIter, "--continue-iter");
    const switchAfter = parsePositiveInt(opts.continueSwitchAfter, "--continue-switch-after") ?? 1;
    const policy = { maxContinuations };
    if (iterationsPerContinuation !== undefined)
        policy.iterationsPerContinuation = iterationsPerContinuation;
    if (opts.continueModel) {
        policy.modelSwitch = { toModel: opts.continueModel, afterContinuations: switchAfter };
    }
    return policy;
}
function makeAgent(state, onEvent) {
    return new Agent({
        baseURL: state.baseURL,
        apiKey: state.apiKey,
        model: state.model,
        maxIterations: parseMaxIter(),
        workDir: state.workDir,
        onEvent,
        continuationPolicy: state.continuationPolicy,
    });
}
async function runTask(state, t) {
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
async function selectModelFromList(models, filter, currentModel, useColor, onActiveChange) {
    if (!process.stdin.isTTY || !process.stderr.isTTY || models.length === 0)
        return null;
    const visibleRows = Math.max(6, Math.min(14, (process.stderr.rows ?? 24) - 8));
    let selected = Math.max(0, models.findIndex((model) => model.id === currentModel));
    if (selected < 0)
        selected = 0;
    let top = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), Math.max(0, models.length - visibleRows)));
    let renderedLines = 0;
    let done = false;
    let result = null;
    const input = process.stdin;
    function clampSelection() {
        selected = Math.max(0, Math.min(models.length - 1, selected));
        if (selected < top)
            top = selected;
        if (selected >= top + visibleRows)
            top = selected - visibleRows + 1;
        top = Math.max(0, Math.min(top, Math.max(0, models.length - visibleRows)));
    }
    function clearRender() {
        if (renderedLines === 0)
            return;
        moveCursor(process.stderr, 0, -renderedLines);
        cursorTo(process.stderr, 0);
        clearScreenDown(process.stderr);
        renderedLines = 0;
    }
    function line(text) {
        const width = Math.max(40, (process.stderr.columns ?? 80) - 2);
        return text.length > width ? text.slice(0, width - 1) + "…" : text;
    }
    function render() {
        clearRender();
        const shown = models.slice(top, top + visibleRows);
        const title = `${models.length} model(s)${filter ? ` matching "${filter}"` : ""}`;
        const help = "↑/↓ scroll  PgUp/PgDn jump  wheel scroll  Enter select  Esc cancel";
        const lines = [
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
            if (useColor)
                row = focused ? chalk.inverse(row) : active ? chalk.cyan(row) : row;
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
    function move(delta) {
        selected += delta;
        clampSelection();
        render();
    }
    function finish(value) {
        done = true;
        result = value;
        clearRender();
    }
    return await new Promise((resolve) => {
        const wasRaw = input.isRaw;
        const onData = (chunk) => {
            const s = chunk.toString("utf8");
            if (s === "\u0003") {
                finish(null);
                process.emit("SIGINT");
            }
            else if (s === "\r" || s === "\n") {
                finish(models[selected]?.id ?? null);
            }
            else if (s === "\u001b" || s === "\u001b[27~") {
                finish(null);
            }
            else if (s === "\u001b[A") {
                move(-1);
            }
            else if (s === "\u001b[B") {
                move(1);
            }
            else if (s === "\u001b[5~") {
                move(-visibleRows);
            }
            else if (s === "\u001b[6~") {
                move(visibleRows);
            }
            else if (/\u001b\[<64;\d+;\d+[mM]/u.test(s)) {
                move(-3);
            }
            else if (/\u001b\[<65;\d+;\d+[mM]/u.test(s)) {
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
async function runRepl(state) {
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
    function fuzzyScore(pattern, target) {
        if (!pattern)
            return 1;
        const p = pattern.toLowerCase();
        const t = target.toLowerCase();
        let pi = 0;
        for (let ti = 0; ti < t.length && pi < p.length; ti++) {
            if (p[pi] === t[ti])
                pi++;
        }
        return pi === p.length ? pi : 0;
    }
    function fuzzyFilter(partial) {
        if (!partial)
            return ALL_CMDS;
        return ALL_CMDS
            .map(c => ({ c, score: fuzzyScore(partial, c.name) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ c }) => c);
    }
    function highlightMatch(name, partial) {
        if (!partial || !opts.color)
            return opts.color ? chalk.dim(name) : name;
        const p = partial.toLowerCase();
        let pi = 0;
        let out = "";
        for (let ti = 0; ti < name.length; ti++) {
            if (pi < p.length && name[ti].toLowerCase() === p[pi]) {
                out += chalk.bold.cyan(name[ti]);
                pi++;
            }
            else {
                out += chalk.dim(name[ti]);
            }
        }
        return out;
    }
    let suggCount = 0;
    let lastSuggestionKey = "";
    let suggestionTop = 0;
    let lastSuggestionPartial = "";
    let lastSuggestionMatches = [];
    let renderToken = 0;
    let renderQueued = false;
    let pickerActive = false;
    function stripAnsi(text) {
        return text.replace(/\x1B\[[0-9;]*m/g, "");
    }
    function promptColumns() {
        const visible = stripAnsi(prompt());
        return visible.length;
    }
    function redrawLine() {
        cursorTo(process.stderr, 0);
        clearLine(process.stderr, 0);
        process.stderr.write(prompt() + rl.line);
        cursorTo(process.stderr, promptColumns() + rl.cursor);
    }
    function showSuggestions(matches, partial) {
        const visibleRows = Math.max(4, Math.min(12, (process.stderr.rows ?? 24) - 8));
        if (partial !== lastSuggestionPartial)
            suggestionTop = 0;
        suggestionTop = Math.max(0, Math.min(suggestionTop, Math.max(0, matches.length - visibleRows)));
        const items = matches.slice(suggestionTop, suggestionTop + visibleRows);
        const key = `${partial}|${suggestionTop}|${items.map((m) => m.name).join(";")}`;
        if (key === lastSuggestionKey)
            return;
        if (items.length === 0) {
            clearSuggestions();
            return;
        }
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
    function clearSuggestions() {
        if (suggCount === 0)
            return;
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
    function scrollSuggestions(delta) {
        if (suggCount === 0 || lastSuggestionMatches.length === 0)
            return false;
        suggestionTop += delta;
        lastSuggestionKey = "";
        showSuggestions(lastSuggestionMatches, lastSuggestionPartial);
        return true;
    }
    function scheduleSuggestionRefresh() {
        const token = ++renderToken;
        if (renderQueued)
            return;
        renderQueued = true;
        setTimeout(() => {
            renderQueued = false;
            if (token !== renderToken)
                return;
            const line = rl.line;
            if (!line.startsWith("/")) {
                clearSuggestions();
                return;
            }
            const partial = line.slice(1);
            showSuggestions(fuzzyFilter(partial), partial);
        }, 0);
    }
    const prompt = () => opts.color
        ? chalk.bold.cyan("❯ ") + chalk.dim(`[${state.model}] `)
        : `[${state.model}] > `;
    const started = state.wasStarted ?? false;
    if (started) {
        process.stderr.write(opts.color
            ? chalk.green("  ✓ 9router started automatically\n")
            : "  ✓ 9router started automatically\n");
    }
    process.stderr.write(opts.color
        ? chalk.dim("type / for commands\n")
        : "type / for commands\n");
    const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        prompt: prompt(),
        completer: (line) => {
            if (!line.startsWith("/"))
                return [[], line];
            const partial = line.slice(1).toLowerCase();
            return [fuzzyFilter(partial).map(m => "/" + m.name), line];
        },
    });
    if (process.stdin.isTTY) {
        emitKeypressEvents(process.stdin, rl);
        process.stdin.on("keypress", (input, key) => {
            if (pickerActive)
                return;
            if (key?.name === "return" || key?.name === "enter") {
                clearSuggestions();
                return;
            }
            if (key?.name === "escape") {
                clearSuggestions();
                return;
            }
            if (key?.ctrl || key?.meta)
                return;
            if (key?.name === "down" && scrollSuggestions(1))
                return;
            if (key?.name === "up" && scrollSuggestions(-1))
                return;
            if ((key?.name === "pagedown" || key?.sequence === "\u001b[6~") && scrollSuggestions(8))
                return;
            if ((key?.name === "pageup" || key?.sequence === "\u001b[5~") && scrollSuggestions(-8))
                return;
            const navKeys = new Set(["up", "down", "pageup", "pagedown", "left", "right", "tab"]);
            if (key?.name && navKeys.has(key.name))
                return;
            const changedLine = typeof input === "string" && input.length > 0;
            const editingKey = key?.name === "backspace" || key?.name === "delete";
            if (!changedLine && !editingKey)
                return;
            scheduleSuggestionRefresh();
        });
    }
    const refreshPrompt = () => {
        rl.setPrompt(prompt());
        rl.prompt();
    };
    function parseSlash(line) {
        const [rawCmd, ...args] = line.slice(1).trim().split(/\s+/);
        return { cmd: rawCmd?.toLowerCase() ?? "", args };
    }
    async function runModelsPicker(args) {
        const filter = args.join(" ").trim();
        const models = filterModels(await fetchModels(state), filter);
        if (!models.length) {
            process.stdout.write(`\n  (no models${filter ? ` matching "${filter}"` : ""})\n`);
            return true;
        }
        const selected = await selectModelFromList(models, filter, state.model, opts.color, (active) => { pickerActive = active; });
        if (!selected)
            return true;
        const prev = state.model;
        state.model = selected;
        process.stdout.write(`\n  switched: ${prev} → ${selected}\n`);
        return true;
    }
    refreshPrompt();
    let queue = Promise.resolve();
    async function processSubmittedInput(rawInput) {
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
                process.stderr.write(result);
                if (state.model !== prevModel) {
                    process.stderr.write(opts.color
                        ? chalk.dim(`  (model changed — prompt updated)\n`)
                        : `  (model changed — prompt updated)\n`);
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(opts.color ? chalk.red(`\n✗ ${msg}\n`) : `\n✗ ${msg}\n`);
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
    rl.on("line", (line) => {
        clearSuggestions();
        inputCoalescer.pushLine(line);
    });
    rl.on("close", () => {
        inputCoalescer.flush();
        void queue.finally(() => process.exit(0));
    });
}
async function runDoctor(state) {
    const native = state.baseURL.replace(/\/v1\/?$/, "");
    async function apiFetch(path) {
        const token = getCliToken();
        const cliHeaders = token ? { "x-9r-cli-token": token } : {};
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
    const checks = [];
    let allOk = true;
    if (health.status === "fulfilled" && health.value.ok) {
        const json = await health.value.json().catch(() => ({}));
        checks.push({ label: "9router server", status: json.ok ? "ok" : "fail", msg: json.ok ? `reachable at ${native}` : "unhealthy" });
        if (!json.ok)
            allOk = false;
    }
    else {
        const msg = health.status === "rejected" ? String(health.reason) : `HTTP ${health.value.status}`;
        checks.push({ label: "9router server", status: "fail", msg });
        allOk = false;
    }
    if (version.status === "fulfilled" && version.value.ok) {
        const v = await version.value.json().catch(() => ({}));
        const updateHint = v.hasUpdate ? " (update available)" : "";
        checks.push({ label: "version", status: "ok", msg: `${v.currentVersion ?? "?"}${updateHint}` });
    }
    else {
        checks.push({ label: "version", status: "warn", msg: "could not fetch" });
    }
    let keys = [];
    if (keysData.status === "fulfilled" && keysData.value.ok) {
        keys = toArray((await keysData.value.json().catch(() => ({}))).keys ?? []);
    }
    if (storedKey && !keys.length) {
        keys = [{ id: "stored" }];
    }
    if (keys.length > 0) {
        checks.push({ label: "API keys", status: "ok", msg: `${keys.length} key(s) configured` });
    }
    else {
        checks.push({ label: "API keys", status: "fail", msg: "no keys — visit http://localhost:20128/dashboard to add your key" });
        allOk = false;
    }
    let connections = [];
    if (providersData.status === "fulfilled" && providersData.value.ok) {
        connections = toArray((await providersData.value.json().catch(() => ({}))).connections ?? []);
    }
    const active = connections.filter((c) => c.isActive !== false);
    if (connections.length > 0) {
        checks.push({ label: "providers", status: active.length > 0 ? "ok" : "warn", msg: `${connections.length} connection(s), ${active.length} active` });
        if (active.length === 0)
            allOk = false;
    }
    else {
        checks.push({ label: "providers", status: "fail", msg: "no providers — visit http://localhost:20128/dashboard to connect one" });
        allOk = false;
    }
    let models = [];
    if (modelsData.status === "fulfilled" && modelsData.value.ok) {
        models = toArray((await modelsData.value.json().catch(() => ({}))).data ?? []).filter((m) => typeof m.id === "string");
    }
    if (models.length > 0 && keys.length > 0 && active.length > 0) {
        checks.push({ label: "models", status: "ok", msg: `${models.length} models available` });
    }
    else if (models.length > 0) {
        checks.push({
            label: "models",
            status: "warn",
            msg: `${models.length} catalog model(s) visible, but configure an API key and provider to use them`,
        });
        allOk = false;
    }
    else {
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
const state = {
    baseURL: opts.url,
    apiKey: opts.key,
    model: DEFAULTS.model,
    workDir: resolve(opts.dir),
    useColor: opts.color,
    wasStarted: false,
    continuationPolicy: parseContinuationPolicy(),
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
    }
    else if (opts.repl) {
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
    else if (task) {
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
    }
    else {
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
//# sourceMappingURL=index.js.map