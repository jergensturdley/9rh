#!/usr/bin/env node
import { createInterface } from "readline";
import { resolve } from "path";
import { program } from "commander";
import chalk from "chalk";
import { Agent, type AgentEvent } from "./agent.js";
import { executeSlashCommand, type SessionState } from "./commands.js";
import { ensureRouter, readFirstApiKey } from "./init.js";
import { toArray } from "./commands.js";

const DEFAULTS = {
  url: process.env.NINE_ROUTER_URL ?? "http://localhost:20128/v1",
  key: process.env.NINE_ROUTER_KEY ?? "9router",
  model: process.env.NINE_ROUTER_MODEL ?? "kr/claude-sonnet-4.5",
  maxIter: 30,
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

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "iteration":
      process.stderr.write(
        chalk.dim(`\n[iter ${event.current}/${event.max}]\n`)
      );
      break;
    case "thinking":
      process.stdout.write(opts.color ? chalk.white(event.text) : event.text);
      break;
    case "tool_call": {
      const argsStr = JSON.stringify(event.args, null, 2);
      process.stdout.write(
        "\n" +
          (opts.color
            ? chalk.cyan(`⚙ ${event.name}`) + chalk.dim(` ${argsStr}`)
            : `⚙ ${event.name} ${argsStr}`) +
          "\n"
      );
      break;
    }
    case "tool_result": {
      const lines = event.output.split("\n").slice(0, 20);
      const truncated =
        event.output.split("\n").length > 20 ? "\n…(truncated)" : "";
      const out = lines.join("\n") + truncated;
      if (event.error) {
        process.stdout.write(
          opts.color ? chalk.red(`✗ ${event.error}\n${out}\n`) : `✗ ${event.error}\n${out}\n`
        );
      } else {
        process.stdout.write(
          opts.color ? chalk.green(`✓ `) + chalk.dim(out) + "\n" : `✓ ${out}\n`
        );
      }
      break;
    }
    case "done":
      process.stdout.write("\n");
      break;
    case "error":
      process.stderr.write(
        opts.color ? chalk.red(`\n⚠ ${event.message}\n`) : `\n⚠ ${event.message}\n`
      );
      break;
  }
}

async function runTask(state: SessionState, t: string): Promise<void> {
  if (opts.color) {
    process.stderr.write(
      chalk.bold.blue(`\n9rh`) +
        chalk.dim(` → ${state.model} @ ${state.baseURL}\n`) +
        chalk.dim(`dir: ${state.workDir}\n\n`)
    );
  }
  const agent = makeAgent(state, renderEvent);
  await agent.run(t);
}

async function runRepl(state: SessionState): Promise<void> {
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
      ? chalk.bold.blue("9rh REPL") +
          chalk.dim(" — type /help for commands, 'exit' to quit\n")
      : "9rh REPL — type /help for commands, 'exit' to quit\n"
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: prompt(),
  });

  const refreshPrompt = () => {
    rl.setPrompt(prompt());
    rl.prompt();
  };

  refreshPrompt();

  let queue: Promise<void> = Promise.resolve();

  rl.on("line", (line: string) => {
    queue = queue.then(async () => {
      const trimmed = line.trim();
      if (!trimmed) {
        refreshPrompt();
        return;
      }
      if (trimmed === "exit" || trimmed === "quit") {
        process.exit(0);
      }

      if (trimmed.startsWith("/")) {
        const prevModel = state.model;
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

      const agent = makeAgent(state, renderEvent);
      try {
        await agent.run(trimmed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          opts.color ? chalk.red(`\n✗ ${msg}\n`) : `\n✗ ${msg}\n`
        );
      }
      refreshPrompt();
    });
  });

  rl.on("close", () => process.exit(0));
}

async function runDoctor(state: SessionState): Promise<boolean> {
  const native = state.baseURL.replace(/\/v1\/?$/, "");
  const userKey = state.apiKey;
  const adminKey = "9router";

  async function apiFetch(path: string, key: string): Promise<Response> {
    return fetch(`${native}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
  }

  const storedKey = readFirstApiKey();
  const effectiveKey = storedKey ?? userKey;

  const results = await Promise.allSettled([
    apiFetch("/api/health", effectiveKey),
    apiFetch("/api/version", effectiveKey),
    apiFetch("/api/keys", effectiveKey),
    apiFetch("/api/providers", effectiveKey),
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
  } else if (storedKey) {
    checks.push({ label: "providers", status: "ok", msg: "configured (key stored)" });
  } else {
    checks.push({ label: "providers", status: "fail", msg: "no providers — visit http://localhost:20128/dashboard to connect one" });
    allOk = false;
  }

  let models: Array<{ id?: unknown }> = [];
  if (modelsData.status === "fulfilled" && modelsData.value.ok) {
    models = toArray<{ id?: unknown }>(((await modelsData.value.json().catch(() => ({}))) as { data?: unknown }).data ?? []).filter((m) => typeof m.id === "string");
  }
  if (models.length > 0) {
    checks.push({ label: "models", status: "ok", msg: `${models.length} models available` });
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
  const wantsDoctor = argv.includes("--doctor") || argv.includes("-d");

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
    program.help();
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
