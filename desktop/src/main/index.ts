import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "url";
import { join } from "path";
import { ninerhHome } from "9rh";

// Scaffold stub: replaced by the full lifecycle + IPC wiring in a later step.
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "9rh",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.mjs", import.meta.url)),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(fileURLToPath(new URL(".", import.meta.url)), "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  process.stderr.write(`[9rh-desktop] home: ${ninerhHome()}\n`);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
