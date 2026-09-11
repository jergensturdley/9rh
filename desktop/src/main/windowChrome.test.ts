import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { resolveAppIconPath, windowChromeOptions } from "./windowChrome";

describe("window chrome", () => {
  it("uses hiddenInset without a window icon on macOS", () => {
    expect(windowChromeOptions("darwin", "/icons/icon.png")).toEqual({ titleBarStyle: "hiddenInset" });
  });

  it("uses the application icon with the native title bar elsewhere", () => {
    expect(windowChromeOptions("win32", "C:\\icons\\icon.png")).toEqual({ icon: "C:\\icons\\icon.png" });
    expect(windowChromeOptions("linux", "/icons/icon.png")).toEqual({ icon: "/icons/icon.png" });
  });

  it("resolves development and packaged icon locations", () => {
    const resourcesPath = resolve("Applications", "9rh.app", "Contents", "Resources");
    const modulePath = resolve("repo", "desktop", "out", "main", "index.js");
    const moduleUrl = pathToFileURL(modulePath).href;

    expect(resolveAppIconPath(false, resourcesPath, moduleUrl)).toBe(resolve("repo", "desktop", "build", "icon.png"));
    expect(resolveAppIconPath(true, resourcesPath, moduleUrl)).toBe(join(resourcesPath, "icon.png"));
  });
});
