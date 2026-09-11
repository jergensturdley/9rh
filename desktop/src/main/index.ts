/**
 * Electron main entry: single instance, one window, service construction,
 * IPC registration, window-bounds persistence, and a headless smoke mode
 * (`NINERH_SMOKE=1`) used by the build to prove the bridge comes up.
 */

import { app, BrowserWindow, shell as electronShell } from "electron";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { CH } from "@shared/ipc";
import { readAppState, updateAppState } from "./appState";
import { registerIpc } from "./ipc";
import type { Handler } from "./ipc";
import { ReplayService } from "./replayService";
import { RouterClient } from "./routerClient";
import { RouterProcess } from "./routerProcess";
import { SessionRegistry } from "./sessionRegistry";

const SMOKE = process.env.NINERH_SMOKE === "1";
// Smoke runs must never touch the real ~/.9rh; 9rh resolves its home lazily.
if (SMOKE) process.env.NINE_RH_HOME = mkdtempSync(join(tmpdir(), "9rh-smoke-"));

const WEBVIEW_ORIGINS = new Set(["http://127.0.0.1:20128", "http://localhost:20128"]);
const WEBVIEW_PARTITION = "persist:9router";
const BOUNDS_DEBOUNCE_MS = 500;

// ponytail: one window; send() targets it directly. Broadcast over
// BrowserWindow.getAllWindows() if a second window ever lands.
let win: BrowserWindow | null = null;

function logLoadError(err: unknown): void {
  process.stderr.write(`[9rh-desktop] window failed to load: ${err instanceof Error ? err.message : String(err)}\n`);
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

async function createWindow(): Promise<BrowserWindow> {
  const bounds = (await readAppState()).window;
  const w = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 920,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 1024,
    minHeight: 640,
    title: "9rh",
    show: !SMOKE,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.mjs", import.meta.url)),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win = w;

  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void electronShell.openExternal(url);
    return { action: "deny" };
  });

  // The only guest page is the 9router dashboard; anything else is refused.
  w.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    let origin = "";
    try {
      origin = new URL(params.src ?? "").origin;
    } catch {
      // unparsable src: denied below
    }
    if (!WEBVIEW_ORIGINS.has(origin) || params.partition !== WEBVIEW_PARTITION) event.preventDefault();
  });

  let boundsTimer: NodeJS.Timeout | undefined;
  const persistBounds = (): void => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!w.isDestroyed()) void updateAppState({ window: w.getBounds() });
    }, BOUNDS_DEBOUNCE_MS);
  };
  w.on("resize", persistBounds);
  w.on("move", persistBounds);
  w.on("closed", () => {
    clearTimeout(boundsTimer);
    if (win === w) win = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await w.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await w.loadFile(join(fileURLToPath(new URL(".", import.meta.url)), "../renderer/index.html"));
  }
  return w;
}

async function smoke(w: BrowserWindow, handlers: Record<string, Handler>): Promise<void> {
  // loadFile/loadURL above resolved on did-finish-load, so the preload has run.
  const bridge: unknown = await w.webContents.executeJavaScript("typeof window.ninerh");
  if (bridge !== "object") throw new Error(`window.ninerh is ${String(bridge)}`);
  const list = await handlers[CH.sessions.list]!();
  if (!list.ok) throw new Error(`sessions:list failed: ${list.error}`);
}

function main(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const router = new RouterClient();
  const routerProcess = new RouterProcess(router);
  const replays = new ReplayService({
    emit: (e) => send(CH.push.replayEvent, e),
    onStatus: (s) => send(CH.push.replayStatus, s),
  });
  const registry = new SessionRegistry({
    emit: (e) => send(CH.push.sessionEvent, e),
    onChanged: (s) => send(CH.push.sessionChanged, s),
    onRemoved: (id) => send(CH.push.sessionRemoved, id),
  });
  const handlers = registerIpc({ registry, router, routerProcess, replays, send });

  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    registry.disposeAll();
    void handlers[CH.router.usageStreamStop]!();
  });

  void app.whenReady().then(async () => {
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(logLoadError);
    });
    if (!SMOKE) {
      await createWindow().catch(logLoadError);
      return;
    }
    const timer = setTimeout(() => {
      process.stdout.write("SMOKE FAIL: timeout after 20s\n");
      app.exit(1);
    }, 20_000);
    try {
      await smoke(await createWindow(), handlers);
      clearTimeout(timer);
      process.stdout.write("SMOKE OK\n");
      app.exit(0);
    } catch (err) {
      clearTimeout(timer);
      process.stdout.write(`SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
      app.exit(1);
    }
  });
}

main();
