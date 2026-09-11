# Desktop Native Chrome, Icon, and Dependency Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Electron app collision-free draggable macOS chrome, distinctive cross-platform 9rh branding, and dependency lockfiles with no known vulnerabilities.

**Architecture:** Keep Electron's native macOS traffic lights and reserve a platform-specific 36px renderer strip beneath the hidden title bar. Isolate main-process icon/chrome decisions and renderer chrome-state decisions in pure helpers, expose the runtime platform through the existing preload contract, and keep packaging assets under `desktop/build/`. Remediate security alerts through targeted lockfile resolution updates rather than application refactors.

**Tech Stack:** Electron 44, electron-vite 5, React 19, TypeScript 5.9, Vitest 4, Electron Builder 26, CSS `-webkit-app-region`, npm lockfiles, macOS `iconutil`, Pillow for `.ico` export.

---

## File Map

- Create `desktop/src/main/windowChrome.ts`: resolve the runtime icon path and return platform-specific `BrowserWindow` chrome options.
- Create `desktop/src/main/windowChrome.test.ts`: unit coverage for macOS title-bar mode, non-macOS window icons, and development/packaged asset paths.
- Modify `desktop/src/main/index.ts`: consume the window-chrome helper and set the macOS Dock icon when Electron is ready.
- Modify `desktop/src/shared/ipc.ts`: add the immutable runtime platform field to `NinerhApi`.
- Modify `desktop/src/preload/index.ts`: expose `process.platform` through the context-isolated bridge.
- Create `desktop/src/renderer/app/windowChrome.ts`: derive renderer class and drag-strip visibility from an explicit platform value.
- Create `desktop/src/renderer/app/windowChrome.test.ts`: unit coverage for macOS-only custom chrome.
- Modify `desktop/src/renderer/app/App.tsx`: render the drag strip and macOS class returned by the helper.
- Modify `desktop/src/renderer/app/App.css`: reserve 36px, style the drag region, and protect interactive controls with `no-drag`.
- Create `desktop/build/icon.png`, `desktop/build/icon.icns`, and `desktop/build/icon.ico`: application icon assets.
- Modify `desktop/electron-builder.yml`: wire each platform to its icon and copy the runtime PNG into packaged resources.
- Modify `package-lock.json`: resolve the four vulnerable root development dependencies to patched versions.

### Task 1: Test and Isolate Main-Process Window Chrome

**Files:**
- Create: `desktop/src/main/windowChrome.test.ts`
- Create: `desktop/src/main/windowChrome.ts`
- Modify: `desktop/src/main/index.ts`

- [ ] **Step 1: Write the failing main-process helper tests**

Create `desktop/src/main/windowChrome.test.ts`:

```ts
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
    expect(resolveAppIconPath(false, "/Applications/9rh.app/Contents/Resources", "file:///repo/desktop/out/main/index.js"))
      .toBe("/repo/desktop/build/icon.png");
    expect(resolveAppIconPath(true, "/Applications/9rh.app/Contents/Resources", "file:///repo/desktop/out/main/index.js"))
      .toBe("/Applications/9rh.app/Contents/Resources/icon.png");
  });
});
```

- [ ] **Step 2: Run the test and confirm the RED state**

Run from `desktop/`:

```bash
npx vitest run src/main/windowChrome.test.ts
```

Expected: FAIL because `./windowChrome` does not exist.

- [ ] **Step 3: Implement the minimal window-chrome helper**

Create `desktop/src/main/windowChrome.ts`:

```ts
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
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `cd desktop && npx vitest run src/main/windowChrome.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Wire the helper and Dock icon into Electron**

In `desktop/src/main/index.ts`, apply these exact edits:

```diff
@@
 import { applyLoginPath } from "./loginPath";
+import { resolveAppIconPath, windowChromeOptions } from "./windowChrome";
@@
 const BOUNDS_DEBOUNCE_MS = 500;
+const APP_ICON = resolveAppIconPath(app.isPackaged, process.resourcesPath, import.meta.url);
@@
     title: "9rh",
     show: !SMOKE,
-    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
+    ...windowChromeOptions(process.platform, APP_ICON),
     webPreferences: {
@@
   void app.whenReady().then(async () => {
+    if (process.platform === "darwin") app.dock?.setIcon(APP_ICON);
     // A Dock launch inherits launchd's PATH, which has no npm and no user
```

- [ ] **Step 6: Verify the focused test and typecheck**

Run:

