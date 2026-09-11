/**
 * OS shell helpers behind `CH.shell.*`. Each one is a trust boundary for the
 * renderer, so paths and URLs are checked before Electron touches them.
 */

import { app, dialog, shell } from "electron";
import type { BrowserWindow } from "electron";
import { readFile, realpath } from "fs/promises";
import { isAbsolute, resolve, sep } from "path";
import { ninerhHome } from "9rh";

const OPEN_DIR = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
// file: is deliberately absent: LaunchServices executes .app, .command and
// .pkg targets instead of displaying them.
const EXTERNAL_SCHEMES = new Set(["http:", "https:"]);

export async function pickDirectory(win: BrowserWindow | null): Promise<string | null> {
  const result = win ? await dialog.showOpenDialog(win, OPEN_DIR) : await dialog.showOpenDialog(OPEN_DIR);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * Prove a renderer-supplied path is a real .html run report under the 9rh
 * home. Symlinks are followed on both sides, so a link planted under ~/.9rh
 * cannot reach anything outside it. Returns the real path.
 */
export async function assertReportPath(path: string): Promise<string> {
  const home = resolve(ninerhHome());
  const message = `report must be an .html file under ${home}`;
  if (!isAbsolute(path) || !resolve(path).endsWith(".html")) throw new Error(message);
  const realHome = await realpath(home).catch(() => home);
  const full = await realpath(path).catch(() => {
    throw new Error(message);
  });
  if (!full.endsWith(".html") || !full.startsWith(realHome + sep)) throw new Error(message);
  return full;
}

/** Open a run report with the OS default handler. Confined like readReport. */
export async function openPath(path: string): Promise<void> {
  const err = await shell.openPath(await assertReportPath(path));
  if (err) throw new Error(err);
}

export async function openExternal(url: string): Promise<void> {
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error("blocked url scheme");
  }
  if (!EXTERNAL_SCHEMES.has(protocol)) throw new Error("blocked url scheme");
  await shell.openExternal(url);
}

/** Only .html files under the 9rh home (where the engine writes run reports). */
export async function readReport(path: string): Promise<string> {
  return readFile(await assertReportPath(path), "utf8");
}

export function platform(): { platform: NodeJS.Platform; home: string; version: string } {
  return { platform: process.platform, home: ninerhHome(), version: app.getVersion() };
}
