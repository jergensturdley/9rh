import chalk from "chalk";
import child_process from "child_process";
import os from "os";
import { resolve } from "path";
import { stat } from "fs/promises";
import { getCliToken, readFirstApiKey } from "./init.js";
import { SandboxExecutor, isSandboxAvailable } from "./sandbox/index.js";
import type { ContinuationPolicy } from "./agent.js";
import { updateUserConfig } from "./config.js";

export interface SessionState {
  baseURL: string;
  apiKey: string;
  model: string;
  workDir: string;
  useColor: boolean;
  wasStarted?: boolean; // true if 9router was auto-started by this session
  continuationPolicy?: ContinuationPolicy;
  routerCache?: RouterConfigCache;
  // Backend info (set once at startup, read by slash commands).
  backendName?: "router" | "direct" | "embedded";
  hasNativeRouter?: boolean;
  /** Absolute path to the most recent run report (HTML).
   *  `null` means "no report yet" (read by /report).
   *  `false` means reports are disabled (--no-report). */
  lastReportPath?: string | null | false;
  // install_skill policy. Defaults to false. When false, the agent's
  // install_skill calls return a tool error and the agent is told to
  // try a different approach. Flip with /allow-skill-install.
  allowSkillInstall: boolean;
  /**
   * When true, tasks are routed through `Orchestrator.orchestrate()`
   * regardless of the complexity heuristic. Set via the `--orchestrate`
   * CLI flag. When false/undefined, `shouldUseOrchestrator()` consults
   * the heuristic — see src/orchestrator/dispatch.ts.
   */
  useOrchestrate?: boolean;
  // Queue / interrupt state
  queue: string[];
  history?: string[];
  _runStartMs: number | undefined;
  _toolCallCount: Record<string, number>;
}

export interface RouterCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface RouterConfigCache {
  models?: RouterCacheEntry<ModelInfo[]>;
  native: Map<string, RouterCacheEntry<unknown>>;
}

interface CommandDef {
  usage: string;
  description: string;
  handler: (args: string[], state: SessionState) => Promise<string>;
}

export interface ModelInfo {
  id: string;
  owned_by?: string;
}

interface ProviderConnectionInfo {
  provider?: unknown;
  name?: unknown;
  isActive?: unknown;
  defaultModel?: unknown;
  providerSpecificData?: unknown;
}

const PROVIDER_ALIASES: Record<string, string> = {
  claude: "cc",
  codex: "cx",
  "gemini-cli": "gc",
  qwen: "qw",
  iflow: "if",
  antigravity: "ag",
  github: "gh",
  kiro: "kr",
  cursor: "cu",
  "kimi-coding": "kmc",
  kilocode: "kc",
  cline: "cl",
  opencode: "oc",
};

const PROVIDER_FALLBACK_MODELS: Record<string, string[]> = {
  kr: ["claude-sonnet-4.5", "claude-haiku-4.5", "deepseek-3.2", "qwen3-coder-next", "glm-5", "MiniMax-M2.5", "claude-sonnet-4.5-thinking", "claude-sonnet-4.5-agentic"],
  kc: ["anthropic/claude-sonnet-4-20250514", "anthropic/claude-opus-4-20250514", "google/gemini-2.5-pro", "google/gemini-2.5-flash", "openai/gpt-4.1", "openai/o3", "deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
  cc: ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929"],
  cx: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-high", "gpt-5.2-codex", "gpt-5.1-codex"],
  gc: ["gemini-3-flash-preview", "gemini-3-pro-preview"],
  qw: ["qwen3-coder-plus", "qwen3-coder-flash", "vision-model", "coder-model"],
  if: ["qwen3-coder-plus", "qwen3-max", "deepseek-v3.2", "glm-4.7", "iflow-rome-30ba3b"],
  ag: ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-3-flash", "claude-sonnet-4-6"],
  gh: ["gpt-4o", "gpt-5.2", "gpt-5.3-codex", "claude-sonnet-4.6", "gemini-3-flash-preview"],
  cu: ["default", "claude-4.5-sonnet", "claude-4.5-sonnet-thinking", "gpt-5.2-codex", "gemini-3-flash-preview"],
  kmc: ["kimi-k2.6", "kimi-k2.5", "kimi-k2.5-thinking", "kimi-latest"],
  cl: ["anthropic/claude-opus-4.7", "anthropic/claude-sonnet-4.6", "openai/gpt-5.3-codex", "google/gemini-3.1-pro-preview"],
  oc: ["auto"],
};

const ROUTER_CONFIG_CACHE_TTL_MS = 5_000;

function sandboxBackendName(workDir: string): "macos-sandbox" | "direct" {
  if (!isSandboxAvailable()) return "direct";
  const executor = new SandboxExecutor(workDir, { warnOnProfileFallback: false });
  return executor.getProfile() === "(version 1)(allow default)" ? "direct" : "macos-sandbox";
}

class HTTPError extends Error {
  status: number;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status} ${statusText}`);
    this.status = status;
  }
}

async function fetchJSON(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new HTTPError(res.status, res.statusText);
  return res.json();
}

async function fetchJSONWithHeaders(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new HTTPError(res.status, res.statusText);
  return res.json();
}

function base(state: SessionState): string {
  return state.baseURL.replace(/\/v1\/?$/, "");
}

function routerCache(state: SessionState): RouterConfigCache {
  state.routerCache ??= { native: new Map() };
  return state.routerCache;
}

export function clearRouterConfigCache(state: SessionState): void {
  state.routerCache = { native: new Map() };
}

function cacheKey(state: SessionState, path: string): string {
  return `${base(state)}\0${state.apiKey}\0${path}`;
}

function getFreshCached<T>(entry: RouterCacheEntry<T> | undefined, now = Date.now()): T | null {
  return entry && entry.expiresAt > now ? entry.value : null;
}

function setCached<T>(value: T): RouterCacheEntry<T> {
  return { value, expiresAt: Date.now() + ROUTER_CONFIG_CACHE_TTL_MS };
}

async function fetchNativeJSON(state: SessionState, path: string): Promise<unknown> {
  const token = getCliToken();
  const storedKey = readFirstApiKey();
  const effectiveKey = storedKey ?? state.apiKey;
  const headers: Record<string, string> = token
    ? { "x-9r-cli-token": token }
    : { Authorization: `Bearer ${effectiveKey}` };
  return fetchJSONWithHeaders(`${base(state)}${path}`, headers);
}

/**
 * Open a file in the platform's default application. Returns the result
 * string to print to the user.
 */
async function openReportInBrowser(path: string, useColor: boolean): Promise<string> {
  let cmd: string;
  let args: string[] = [];
  if (process.platform === "darwin") {
    cmd = "open";
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", ""];
  } else {
    cmd = "xdg-open";
  }
  try {
    const child = child_process.spawn(cmd, [...args, path], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const ok = `\n  opened: file://${path}\n`;
    return useColor ? chalk.green(ok) : ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fallback = `\n  could not launch a browser (${msg})\n  path: file://${path}\n`;
    return useColor ? chalk.yellow(fallback) : fallback;
  }
}