```bash
cd desktop
npx vitest run src/main/windowChrome.test.ts
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit the main-process chrome change**

```bash
git add desktop/src/main/windowChrome.ts desktop/src/main/windowChrome.test.ts desktop/src/main/index.ts
git commit -m "fix(desktop): configure native window chrome"
```

### Task 2: Add a Tested macOS Drag Strip

**Files:**
- Modify: `desktop/src/shared/ipc.ts`
- Modify: `desktop/src/preload/index.ts`
- Create: `desktop/src/renderer/app/windowChrome.ts`
- Create: `desktop/src/renderer/app/windowChrome.test.ts`
- Modify: `desktop/src/renderer/app/App.tsx`
- Modify: `desktop/src/renderer/app/App.css`

- [ ] **Step 1: Write the failing renderer chrome test**

Create `desktop/src/renderer/app/windowChrome.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rendererChrome } from "./windowChrome";

describe("rendererChrome", () => {
  it("enables the custom drag strip only on macOS", () => {
    expect(rendererChrome("darwin")).toEqual({ appClassName: "app app-darwin", showDragStrip: true });
    expect(rendererChrome("win32")).toEqual({ appClassName: "app", showDragStrip: false });
    expect(rendererChrome("linux")).toEqual({ appClassName: "app", showDragStrip: false });
  });
});
```

- [ ] **Step 2: Run the test and confirm the RED state**

Run: `cd desktop && npx vitest run src/renderer/app/windowChrome.test.ts`

Expected: FAIL because the renderer helper does not exist.

- [ ] **Step 3: Implement the renderer helper**

Create `desktop/src/renderer/app/windowChrome.ts`:

```ts
export interface RendererChrome {
  appClassName: string;
  showDragStrip: boolean;
}

