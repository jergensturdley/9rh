import type { BrowserWindowConstructorOptions } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";

type ChromeOptions = Pick<BrowserWindowConstructorOptions, "icon" | "titleBarStyle">;

export function resolveAppIconPath(isPackaged: boolean, resourcesPath: string, moduleUrl: string): string {
  return isPackaged
    ? join(resourcesPath, "icon.png")
    : fileURLToPath(new URL("../../build/icon.png", moduleUrl));
}

export function windowChromeOptions(platform: NodeJS.Platform, icon: string): ChromeOptions {
  return platform === "darwin" ? { titleBarStyle: "hiddenInset" } : { icon };
}