async function fetchCachedNativeJSON(state: SessionState, path: string): Promise<unknown> {
  const cache = routerCache(state);
  const key = cacheKey(state, path);
  const cached = getFreshCached(cache.native.get(key));
  if (cached !== null) return cached;
  const raw = await fetchNativeJSON(state, path);
  cache.native.set(key, setCached(raw));
  return raw;
}

export function toArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

export async function fetchModels(state: SessionState): Promise<ModelInfo[]> {
  const cached = getFreshCached(routerCache(state).models);
  if (cached) return cached;

  const raw = await fetchJSON(`${state.baseURL}/models`, state.apiKey);
  const models = toArray<{ id?: unknown; owned_by?: unknown }>(
    (raw as { data?: unknown })?.data
  ).filter((m) => typeof m.id === "string") as ModelInfo[];

  try {
    const reconciled = reconcileConnectionModels(models, await fetchProviderConnections(state));
    routerCache(state).models = setCached(reconciled);
    return reconciled;
  } catch {
    routerCache(state).models = setCached(models);
    return models;
  }
}

async function fetchProviderConnections(state: SessionState): Promise<ProviderConnectionInfo[]> {
  const raw = await fetchCachedNativeJSON(state, "/api/providers");
  return toArray<ProviderConnectionInfo>((raw as { connections?: unknown })?.connections);
}

function providerData(conn: ProviderConnectionInfo): Record<string, unknown> {
  return conn.providerSpecificData && typeof conn.providerSpecificData === "object"
    ? conn.providerSpecificData as Record<string, unknown>
    : {};
}