export function rendererChrome(platform: NodeJS.Platform): RendererChrome {
  return platform === "darwin"
    ? { appClassName: "app app-darwin", showDragStrip: true }
    : { appClassName: "app", showDragStrip: false };
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `cd desktop && npx vitest run src/renderer/app/windowChrome.test.ts`

Expected: 1 test passes.

- [ ] **Step 5: Expose the explicit runtime platform**

Add the field to `NinerhApi` in `desktop/src/shared/ipc.ts`:

```diff
 export interface NinerhApi {
+  platform: NodeJS.Platform;
   sessions: SessionsApi;
```

Add the value to the bridge object in `desktop/src/preload/index.ts`:

```diff
 const api = {
+  platform: process.platform,
   sessions: invokeGroup(CH.sessions),
```

- [ ] **Step 6: Render the platform-specific drag strip**

In `desktop/src/renderer/app/App.tsx`, apply these exact edits:

```diff
@@
 import { Nav, PAGES, type Page } from "./Nav";
+import { rendererChrome } from "./windowChrome";
 import "./App.css";
 
 export function App() {
+  const chrome = rendererChrome(window.ninerh.platform);
   const [page, setPage] = useState<Page>("agent");
@@
   return (
-    <div className="app">
+    <div className={chrome.appClassName}>
+      {chrome.showDragStrip ? <div className="window-drag-strip" aria-hidden="true" /> : null}
       <Nav page={page} onChange={setPage} />
```

- [ ] **Step 7: Reserve the title area and define drag behavior**

Extend `desktop/src/renderer/app/App.css`:

```css
.app {
  position: relative;
}

.app.app-darwin {
  padding-top: 36px;
}

.window-drag-strip {
  position: absolute;
  inset: 0 0 auto;
  height: 36px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}

button,
input,
select,
textarea,
a,
[role="button"] {
  -webkit-app-region: no-drag;
}
```

Do not alter the existing grid columns or 100vh height; global `border-box` sizing makes the padding part of that height.

- [ ] **Step 8: Verify renderer behavior and compile contracts**

Run:

```bash
cd desktop
npx vitest run src/renderer/app/windowChrome.test.ts
npm run typecheck
npm run build
```

Expected: the focused test passes and both build commands exit 0.

- [ ] **Step 9: Commit the renderer chrome change**

```bash
git add desktop/src/shared/ipc.ts desktop/src/preload/index.ts desktop/src/renderer/app/windowChrome.ts desktop/src/renderer/app/windowChrome.test.ts desktop/src/renderer/app/App.tsx desktop/src/renderer/app/App.css
git commit -m "fix(desktop): add draggable macOS title strip"
```

### Task 3: Create and Package the 9rh Application Icon

**Files:**
- Create: `desktop/build/icon.png`
- Create: `desktop/build/icon.icns`
- Create: `desktop/build/icon.ico`
- Modify: `desktop/electron-builder.yml`

- [ ] **Step 1: Generate the source artwork**

Use the image-generation skill to create one centered 1024x1024 icon: dark navy macOS-style squircle, dimensional blue/cyan `9rh` monogram, subtle route-node geometry, high contrast, no tiny text beyond the monogram, no stock Electron or code-bracket imagery. Save the selected result as `desktop/build/icon.png`.

- [ ] **Step 2: Inspect the source at full and launcher size**

View `desktop/build/icon.png` at original resolution and as a 64px thumbnail. Confirm the silhouette is centered, the monogram remains legible, the edges have transparency, and no generated artifacts or unintended letters are present.

- [ ] **Step 3: Generate the macOS `.icns` asset**

Create a temporary iconset with `sips` sizes 16, 32, 64, 128, 256, 512, and 1024, then run `iconutil -c icns` to produce `desktop/build/icon.icns`. Use a `mktemp -d` directory and remove only that exact temporary directory after conversion.

- [ ] **Step 4: Generate the Windows `.ico` asset**

Use the bundled Python/Pillow runtime to export `desktop/build/icon.ico` with embedded sizes 16, 24, 32, 48, 64, 128, and 256 from `desktop/build/icon.png`:

```python
from PIL import Image

image = Image.open("desktop/build/icon.png").convert("RGBA")
image.save(
    "desktop/build/icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
```

- [ ] **Step 5: Configure Electron Builder**

Update `desktop/electron-builder.yml` with explicit icons and the runtime PNG:

```yaml
extraResources:
  - from: build/icon.png
    to: icon.png
mac:
  category: public.app-category.developer-tools
  icon: build/icon.icns
  target: dir
linux:
  icon: build/icon.png
  target: dir
win:
  icon: build/icon.ico
  target: dir
```

- [ ] **Step 6: Validate assets and packaging**

Run from the repository root:

```bash
file desktop/build/icon.png desktop/build/icon.icns desktop/build/icon.ico
sips -g pixelWidth -g pixelHeight desktop/build/icon.png
cd desktop
npm run package
```

Expected: PNG is 1024x1024, `file` recognizes all three formats, and Electron Builder exits 0 with a `release/**/9rh.app` directory on macOS.

Inspect the package:

```bash
test -f release/mac*/9rh.app/Contents/Resources/icon.icns
test -f release/mac*/9rh.app/Contents/Resources/icon.png
```

Expected: both checks exit 0.

- [ ] **Step 7: Commit the branding assets**

```bash
git add desktop/build/icon.png desktop/build/icon.icns desktop/build/icon.ico desktop/electron-builder.yml
git commit -m "feat(desktop): add native 9rh application icon"
```

### Task 4: Resolve Dependabot Alerts

**Files:**
- Modify: `package-lock.json`

- [ ] **Step 1: Record the vulnerable baseline**

Run from the repository root:

```bash
npm audit --json
```

Expected before remediation: four vulnerable package names—`baseline-browser-mapping`, `brace-expansion`, `browserslist`, and `js-yaml`—with one moderate and three high aggregate findings.

- [ ] **Step 2: Apply npm's patched lockfile resolutions**

Run:

```bash
npm audit fix --package-lock-only
```

Do not accept a semver-major direct dependency change. Inspect `git diff -- package.json package-lock.json`; `package.json` must remain unchanged and lockfile changes must be limited to transitive resolution/integrity updates required by npm.

- [ ] **Step 3: Verify both dependency trees**

Run:

```bash
npm audit
cd desktop
npm audit
```

Expected: both audits report `found 0 vulnerabilities`.

- [ ] **Step 4: Commit the security resolution update**

```bash
git add package-lock.json
git commit -m "chore(deps): resolve Dependabot alerts"
```

### Task 5: Full Verification and Visual Smoke Check

**Files:**
- Modify only if a verification failure exposes a defect in the files already listed above.

- [ ] **Step 1: Run the complete root verification**

Run from the repository root:

```bash
npm test -- --runInBand
npm run build
npm audit
```

Expected: all root tests pass, TypeScript build exits 0, and the audit reports zero vulnerabilities.

- [ ] **Step 2: Run the complete desktop verification**

Run:

```bash
cd desktop
npm test
npm run typecheck
npm run build
npm audit
NINERH_SMOKE=1 ./node_modules/.bin/electron out/main/index.js
npm run package
```

Expected: all Vitest tests pass; typecheck, build, audit, smoke, and package commands exit 0; smoke prints `SMOKE OK`.

- [ ] **Step 3: Inspect the packaged macOS application**

Launch the generated `release/mac*/9rh.app` and confirm:

- the traffic lights sit entirely inside the 36px title strip;
- the `9rh` navigation brand begins below the traffic lights;
- dragging any empty point in the title strip moves the window;
- buttons and form controls remain clickable;
- the Dock, Finder, and application switcher show the new 9rh icon.

- [ ] **Step 4: Review the final diff for scope and unrelated work**

Run:

```bash
git status --short
git diff HEAD~4 -- desktop package-lock.json
```

Expected: changes are limited to the planned desktop chrome/branding files and root lockfile. The pre-existing unrelated modification to `src/__tests__/indexer.test.ts` remains unstaged and absent from these commits.

- [ ] **Step 5: Record final evidence**

Summarize exact test counts, audit results, package output path, and any environment-limited manual check. Do not claim a visual behavior was manually verified unless the packaged window was actually launched and inspected.
