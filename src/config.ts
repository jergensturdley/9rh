import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

export interface UserConfig {
  defaultModel?: string;
  defaultProvider?: string;
  /** Persisted backend choice: "router" | "direct" | "embedded". */
  backend?: string;
}

function configDir(): string {
  return process.env.NINE_RH_CONFIG_DIR || join(process.env.HOME || process.cwd(), ".9rh");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function readUserConfig(): Promise<UserConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      defaultModel: cleanString(parsed.defaultModel),
      defaultProvider: cleanString(parsed.defaultProvider),
      backend: cleanString(parsed.backend),
    };
  } catch {
    return {};
  }
}

export async function writeUserConfig(config: UserConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const normalized: UserConfig = {};
  if (config.defaultModel) normalized.defaultModel = config.defaultModel;
  if (config.defaultProvider) normalized.defaultProvider = config.defaultProvider;
  if (config.backend) normalized.backend = config.backend;
  await writeFile(configPath(), JSON.stringify(normalized, null, 2) + "\n", "utf-8");
}

export async function updateUserConfig(patch: UserConfig): Promise<UserConfig> {
  const next = { ...(await readUserConfig()), ...patch };
  await writeUserConfig(next);
  return next;
}

export function resolveConfiguredModel(cliModel: string | undefined, config: UserConfig): string {
  const envModel = cleanString(process.env.NINE_ROUTER_MODEL);
  const explicitCliModel = cleanString(cliModel);
  const model = envModel ?? explicitCliModel ?? config.defaultModel ?? "kr/claude-sonnet-4.5";
  const provider = config.defaultProvider;
  if (provider && !model.includes("/") && !envModel && !explicitCliModel) {
    return `${provider}/${model}`;
  }
  return model;
}