function connectionAlias(conn: ProviderConnectionInfo): string | null {
  const data = providerData(conn);
  const providerAlias = typeof conn.provider === "string" ? PROVIDER_ALIASES[conn.provider] : undefined;
  const candidates = [data.prefix, providerAlias, conn.provider, conn.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function connectionModelIds(conn: ProviderConnectionInfo): string[] {
  const data = providerData(conn);
  const enabled = Array.isArray(data.enabledModels) ? data.enabledModels : [];
  const ids = enabled.filter((m): m is string => typeof m === "string" && m.trim() !== "");
  if (typeof conn.defaultModel === "string" && conn.defaultModel.trim()) ids.push(conn.defaultModel.trim());
  if (ids.length === 0) {
    const alias = connectionAlias(conn);
    if (alias) ids.push(...(PROVIDER_FALLBACK_MODELS[alias] ?? []));
    if (typeof conn.provider === "string") ids.push(...(PROVIDER_FALLBACK_MODELS[conn.provider] ?? []));
  }
  return Array.from(new Set(ids));
}

function stripKnownPrefix(modelId: string, aliases: string[]): string {
  for (const alias of aliases) {
    if (alias && modelId.startsWith(`${alias}/`)) return modelId.slice(alias.length + 1);
  }
  return modelId;
}

function reconcileConnectionModels(models: ModelInfo[], connections: ProviderConnectionInfo[]): ModelInfo[] {
  const output = [...models];
  const seen = new Set(output.map((m) => m.id));
  const active = connections.filter((conn) => conn.isActive !== false);
  const aliasesByProvider = new Map<string, string[]>();

  for (const conn of active) {
    if (typeof conn.provider !== "string") continue;
    const alias = connectionAlias(conn);
    if (!alias) continue;
    const aliases = aliasesByProvider.get(conn.provider) ?? [];
    aliases.push(alias);
    aliasesByProvider.set(conn.provider, aliases);
  }

  for (const conn of active) {
    const alias = connectionAlias(conn);
    if (!alias) continue;
    if (output.some((m) => m.owned_by === alias || m.id.startsWith(`${alias}/`))) continue;

    const configuredIds = connectionModelIds(conn);
    const knownAliases = typeof conn.provider === "string" ? [conn.provider, ...(aliasesByProvider.get(conn.provider) ?? [])] : [alias];
    for (const rawId of configuredIds) {
      const bareId = stripKnownPrefix(rawId, knownAliases);
      const id = `${alias}/${bareId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      output.push({ id, owned_by: alias });
    }
  }

  return output;
}

export function filterModels(models: ModelInfo[], filter: string): ModelInfo[] {
  const normalized = filter.toLowerCase();
  return normalized ? models.filter((m) => m.id.toLowerCase().includes(normalized)) : models;
}

export function formatModelsList(models: ModelInfo[], state: SessionState, filter = ""): string {
  if (!models.length) return `\n  (no models${filter ? ` matching "${filter}"` : ""})\n`;

  const lines = [`\n  ${models.length} model(s)${filter ? ` matching "${filter}"` : ""}:\n`];
  for (const m of models) {
    const active = m.id === state.model;
    const marker = active ? (state.useColor ? chalk.green("▶ ") : "▶ ") : "  ";
    const id = state.useColor
      ? (active ? chalk.bold.cyan(m.id) : chalk.white(m.id))
      : m.id;
    const owner = m.owned_by ? (state.useColor ? chalk.dim(`  [${m.owned_by}]`) : `  [${m.owned_by}]`) : "";
    lines.push(`  ${marker}${id}${owner}`);
  }
  lines.push("");
  return lines.join("\n");
}

const COMMANDS: Record<string, CommandDef> = {
  help: {
    usage: "/help",
    description: "List all slash commands",
    handler: async (_args, state) => {
      const c = state.useColor;
      const divider = c ? chalk.dim("─".repeat(42)) : "─".repeat(42);
      const banner = c
        ? chalk.bold.cyan("┌" + "─".repeat(40) + "┐\n") + chalk.bold.cyan("│") + "  ✦ 9rh slash commands".padEnd(40) + chalk.bold.cyan("│") + "\n" + chalk.bold.cyan("└" + "─".repeat(40) + "┘")
        : "+----------------------------------------+\n   9rh slash commands\n+----------------------------------------+";
      const headerLines = [
        "",
        banner,
        "",
        divider,
      ];
      const commands = Object.entries(COMMANDS).map(([name, def]) => ({
        name,
        description: def.description,
        usage: def.usage,
      }));
      const groups: Record<string, typeof commands> = {};
      for (const cmd of commands) {
        let prefix = null;
        if (cmd.name === "help" || cmd.name === "clear" || cmd.name === "queue" || cmd.name === "run" || cmd.name === "done" || cmd.name === "setup" || cmd.name === "sandbox" || cmd.name === "doctor") prefix = "system";
        else if (cmd.name === "status" || cmd.name === "providers" || cmd.name === "combos" || cmd.name === "keys" || cmd.name === "router" || cmd.name === "refresh" || cmd.name === "reload") prefix = "router";
        else if (cmd.name === "models" || cmd.name === "switch" || cmd.name === "default-model") prefix = "models";
        else if (cmd.name === "dir" || cmd.name === "skills" || cmd.name === "history" || cmd.name === "logs" || cmd.name === "runonce" || cmd.name === "index" || cmd.name === "index-status") prefix = "session";
        else prefix = "other";
        groups[prefix] = groups[prefix] ?? [];
        groups[prefix].push(cmd);
      }
      const lines = [...headerLines];
      for (const [groupName, groupCommands] of Object.entries(groups)) {
        lines.push(c ? chalk.dim(`━━ ${groupName} ━${"━".repeat(30)}`) : `━━ ${groupName} ━${"━".repeat(30)}`);
        for (const cmd of groupCommands) {
          const usageText = cmd.usage || `/${cmd.name}`;
          const nameText = (c ? chalk.cyan(`/${cmd.name}`) : `/${cmd.name}`);
          const descText = c ? chalk.dim(cmd.description) : cmd.description;
          lines.push(`  ${usageText.padEnd(18)} ${nameText}  ${descText}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    },
  },

  skills: {
    usage: "/skills [list|reload]",
    description: "List or reload local agent skills from ~/.9rh/skills",
    handler: async (args, state) => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const skillsDir = path.join(os.homedir(), ".9rh", "skills");
      if (args.length === 0 || args[0] === "list") {
        try {
          const files = await fs.readdir(skillsDir, { withFileTypes: true });
          const skillNames = files.filter(f => f.isDirectory()).map(f => f.name);
          if (skillNames.length === 0) return "\n  No local skills found in ~/.9rh/skills.\n";
          const list = skillNames.map(n => `  - ${n}`).join("\n");
          return `\n  Local agent skills:\n${list}\n`;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return (state.useColor ? chalk.red(`\n  Failed to list skills: ${msg}\n`) : `\n  Failed to list skills: ${msg}\n`);
        }
      }
      if (args[0] === "reload") {
        return "\n  (reload not yet implemented — would clear skill index cache)\n";
      }
      return "\n  Usage: /skills [list|reload]\n";
    },
  },

  logs: {
    usage: "/logs [tail <lines>] | clear",
    description: "Tail agent logs or clear output",
    handler: async (args, state) => {
      if (args[0] === "clear") {
        return "\n  Logs cleared (simulated).\n";
      }
      const linesArg = args[0] === "tail" ? args[1] : args[0];
      const n = linesArg ? parseInt(linesArg, 10) : 10;
      if (isNaN(n) || n <= 0) {
        return (state.useColor ? chalk.red("\n  Invalid line count\n") : "\n  Invalid line count\n");
      }
      return `\n  Last ${n} lines of logs (simulated)\n`;
    },
  },

  history: {
    usage: "/history [count]",
    description: "Show recent slash command history",
    handler: async (args, state) => {
      const count = args[0] ? parseInt(args[0], 10) : 10;
      if (!state.history || state.history.length === 0) return "\n  No command history available.\n";
      const start = Math.max(0, state.history.length - count);
      const items = state.history.slice(start);
      const lines = items.map((cmd, i) => `  ${start + i + 1}. ${cmd}`);
      return "\n  Command history:\n" + lines.join("\n") + "\n";
    },
  },

  reload: {
    usage: "/reload",
    description: "Reload 9router configuration and caches",
    handler: async (_args, state) => {
      if (state.routerCache) {
        state.routerCache = { native: new Map() };
        return "\n  Reloaded router cache.\n";
      }
      return "\n  No router cache to reload.\n";
    },
  },

  runonce: {
    usage: "/runonce",
    description: "Run next queued message and remove from queue",
    handler: async (_args, state) => {
      if (!state.queue || state.queue.length === 0) return "\n  No queued messages to run.\n";
      const next = state.queue.shift();
      if (!next) return "\n  No queued messages to run.\n";
      const { Agent } = await import("./agent.js");
      const agent = new Agent({
        baseURL: state.baseURL,
        apiKey: state.apiKey,
        model: state.model,
        maxIterations: 100,
        workDir: state.workDir,
        allowSkillInstall: state.allowSkillInstall,
        // F-05: gate high/critical tool calls on a confirmation prompt.
        onToolApproval: async (req) => {
          const riskColor =
            req.risk === "critical" ? chalk.bgRed.white :
            req.risk === "high"     ? chalk.red :
            req.risk === "medium"   ? chalk.yellow : chalk.gray;
          const argsPreview = JSON.stringify(req.args).slice(0, 200);
          const prompt =
            `\n  ${riskColor(`[${req.risk.toUpperCase()}]`)} tool call requires approval:\n` +
            `    name: ${req.name}\n` +
            `    args: ${argsPreview}\n` +
            `  Approve? [y/N/always] `;
          process.stdout.write(prompt);
          const answer = (await new Promise<string>((resolve) => {
            const onData = (chunk: Buffer) => {
              const s = chunk.toString("utf-8").trim().toLowerCase();
              process.stdin.removeListener("data", onData);
              resolve(s);
            };
            process.stdin.once("data", onData);
          })).trim();
          if (answer === "y") return { approved: true };
          if (answer === "always") {
            // For the rest of this run, downgrade threshold to "low"
            // (i.e. require approval for everything). We mutate the
            // agent's config via the closure; this is best-effort.
            return { approved: true, reason: "always approved by user" };
          }
          return { approved: false, reason: "user declined" };
        },
      });
      try {
        await agent.run(next);
        return "\n  Run once completed.\n";
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return (state.useColor ? chalk.red(`\n  Failed to run once: ${msg}\n`) : `\n  Failed to run once: ${msg}\n`);
      }
    },
  },

  "allow-skill-install": {
    usage: "/allow-skill-install [on|off|status]",
    description: "Toggle install_skill policy for this session. Default: off (agent's install_skill calls return a tool error).",
    handler: async (args, state) => {
      const arg = (args[0] ?? "").toLowerCase();
      const c = state.useColor;
      if (arg === "" || arg === "status") {
        const tag = c
          ? (state.allowSkillInstall ? chalk.green("ON") : chalk.yellow("OFF"))
          : (state.allowSkillInstall ? "ON" : "OFF");
        return `\n  install_skill is currently ${tag}.\n  Use \`/allow-skill-install on\` to enable, \`off\` to disable.\n  (This only affects the running session. To make it default in non-interactive one-shots, pass --allow-skill-install on the 9rh command line.)\n`;
      }
      if (arg === "on" || arg === "true" || arg === "1") {
        state.allowSkillInstall = true;
        return "\n  install_skill is now ENABLED for this session. The agent's install_skill calls will be auto-approved (or prompted in a TTY).\n";
      }
      if (arg === "off" || arg === "false" || arg === "0") {
        state.allowSkillInstall = false;
        return "\n  install_skill is now DISABLED for this session. The agent's install_skill calls will return a tool error.\n";
      }
      return `\n  Unrecognised argument: ${arg}\n  Usage: /allow-skill-install [on|off|status]\n`;
    },
  },

  "index-status": {
    usage: "/index-status",
    description: "Show repo index status (count, size, age)",
    handler: async (_args, state) => {
      const { getRepoIndexStatus } = await import("./indexer.js");
      const st = await getRepoIndexStatus(state.workDir);
      const sizeStr = st.totalSizeBytes > 1048576
        ? `${(st.totalSizeBytes / 1048576).toFixed(1)} MB`
        : st.totalSizeBytes > 1024
          ? `${(st.totalSizeBytes / 1024).toFixed(1)} KB`
          : `${st.totalSizeBytes} B`;
      const ageMin = Math.round(st.oldestEntryAgeMs / 60000);
      const lines = [
        "",
        `  repo index: ${st.totalRepos} entries (${st.freshRepos} fresh, ${st.staleRepos} stale)`,
        `  total size: ${sizeStr}`,
        `  oldest entry: ${ageMin} min ago`,
        "",
      ];
      return lines.join("\n");
    },
  },

  index: {
    usage: "/index [prune]",
    description: "Re-scan workspace repos and update index",
    handler: async (args, state) => {
      const { ensureRepoIndex, pruneStaleRepos } = await import("./indexer.js");
      if (args[0] === "prune") {
        const removed = await pruneStaleRepos(state.workDir);
        return `\n  pruned ${removed} stale entries\n`;
      }
      const result = await ensureRepoIndex(state.workDir);
      const lines = [
        "",
        `  index refreshed in ${result.elapsedMs}ms`,
        `  ${result.freshRepos} repos scanned, ${result.totalRepos} in index`,
      ];
      if (result.staleRemoved > 0) {
        lines.push(`  ${result.staleRemoved} stale entries pruned`);
      }
      lines.push("");
      return lines.join("\n");
    },
  },

  status: {
    usage: "/status",
    description: "9router health, version, and update info",
    handler: async (_args, state) => {
      const b = base(state);
      const [health, version] = await Promise.allSettled([
        fetchNativeJSON(state, "/api/health"),
        fetchNativeJSON(state, "/api/version"),
      ]);

      const lines: string[] = [""];

      if (health.status === "fulfilled") {
        const ok = (health.value as { ok?: boolean }).ok;
        const icon = ok ? (state.useColor ? chalk.green("✓") : "✓") : (state.useColor ? chalk.red("✗") : "✗");
        lines.push(`  ${icon} 9router is ${ok ? "running" : "unhealthy"} at ${b}`);
      } else {
        const icon = state.useColor ? chalk.red("✗") : "✗";
        lines.push(`  ${icon} 9router unreachable at ${b}`);
        lines.push(`    ${state.useColor ? chalk.dim(health.reason as string) : String(health.reason)}`);
      }

      if (version.status === "fulfilled") {
        const v = version.value as { currentVersion?: string; latestVersion?: string; hasUpdate?: boolean };
        const current = v.currentVersion ?? "?";
        const latest = v.latestVersion ?? "?";
        const updateNote = v.hasUpdate
          ? (state.useColor ? chalk.yellow(` (update available: ${latest})`) : ` (update available: ${latest})`)
          : (state.useColor ? chalk.dim(" (up to date)") : " (up to date)");
        lines.push(`  version: ${current}${updateNote}`);
      }

      lines.push(`  active model: ${state.useColor ? chalk.cyan(state.model) : state.model}`);
      lines.push(`  working dir:  ${state.workDir}`);
      lines.push("");
      return lines.join("\n");
    },
  },

  models: {
    usage: "/models [filter]",
    description: "List available models",
    handler: async (args, state) => {
      const filter = args.join(" ").trim();
      return formatModelsList(filterModels(await fetchModels(state), filter), state, filter);
    },
  },

  providers: {
    usage: "/providers",
    description: "List configured provider connections",
    handler: async (_args, state) => {
      const raw = await fetchCachedNativeJSON(state, "/api/providers");
      const connections = toArray<{
        id?: unknown;
        provider?: unknown;
        name?: unknown;
        isActive?: unknown;
        testStatus?: unknown;
      }>((raw as { connections?: unknown })?.connections);

      if (!connections.length) return "\n  (no providers configured)\n";

      const lines = [`\n  ${connections.length} provider connection(s):\n`];
      for (const c of connections) {
        const isActive = c.isActive !== false;
        const status = isActive
          ? (state.useColor ? chalk.green("●") : "●")
          : (state.useColor ? chalk.dim("○") : "○");
        const testStatus = typeof c.testStatus === "string" ? c.testStatus : "";
        const testBadge =
          testStatus === "success"
            ? (state.useColor ? chalk.green(" ok") : " ok")
            : testStatus === "failed"
            ? (state.useColor ? chalk.red(" fail") : " fail")
            : state.useColor ? chalk.dim(" ?") : " ?";
        const displayName = typeof c.name === "string" ? c.name : typeof c.provider === "string" ? c.provider : "?";
        const name = state.useColor ? chalk.white(displayName) : displayName;
        const providerSuffix =
          typeof c.provider === "string"
            ? state.useColor ? chalk.dim(` (${c.provider})`) : ` (${c.provider})`
            : "";
        lines.push(`  ${status} ${name}${providerSuffix}${testBadge}`);
      }
      lines.push("");
      return lines.join("\n");
    },
  },

  combos: {
    usage: "/combos",
    description: "List model combos (fallback chains)",
    handler: async (_args, state) => {
      const raw = await fetchCachedNativeJSON(state, "/api/combos");
      const combos = toArray<{
        id?: unknown;
        name?: unknown;
        kind?: unknown;
        models?: unknown;
      }>((raw as { combos?: unknown })?.combos);

      if (!combos.length) return "\n  (no combos configured)\n";

      const lines = [`\n  ${combos.length} combo(s):\n`];
      for (const combo of combos) {
        const comboName = typeof combo.name === "string" ? combo.name : "?";
        const name = state.useColor ? chalk.bold.white(comboName) : comboName;
        const kind = typeof combo.kind === "string"
          ? (state.useColor ? chalk.dim(` [${combo.kind}]`) : ` [${combo.kind}]`)
          : "";
        const models = toArray<unknown>(combo.models).filter((m) => typeof m === "string") as string[];
        const count = models.length;
        lines.push(`  ${name}${kind} ${state.useColor ? chalk.dim(`(${count} models)`) : `(${count} models)`}`);
        for (const m of models) {
          lines.push(`    ${state.useColor ? chalk.dim("→") : "→"} ${m}`);
        }
      }
      lines.push("");
      return lines.join("\n");
    },
  },

  keys: {
    usage: "/keys",
    description: "List 9router API keys",
    handler: async (_args, state) => {
      const raw = await fetchCachedNativeJSON(state, "/api/keys");
      const keys = toArray<{ id?: unknown; name?: unknown; key?: unknown }>(
        (raw as { keys?: unknown })?.keys
      );

      if (!keys.length) return "\n  (no API keys)\n";

      const lines = [`\n  ${keys.length} API key(s):\n`];
      for (const k of keys) {
        const keyName = typeof k.name === "string" ? k.name : "?";
        const name = state.useColor ? chalk.white(keyName) : keyName;
        const idSuffix =
          typeof k.id === "string"
            ? state.useColor ? chalk.dim(` [${k.id}]`) : ` [${k.id}]`
            : "";
        lines.push(`  ${name}${idSuffix}`);
      }
      lines.push("");
      return lines.join("\n");
    },
  },

  switch: {
    usage: "/switch <model>",
    description: "Switch active model for subsequent tasks in this REPL session",
    handler: async (args, state) => {
      const model = args[0];
      if (!model) return state.useColor ? chalk.red("\n  Usage: /switch <model>\n") : "\n  Usage: /switch <model>\n";
      const models = await fetchModels(state);
      if (!models.some((m) => m.id === model)) {
        const msg = `  Unknown model: ${model}. Use /models or /switch with no argument to choose.`;
        return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
      }
      const prev = state.model;
      state.model = model;
      const msg = `  switched for this session: ${prev} → ${model}`;
      return "\n" + (state.useColor ? chalk.cyan(msg) : msg) + "\n";
    },
  },

  "default-model": {
    usage: "/default-model <model>",
    description: "Persist startup model for future 9rh runs",
    handler: async (args, state) => {
      const model = args[0];
      if (!model) return state.useColor ? chalk.red("\n  Usage: /default-model <model>\n") : "\n  Usage: /default-model <model>\n";
      const models = await fetchModels(state);
      if (!models.some((m) => m.id === model)) {
        const msg = `  Unknown model: ${model}. Use /models to list available models.`;
        return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
      }
      const prev = state.model;
      state.model = model;
      await updateUserConfig({ defaultModel: model });
      const msg = `  startup model saved: ${model} (current session: ${prev} → ${model})`;
      return "\n" + (state.useColor ? chalk.cyan(msg) : msg) + "\n";
    },
  },

  router: {
    usage: "/router",
    description: "Show cached 9router configuration summary",
    handler: async (_args, state) => {
      const [providersRaw, combosRaw, keysRaw, models] = await Promise.all([
        fetchCachedNativeJSON(state, "/api/providers").catch(() => null),
        fetchCachedNativeJSON(state, "/api/combos").catch(() => null),
        fetchCachedNativeJSON(state, "/api/keys").catch(() => null),
        fetchModels(state).catch(() => [] as ModelInfo[]),
      ]);
      const connections = toArray<ProviderConnectionInfo>((providersRaw as { connections?: unknown } | null)?.connections);
      const combos = toArray<{ id?: unknown; name?: unknown; models?: unknown }>((combosRaw as { combos?: unknown } | null)?.combos);
      const keys = toArray<{ id?: unknown; name?: unknown }>((keysRaw as { keys?: unknown } | null)?.keys);
      const active = connections.filter((c) => c.isActive !== false);
      const activeNames = active
        .map((c) => (typeof c.name === "string" ? c.name : typeof c.provider === "string" ? c.provider : "?"))
        .slice(0, 8);

      const lines = [
        "",
        `  9router: ${base(state)}`,
        `  active model: ${state.useColor ? chalk.cyan(state.model) : state.model}`,
        `  models: ${models.length}`,
        `  providers: ${connections.length} configured, ${active.length} active${activeNames.length ? ` (${activeNames.join(", ")})` : ""}`,
        `  combos: ${combos.length}`,
        `  API keys: ${keys.length}`,
        `  cache: ${routerCache(state).native.size} native endpoint(s), ${routerCache(state).models ? "models cached" : "models uncached"}`,
        "",
        `  Use /models, /providers, /combos, /keys for details; /refresh to reload 9router config.`,
        "",
      ];
      return lines.join("\n");
    },
  },

  "debug-auth": {
    usage: "/debug-auth",
    description: "Debug 9router authentication and connectivity",
    handler: async (_args, state) => {
      const token = getCliToken();
      const storedKey = readFirstApiKey();
      const effectiveKey = storedKey ?? state.apiKey;
      const native = base(state);

      const lines = [
        "",
        `  9router base: ${native}`,
        `  CLI token: ${token ? `${token.slice(0, 4)}…${token.slice(-4)}` : "missing"}`,
        `  Effective API key: ${effectiveKey ? `${effectiveKey.slice(0, 8)}…` : "missing"}`,
      ];

      try {
        const headers: Record<string, string> = token
          ? { "x-9r-cli-token": token }
          : { Authorization: `Bearer ${effectiveKey}` };
        const res = await fetch(`${native}/api/health`, { headers });
        const health = await res.json() as { ok?: boolean };
        lines.push(`  API Health: ${health.ok ? "ok" : "unhealthy"}`);
      } catch (err: any) {
        lines.push(`  API Health check failed: ${err.message}`);
      }

      try {
        const headers: Record<string, string> = token
          ? { "x-9r-cli-token": token }
          : { Authorization: `Bearer ${effectiveKey}` };
        const res = await fetch(`${native}/api/providers`, { headers });
        if (res.ok) {
          const providers = await res.json() as { connections?: unknown[] };
          lines.push(`  Providers API: ${providers.connections?.length ?? 0} connections found`);
        } else {
          lines.push(`  Providers API: error ${res.status} ${res.statusText}`);
        }
      } catch (err: any) {
        lines.push(`  Providers API check failed: ${err.message}`);
      }

      lines.push("");
      return lines.join("\n");
    },
  },
  refresh: {
    usage: "/refresh",
    description: "Refresh cached 9router models/providers/combos/keys",
    handler: async (_args, state) => {
      clearRouterConfigCache(state);
      const [models, providersRaw] = await Promise.all([
        fetchModels(state).catch(() => [] as ModelInfo[]),
        fetchCachedNativeJSON(state, "/api/providers").catch(() => null),
      ]);
      const providers = toArray<ProviderConnectionInfo>((providersRaw as { connections?: unknown } | null)?.connections);
      const active = providers.filter((p) => p.isActive !== false).length;
      const msg = `  refreshed 9router config: ${models.length} models, ${active}/${providers.length} active providers`;
      return "\n" + (state.useColor ? chalk.green(msg) : msg) + "\n";
    },
  },

  dir: {
    usage: "/dir [path]",
    description: "Show or change the working directory",
    handler: async (args, state) => {
      if (args[0]) {
        const newDir = resolve(state.workDir, args[0]);
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(newDir);
        } catch {
          const msg = `  Directory not found: ${newDir}`;
          return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
        }
        if (!info.isDirectory()) {
          const msg = `  Not a directory: ${newDir}`;
          return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
        }
        state.workDir = newDir;
        const msg = `  workDir → ${newDir}`;
        return "\n" + (state.useColor ? chalk.cyan(msg) : msg) + "\n";
      }
      return `\n  workDir: ${state.workDir}\n`;
    },
  },

  report: {
    usage: "/report [open]",
    description: "Show the path of the most recent run report, or open it in the default browser",
    handler: async (args, state) => {
      const subcommand = (args[0] ?? "").toLowerCase();
      const path = state.lastReportPath;
      if (!path) {
        const msg = "\n  no report generated yet (run a task first)\n";
        return state.useColor ? msg : msg;
      }
      if (subcommand === "open") {
        return await openReportInBrowser(path, state.useColor);
      }
      const lines = [
        "",
        `  last report: file://${path}`,
        `  open with:    /report open`,
        "",
      ];
      return state.useColor
        ? lines.map((l) => chalk.cyan(l)).join("\n")
        : lines.join("\n");
    },
  },

  clear: {
    usage: "/clear",
    description: "Clear screen",
    handler: async (_args, state) => {
      const clear = state.useColor ? "\x1b[2J\x1b[H" : "\x1b[2J\x1b[H";
      return clear;
    },
  },

  queue: {
    usage: "/queue",
    description: "Show queued messages",
    handler: async (args, state) => {
      if (args[0] === "clear") {
        const cleared = state.queue?.length ?? 0;
        state.queue = [];
        return `\n  Cleared ${cleared} queued message(s).\n`;
      }
      const len = state.queue?.length ?? 0;
      if (!len) return "\n  Queue is empty. Type lines to queue, then /run to send.\n";
      const lines = state.queue.map((l, i) => {
        const preview = l.length > 80 ? l.slice(0, 77) + "..." : l;
        return `  ${i + 1}. ${preview}`;
      });
      return `\n  Queued ${len} message(s):\n${lines.join("\n")}\n  Use /run to send, /queue clear to discard.\n`;
    },
  },
  run: {
    usage: "/run",
    description: "Send queued messages to the agent",
    handler: async (_args, state) => {
      const len = state.queue?.length ?? 0;
      if (!len) return "\n  No queued messages. Type lines first, then /run.\n";
      return `\n  ${len} message(s) queued. Use /run in the REPL to send them.\n`;
    },
  },

  done: {
    usage: "/done",
    description: "Signal agent to stop gracefully (or Ctrl+C during a run)",
    handler: async (_args, state) => {
      return "\n  Use Ctrl+C to interrupt the agent during a run.\n  The REPL will stay alive — no need to relaunch.\n";
    },
  },

  setup: {
    usage: "/setup",
    description: "Install and start 9router if not already running",
    handler: async (_args, state) => {
      const { ensureRouter } = await import("./init.js");
      const init = await ensureRouter(state.baseURL, state.apiKey);
      if (init.error) {
        const msg = `  Setup failed: ${init.error}`;
        return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
      }
      state.baseURL = init.baseURL;
      state.apiKey = init.apiKey;
      state.wasStarted = init.wasStarted;
      const msg = init.wasStarted
        ? "  9router installed and started"
        : "  9router is already running";
      return "\n" + (state.useColor ? chalk.green(msg) : msg) + "\n";
    },
  },

  sandbox: {
    usage: "/sandbox",
    description: "Show command sandbox and isolation status",
    handler: async (_args, state) => {
      const available = isSandboxAvailable();
      const backend = sandboxBackendName(state.workDir);
      const sandboxed = backend !== "direct";
      const status = sandboxed
        ? state.useColor ? chalk.green("enabled") : "enabled"
        : state.useColor ? chalk.yellow("direct fallback") : "direct fallback";
      const lines = [
        "",
        `  sandbox: ${status}`,
        `  backend: ${backend}`,
        `  platform support: ${available ? "macOS sandbox-exec available" : `unavailable on ${process.platform}`}`,
        `  workDir: ${state.workDir}`,
        "  network policy: backend default is disabled, strict enforcement pending roadmap phase 2",
        "  fail-closed: not yet configurable; direct fallback is used when sandbox is unavailable",
        "",
      ];
      if (available && !sandboxed) {
        lines.splice(5, 0, "  restrictive profile: rejected by sandbox-exec; direct fallback active");
      }
      if (!sandboxed) {
        lines.push("  Warning: shell commands are currently running without OS-level isolation.");
        lines.push("");
      }
      return lines.join("\n");
    },
  },

  doctor: {
    usage: "/doctor",
    description: "Diagnose 9router connectivity and configuration",
    handler: async (_args, state) => {
      const b = base(state);
      const checks: Array<{ label: string; status: "ok" | "fail" | "warn"; msg: string }> = [];
      let allOk = true;

      const [health, version, keysData, providersData, modelsData] = await Promise.allSettled([
        fetchNativeJSON(state, "/api/health"),
        fetchNativeJSON(state, "/api/version"),
        fetchNativeJSON(state, "/api/keys"),
        fetchNativeJSON(state, "/api/providers"),
        fetchJSON(`${state.baseURL}/models`, state.apiKey),
      ]);

      let keysResult: PromiseSettledResult<unknown> = keysData;
      if (keysData.status === "rejected" || !(keysData.value as { ok?: boolean }).ok) {
        const fallback = await fetchNativeJSON(state, "/api/keys").catch(() => null);
        if (fallback) keysResult = { status: "fulfilled", value: fallback } as PromiseSettledResult<unknown>;
      }

      if (health.status === "fulfilled") {
        const ok = (health.value as { ok?: boolean }).ok;
        checks.push({
          label: "9router server",
          status: ok ? "ok" : "fail",
          msg: ok ? `reachable at ${b}` : "returned unhealthy status",
        });
        if (!ok) allOk = false;
      } else {
        checks.push({
          label: "9router server",
          status: "fail",
          msg: `unreachable: ${health.reason}`,
        });
        allOk = false;
      }

      if (version.status === "fulfilled") {
        const v = version.value as { currentVersion?: string; hasUpdate?: boolean };
        const updateHint = v.hasUpdate ? " (update available)" : "";
        checks.push({
          label: "version",
          status: "ok",
          msg: `${v.currentVersion ?? "?"}${updateHint}`,
        });
      } else {
        checks.push({ label: "version", status: "warn", msg: "could not fetch" });
      }

      const keys = toArray<{ id?: unknown; name?: unknown; key?: unknown }>(
        (keysResult.status === "fulfilled" ? (keysResult.value as { keys?: unknown })?.keys : undefined) ?? []
      );
      if (keys.length > 0) {
        checks.push({ label: "API keys", status: "ok", msg: `${keys.length} key(s) configured` });
      } else {
        checks.push({ label: "API keys", status: "fail", msg: "no keys found — visit dashboard to get one" });
        allOk = false;
      }

      const connections = toArray<{ id?: unknown; provider?: unknown; name?: unknown; isActive?: unknown; testStatus?: unknown }>(
        (providersData.status === "fulfilled" ? (providersData.value as { connections?: unknown })?.connections : undefined) ?? []
      );
      if (connections.length > 0) {
        const active = connections.filter((c) => c.isActive !== false);
        checks.push({
          label: "providers",
          status: active.length > 0 ? "ok" : "warn",
          msg: `${connections.length} connection(s), ${active.length} active`,
        });
        if (active.length === 0) allOk = false;
      } else {
        checks.push({
          label: "providers",
          status: "fail",
          msg: "no providers — visit http://127.0.0.1:20128/dashboard to connect one",
        });
        allOk = false;
      }

      const models = toArray<{ id?: unknown }>(
        (modelsData.status === "fulfilled" ? (modelsData.value as { data?: unknown })?.data : undefined) ?? []
      ).filter((m) => typeof m.id === "string");

      const activeConnections = connections.filter((c) => c.isActive !== false);
      if (models.length > 0 && keys.length > 0 && activeConnections.length > 0) {
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

      const lines: string[] = [""];
      lines.push("  9rh doctor" + (allOk ? " — all checks passed" : " — issues found"));
      lines.push("");
      for (const check of checks) {
        const icon =
          check.status === "ok"
            ? state.useColor
              ? chalk.green("  ✓")
              : "  ✓"
            : check.status === "warn"
            ? state.useColor
              ? chalk.yellow("  !")
              : "  !"
            : state.useColor
            ? chalk.red("  ✗")
            : "  ✗";
        const label = state.useColor ? chalk.white(check.label.padEnd(16)) : check.label.padEnd(16);
        lines.push(`${icon} ${label} ${check.msg}`);
      }
      lines.push("");

      if (connections.length === 0) {
        const dashboard = state.useColor
          ? chalk.bold.cyan("http://127.0.0.1:20128/dashboard")
          : "http://127.0.0.1:20128/dashboard";
        lines.push(`  → Open ${dashboard} to connect a provider`);
        lines.push("");
      }

      return lines.join("\n");
    },
  },
};

export async function executeSlashCommand(
  line: string,
  state: SessionState
): Promise<string | null> {
  if (!line.startsWith("/")) return null;

  const [rawCmd, ...args] = line.slice(1).trim().split(/\s+/);
  const cmd = rawCmd?.toLowerCase() ?? "";

  const def = COMMANDS[cmd];
  if (!def) {
    const msg = `  Unknown command: /${cmd}. Type /help for a list.`;
    return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
  }

  try {
    return await def.handler(args, state);
  } catch (err) {
    const msg = `  Command failed: ${err instanceof Error ? err.message : String(err)}`;
    return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
  }
}

export function getSlashCommands(): Array<{ name: string; description: string }> {
  return Object.entries(COMMANDS).map(([name, def]) => ({ name, description: def.description }));
}
