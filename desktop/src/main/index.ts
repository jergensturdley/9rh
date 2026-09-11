/**
 * Electron main entry: single instance, one window, service construction,
 * IPC registration, window-bounds persistence, and a headless smoke mode
 * (`NINERH_SMOKE=1`) used by the build to prove the bridge comes up.
 */

import { app, BrowserWindow, session, shell as electronShell } from "electron";
import type { WebContents } from "electron";
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
import { RouterUpdater } from "./routerUpdate";
import { SessionRegistry } from "./sessionRegistry";
import { applyLoginPath } from "./loginPath";

const SMOKE = process.env.NINERH_SMOKE === "1";
// Smoke runs must never touch the real ~/.9rh. The engine resolves its home
// lazily from NINE_RH_HOME (paths.ts) and its config from NINE_RH_CONFIG_DIR
// (config.ts), so both are redirected.
if (SMOKE) {
  const home = mkdtempSync(join(tmpdir(), "9rh-smoke-"));
  process.env.NINE_RH_HOME = home;
  process.env.NINE_RH_CONFIG_DIR = home;
}

const WEBVIEW_PARTITION = "persist:9router";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BOUNDS_DEBOUNCE_MS = 500;

/** Origins the dashboard <webview> may load; derived from the router base in main(). */
let webviewOrigins = new Set<string>();
let win: BrowserWindow | null = null;

function isHttp(url: string): boolean {
  return /^https?:/i.test(url);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Pin a webContents to the pages it is allowed to show. Anything else is
 * cancelled; http(s) targets go to the system browser instead, which is where
 * docs links and OAuth flows belong.
 */
function logError(what: string): (err: unknown) => void {
  return (err) => process.stderr.write(`[9rh-desktop] ${what}: ${err instanceof Error ? err.message : String(err)}\n`);
}

function openExternal(url: string): void {
  electronShell.openExternal(url).catch(logError(`open ${url}`));
}

function pinNavigation(contents: WebContents, allowed: (url: string) => boolean): void {
  const guard = (event: Electron.Event, url: string): void => {
    if (allowed(url)) return;
    event.preventDefault();
    if (isHttp(url)) openExternal(url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) openExternal(url);
    return { action: "deny" };
  });
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function logLoadError(err: unknown): void {
  process.stderr.write(`[9rh-desktop] window failed to load: ${err instanceof Error ? err.message : String(err)}\n`);
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
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win = w;

  // The main document is the bundled renderer. A dropped file or link must
  // never navigate it: the preload would run again and hand the new page the
  // whole bridge.
  const devOrigin = process.env.ELECTRON_RENDERER_URL ? originOf(process.env.ELECTRON_RENDERER_URL) : "";
  pinNavigation(w.webContents, (url) => (devOrigin ? originOf(url) === devOrigin : url.startsWith("file://")));

  // The only guest page is the 9router dashboard; anything else is refused.
  w.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (!webviewOrigins.has(originOf(params.src ?? "")) || params.partition !== WEBVIEW_PARTITION) event.preventDefault();
  });
  // Once attached, the guest stays on the dashboard origin. External links
  // and OAuth hops open in the system browser rather than inside the app,
  // where the user could not see the address bar.
  w.webContents.on("did-attach-webview", (_event, guest) => {
    pinNavigation(guest, (url) => webviewOrigins.has(originOf(url)));
  });

  let boundsTimer: NodeJS.Timeout | undefined;
  const persistBounds = (): void => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!w.isDestroyed()) updateAppState({ window: w.getBounds() }).catch(logError("persist window bounds"));
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
  // Smoke runs use a throwaway home and must not be blocked by (or steal
  // focus from) a running instance.
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Nothing in main should fail silently; every stray rejection is logged.
  process.on("unhandledRejection", logError("unhandled rejection"));

  const router = new RouterClient();
  const dashboard = new URL(router.dashboardUrl());
  if (LOOPBACK_HOSTS.has(dashboard.hostname)) {
    webviewOrigins = new Set([
      dashboard.origin,
      dashboard.origin.replace("127.0.0.1", "localhost"),
      dashboard.origin.replace("localhost", "127.0.0.1"),
    ]);
  } else {
    process.stderr.write(`[9rh-desktop] dashboard host ${dashboard.hostname} is not loopback; the embedded dashboard is disabled\n`);
  }
  const routerProcess = new RouterProcess(router);
  const routerUpdater = new RouterUpdater({ client: router, process: routerProcess });
  const replays = new ReplayService({
    emit: (e) => send(CH.push.replayEvent, e),
    onStatus: (s) => send(CH.push.replayStatus, s),
  });
  const registry = new SessionRegistry({
    emit: (e) => send(CH.push.sessionEvent, e),
    onChanged: (s) => send(CH.push.sessionChanged, s),
    onRemoved: (id) => send(CH.push.sessionRemoved, id),
  });
  const handlers = registerIpc({ registry, router, routerProcess, routerUpdater, replays, send });

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
    // A Dock launch inherits launchd's PATH, which has no npm and no user
    // prefixes, so the updater and ensureRouter would not find 9router.
    await applyLoginPath().catch(logError("read the login shell PATH"));
    // The app uses no browser permissions (camera, mic, notifications, ...),
    // and Electron grants them by default when no handler is installed.
    for (const s of [session.defaultSession, session.fromPartition(WEBVIEW_PARTITION)]) {
      s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      s.setPermissionCheckHandler(() => false);
    }
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
