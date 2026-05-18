import chalk from "chalk";
import { resolve } from "path";
import { stat } from "fs/promises";
import { getCliToken } from "./init.js";
class HTTPError extends Error {
    status;
    constructor(status, statusText) {
        super(`HTTP ${status} ${statusText}`);
        this.status = status;
    }
}
async function fetchJSON(url, apiKey) {
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok)
        throw new HTTPError(res.status, res.statusText);
    return res.json();
}
async function fetchJSONWithHeaders(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok)
        throw new HTTPError(res.status, res.statusText);
    return res.json();
}
function base(state) {
    return state.baseURL.replace(/\/v1\/?$/, "");
}
async function fetchNativeJSON(state, path) {
    const token = getCliToken();
    const headers = token
        ? { "x-9r-cli-token": token }
        : { Authorization: `Bearer ${state.apiKey}` };
    return fetchJSONWithHeaders(`${base(state)}${path}`, headers);
}
export function toArray(val) {
    return Array.isArray(val) ? val : [];
}
export async function fetchModels(state) {
    const raw = await fetchJSON(`${state.baseURL}/models`, state.apiKey);
    return toArray(raw?.data).filter((m) => typeof m.id === "string");
}
export function filterModels(models, filter) {
    const normalized = filter.toLowerCase();
    return normalized ? models.filter((m) => m.id.toLowerCase().includes(normalized)) : models;
}
export function formatModelsList(models, state, filter = "") {
    if (!models.length)
        return `\n  (no models${filter ? ` matching "${filter}"` : ""})\n`;
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
const COMMANDS = {
    help: {
        usage: "/help",
        description: "List all slash commands",
        handler: async (_args, state) => {
            const lines = ["", "Available slash commands:", ""];
            for (const [name, def] of Object.entries(COMMANDS)) {
                const usage = state.useColor
                    ? chalk.cyan(def.usage.padEnd(28)) + chalk.dim(def.description)
                    : def.usage.padEnd(28) + def.description;
                lines.push("  " + usage);
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
            const lines = [""];
            if (health.status === "fulfilled") {
                const ok = health.value.ok;
                const icon = ok ? (state.useColor ? chalk.green("✓") : "✓") : (state.useColor ? chalk.red("✗") : "✗");
                lines.push(`  ${icon} 9router is ${ok ? "running" : "unhealthy"} at ${b}`);
            }
            else {
                const icon = state.useColor ? chalk.red("✗") : "✗";
                lines.push(`  ${icon} 9router unreachable at ${b}`);
                lines.push(`    ${state.useColor ? chalk.dim(health.reason) : String(health.reason)}`);
            }
            if (version.status === "fulfilled") {
                const v = version.value;
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
            const connections = toArray(raw?.connections);
            if (!connections.length)
                return "\n  (no providers configured)\n";
            const lines = [`\n  ${connections.length} provider connection(s):\n`];
            for (const c of connections) {
                const isActive = c.isActive !== false;
                const status = isActive
                    ? (state.useColor ? chalk.green("●") : "●")
                    : (state.useColor ? chalk.dim("○") : "○");
                const testStatus = typeof c.testStatus === "string" ? c.testStatus : "";
                const testBadge = testStatus === "success"
                    ? (state.useColor ? chalk.green(" ok") : " ok")
                    : testStatus === "failed"
                        ? (state.useColor ? chalk.red(" fail") : " fail")
                        : state.useColor ? chalk.dim(" ?") : " ?";
                const displayName = typeof c.name === "string" ? c.name : typeof c.provider === "string" ? c.provider : "?";
                const name = state.useColor ? chalk.white(displayName) : displayName;
                const providerSuffix = typeof c.provider === "string"
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
            const combos = toArray(raw?.combos);
            if (!combos.length)
                return "\n  (no combos configured)\n";
            const lines = [`\n  ${combos.length} combo(s):\n`];
            for (const combo of combos) {
                const comboName = typeof combo.name === "string" ? combo.name : "?";
                const name = state.useColor ? chalk.bold.white(comboName) : comboName;
                const kind = typeof combo.kind === "string"
                    ? (state.useColor ? chalk.dim(` [${combo.kind}]`) : ` [${combo.kind}]`)
                    : "";
                const models = toArray(combo.models).filter((m) => typeof m === "string");
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
            const keys = toArray(raw?.keys);
            if (!keys.length)
                return "\n  (no API keys)\n";
            const lines = [`\n  ${keys.length} API key(s):\n`];
            for (const k of keys) {
                const keyName = typeof k.name === "string" ? k.name : "?";
                const name = state.useColor ? chalk.white(keyName) : keyName;
                const idSuffix = typeof k.id === "string"
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
            if (!model)
                return state.useColor ? chalk.red("\n  Usage: /switch <model>\n") : "\n  Usage: /switch <model>\n";
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
                let info;
                try {
                    info = await stat(newDir);
                }
                catch {
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
            const checks = [];
            let allOk = true;
            const [health, version, keysData, providersData, modelsData] = await Promise.allSettled([
                fetchNativeJSON(state, "/api/health"),
                fetchNativeJSON(state, "/api/version"),
                fetchNativeJSON(state, "/api/keys"),
                fetchNativeJSON(state, "/api/providers"),
                fetchJSON(`${state.baseURL}/models`, state.apiKey),
            ]);
            let keysResult = keysData;
            if (keysData.status === "rejected" || !keysData.value.ok) {
                const fallback = await fetchNativeJSON(state, "/api/keys").catch(() => null);
                if (fallback)
                    keysResult = { status: "fulfilled", value: fallback };
            }
            if (health.status === "fulfilled") {
                const ok = health.value.ok;
                checks.push({
                    label: "9router server",
                    status: ok ? "ok" : "fail",
                    msg: ok ? `reachable at ${b}` : "returned unhealthy status",
                });
                if (!ok)
                    allOk = false;
            }
            else {
                checks.push({
                    label: "9router server",
                    status: "fail",
                    msg: `unreachable: ${health.reason}`,
                });
                allOk = false;
            }
            if (version.status === "fulfilled") {
                const v = version.value;
                const updateHint = v.hasUpdate ? " (update available)" : "";
                checks.push({
                    label: "version",
                    status: "ok",
                    msg: `${v.currentVersion ?? "?"}${updateHint}`,
                });
            }
            else {
                checks.push({ label: "version", status: "warn", msg: "could not fetch" });
            }
            const keys = toArray((keysResult.status === "fulfilled" ? keysResult.value?.keys : undefined) ?? []);
            if (keys.length > 0) {
                checks.push({ label: "API keys", status: "ok", msg: `${keys.length} key(s) configured` });
            }
            else {
                checks.push({ label: "API keys", status: "fail", msg: "no keys found — visit dashboard to get one" });
                allOk = false;
            }
            const connections = toArray((providersData.status === "fulfilled" ? providersData.value?.connections : undefined) ?? []);
            if (connections.length > 0) {
                const active = connections.filter((c) => c.isActive !== false);
                checks.push({
                    label: "providers",
                    status: active.length > 0 ? "ok" : "warn",
                    msg: `${connections.length} connection(s), ${active.length} active`,
                });
                if (active.length === 0)
                    allOk = false;
            }
            else {
                checks.push({
                    label: "providers",
                    status: "fail",
                    msg: "no providers — visit http://localhost:20128/dashboard to connect one",
                });
                allOk = false;
            }
            const models = toArray((modelsData.status === "fulfilled" ? modelsData.value?.data : undefined) ?? []).filter((m) => typeof m.id === "string");
            const activeConnections = connections.filter((c) => c.isActive !== false);
            if (models.length > 0 && keys.length > 0 && activeConnections.length > 0) {
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
            const lines = [""];
            lines.push("  9rh doctor" + (allOk ? " — all checks passed" : " — issues found"));
            lines.push("");
            for (const check of checks) {
                const icon = check.status === "ok"
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
export async function executeSlashCommand(line, state) {
    if (!line.startsWith("/"))
        return null;
    const [rawCmd, ...args] = line.slice(1).trim().split(/\s+/);
    const cmd = rawCmd?.toLowerCase() ?? "";
    const def = COMMANDS[cmd];
    if (!def) {
        const msg = `  Unknown command: /${cmd}. Type /help for a list.`;
        return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
    }
    try {
        return await def.handler(args, state);
    }
    catch (err) {
        const msg = `  Command failed: ${err instanceof Error ? err.message : String(err)}`;
        return "\n" + (state.useColor ? chalk.red(msg) : msg) + "\n";
    }
}
export function getSlashCommands() {
    return Object.entries(COMMANDS).map(([name, def]) => ({ name, description: def.description }));
}
//# sourceMappingURL=commands.js.map