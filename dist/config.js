import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
function configDir() {
    return process.env.NINE_RH_CONFIG_DIR || join(process.env.HOME || process.cwd(), ".9rh");
}
export function configPath() {
    return join(configDir(), "config.json");
}
function cleanString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
export async function readUserConfig() {
    try {
        const raw = await readFile(configPath(), "utf-8");
        const parsed = JSON.parse(raw);
        return {
            defaultModel: cleanString(parsed.defaultModel),
            defaultProvider: cleanString(parsed.defaultProvider),
        };
    }
    catch {
        return {};
    }
}
export async function writeUserConfig(config) {
    await mkdir(configDir(), { recursive: true });
    const normalized = {};
    if (config.defaultModel)
        normalized.defaultModel = config.defaultModel;
    if (config.defaultProvider)
        normalized.defaultProvider = config.defaultProvider;
    await writeFile(configPath(), JSON.stringify(normalized, null, 2) + "\n", "utf-8");
}
export async function updateUserConfig(patch) {
    const next = { ...(await readUserConfig()), ...patch };
    await writeUserConfig(next);
    return next;
}
export function resolveConfiguredModel(cliModel, config) {
    const envModel = cleanString(process.env.NINE_ROUTER_MODEL);
    const explicitCliModel = cleanString(cliModel);
    const model = envModel ?? explicitCliModel ?? config.defaultModel ?? "kr/claude-sonnet-4.5";
    const provider = config.defaultProvider;
    if (provider && !model.includes("/") && !envModel && !explicitCliModel) {
        return `${provider}/${model}`;
    }
    return model;
}
//# sourceMappingURL=config.js.map