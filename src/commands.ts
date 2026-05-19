import chalk from "chalk";
import { resolve } from "path";
import { stat } from "fs/promises";
import { getCliToken } from "./init.js";
import type { ContinuationPolicy } from "./agent.js";

export interface SessionState {
  baseURL: string;
  apiKey: string;
  model: string;
  workDir: string;
  useColor: boolean;
  wasStarted?: boolean; // true if 9router was auto-started by this session
  continuationPolicy?: ContinuationPolicy;
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

async function fetchNativeJSON(state: SessionState, path: string): Promise<unknown> {
  const token = getCliToken();
  const headers: Record<string, string> = token
    ? { "x-9r-cli-token": token }
    : { Authorization: `Bearer ${state.apiKey}` };
  return fetchJSONWithHeaders(`${base(state)}${path}`, headers);
}

export function toArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

export async function fetchModels(state: SessionState): Promise<ModelInfo[]> {
  const raw = await fetchJSON(`${state.baseURL}/models`, state.apiKey);
  const models = toArray<{ id?: unknown; owned_by?: unknown }>(
    (raw as { data?: unknown })?.data
  ).filter((m) => typeof m.id === "string") as ModelInfo[];

  try {
    return reconcileConnectionModels(models, await fetchProviderConnections(state));
  } catch {
    return models;
  }
}

async function fetchProviderConnections(state: SessionState): Promise<ProviderConnectionInfo[]> {
  const raw = await fetchNativeJSON(state, "/api/providers");
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
      const lines = [
        "",
        banner,
        "",
        c ? chalk.dim("━━ system ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━") : "━━ system ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        `  ${c ? chalk.cyan("/help") : "/help"}          Show this menu`,
        `  ${c ? chalk.cyan("/clear") : "/clear"}        Clear the screen`,
        `  ${c ? chalk.cyan("/setup") : "/setup"}        Install & start 9router`,
        `  ${c ? chalk.cyan("/doctor") : "/doctor"}       Diagnose connectivity & config`,
        "",
        c ? chalk.dim("━━ router ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━") : "━━ router ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        `  ${c ? chalk.cyan("/status") : "/status"}       9router health, version, updates`,
        `  ${c ? chalk.cyan("/providers") : "/providers"}  List configured provider connections`,
        `  ${c ? chalk.cyan("/combos") : "/combos"}       List model fallback chains`,
        `  ${c ? chalk.cyan("/keys") : "/keys"}          List 9router API keys`,
        "",
        c ? chalk.dim("━━ models ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━") : "━━ models ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        `  ${c ? chalk.cyan("/models") : "/models"}       List available models`,
        `  ${c ? chalk.cyan("/switch") : "/switch"}       Switch active model`,
        "",
        c ? chalk.dim("━━ session ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━") : "━━ session ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        `  ${c ? chalk.cyan("/dir") : "/dir"}            Show or change working directory`,
        "",
        divider,
        "",
      ];
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
      const raw = await fetchNativeJSON(state, "/api/providers");
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
      const raw = await fetchNativeJSON(state, "/api/combos");
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
      const raw = await fetchNativeJSON(state, "/api/keys");
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
    description: "Switch active model for subsequent tasks",
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
      const msg = `  switched: ${prev} → ${model}`;
      return "\n" + (state.useColor ? chalk.cyan(msg) : msg) + "\n";
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

  clear: {
    usage: "/clear",
    description: "Clear screen",
    handler: async (_args, state) => {
      const clear = state.useColor ? "\x1b[2J\x1b[H" : "\x1b[2J\x1b[H";
      return clear;
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
          msg: "no providers — visit http://localhost:20128/dashboard to connect one",
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
          ? chalk.bold.cyan("http://localhost:20128/dashboard")
          : "http://localhost:20128/dashboard";
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
