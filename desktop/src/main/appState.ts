/**
 * Desktop app state persisted at ~/.9rh/desktop.json (honors NINE_RH_HOME
 * through 9rh's `ninerhDir`). Missing or corrupt files read as defaults.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { ninerhDir } from "9rh";
import type { AppState } from "@shared/ipc";

const MAX_RECENT = 10;

export function appStatePath(): string {
  return ninerhDir("desktop.json");
}

export async function readAppState(): Promise<AppState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(appStatePath(), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const raw = parsed as Partial<AppState>;
      const dirs = Array.isArray(raw.recentWorkDirs) ? raw.recentWorkDirs.filter((d) => typeof d === "string") : [];
      return { ...raw, recentWorkDirs: dirs };
    }
  } catch {
    // missing or corrupt: defaults
  }
  return { recentWorkDirs: [] };
}

export async function updateAppState(patch: Partial<AppState>): Promise<AppState> {
  const next: AppState = { ...(await readAppState()), ...patch };
  const path = appStatePath();
  await mkdir(dirname(path), { recursive: true });
  // ponytail: plain write, no atomic rename. Switch to write-tmp-then-rename if
  // a torn file ever shows up in the wild; readAppState already tolerates it.
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export async function rememberWorkDir(dir: string): Promise<AppState> {
  const { recentWorkDirs } = await readAppState();
  return updateAppState({ recentWorkDirs: [dir, ...recentWorkDirs.filter((d) => d !== dir)].slice(0, MAX_RECENT) });
}
