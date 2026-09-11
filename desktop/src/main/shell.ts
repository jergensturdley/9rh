/**
 * OS shell helpers behind `CH.shell.*`. Each one is a trust boundary for the
 * renderer, so paths and URLs are checked before Electron touches them.
 */

import { app, dialog, shell } from "electron";
import type { BrowserWindow } from "electron";
import { readFile } from "fs/promises";
import { isAbsolute, resolve, sep } from "path";
import { ninerhHome } from "9rh";

const OPEN_DIR = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "file:"]);

export async function pickDirectory(win: BrowserWindow | null): Promise<string | null> {
  const result = win ? await dialog.showOpenDialog(win, OPEN_DIR) : await dialog.showOpenDialog(OPEN_DIR);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export async function openPath(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("path must be absolute");
  const err = await shell.openPath(path);
  if (err) throw new Error(err);
}

export async function openExternal(url: string): Promise<void> {
  if (!EXTERNAL_SCHEMES.has(new URL(url).protocol)) throw new Error("blocked url scheme");
  await shell.openExternal(url);
}

/** Only .html files under the 9rh home (where the engine writes run reports). */
export async function readReport(path: string): Promise<string> {
  const home = resolve(ninerhHome());
  const full = resolve(path);
  if (!isAbsolute(path) || !full.endsWith(".html") || !full.startsWith(home + sep)) {
    throw new Error(`report must be an .html file under ${home}`);
  }
  return readFile(full, "utf8");
}

export function platform(): { platform: NodeJS.Platform; home: string; version: string } {
  return { platform: process.platform, home: ninerhHome(), version: app.getVersion() };
}
