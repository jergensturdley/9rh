# Desktop Native Chrome, Icon, and Dependency Remediation

## Goal

Polish the Electron desktop app so its macOS window controls do not cover application content, the window can be dragged naturally, packaged and development builds use a distinctive 9rh icon, and all currently open Dependabot alerts are resolved without regressions.

## Current Findings

- `BrowserWindow` uses `titleBarStyle: "hiddenInset"` on macOS, but the renderer reserves no vertical title-bar area. The traffic lights therefore overlap the `9rh` brand in the 64px navigation rail.
- No renderer element uses `-webkit-app-region: drag`, leaving the hidden title bar without a draggable surface.
- `electron-builder.yml` and `BrowserWindow` specify no icon assets. Packaged builds and development launches consequently fall back to Electron branding.
- `npm audit` reports no vulnerabilities in `desktop/package-lock.json`. The repository root lockfile has four vulnerable transitive development dependencies: `baseline-browser-mapping`, `brace-expansion`, `browserslist`, and `js-yaml`.

## Window Chrome Design

Keep the macOS `hiddenInset` title bar and add a dedicated 36px title strip above the application grid on macOS only. The traffic lights occupy their native upper-left position in this strip, so the navigation logo begins below them and remains unobscured.

The strip is the primary window-drag surface. Non-interactive chrome may also be draggable where useful, while buttons, inputs, links, and other controls are explicitly marked non-draggable. Other platforms retain their normal system title bars and receive no extra spacing.

Platform-dependent Electron window options will be isolated in a small testable function. Renderer platform styling will use an explicit platform signal rather than guessing from layout dimensions.

## Icon Design and Packaging

Create a 1024px source icon with:

- a dark navy, macOS-style rounded-square silhouette;
- a dimensional blue-to-cyan `9rh` monogram;
- restrained routing or terminal geometry that makes the mark specific to 9rh;
- strong contrast and readable shapes at launcher sizes;
- no generic code brackets or stock Electron imagery.

Generate the platform assets required by Electron Builder:

- macOS `.icns`;
- Windows `.ico`;
- Linux/source `.png`.

Configure Electron Builder to use these assets. Development launches on macOS will also set the Dock icon explicitly, while packaged macOS builds use the application bundle icon. Windows and Linux windows will receive their configured icon through `BrowserWindow` where appropriate.

## Dependency Remediation

Refresh only the dependency resolutions needed to move the four vulnerable transitive packages to patched releases. Avoid unrelated major upgrades. Validate the result against both local `npm audit` output and the repository's open Dependabot alert package/version ranges.

Because the alerts affect the root development toolchain rather than desktop runtime dependencies, the root build and test suite are required verification alongside the desktop checks.

## Testing and Verification

Use test-first changes for executable behavior:

1. Add failing coverage for platform-specific window chrome options and icon selection.
2. Implement the smallest main-process/platform changes needed to satisfy the tests.
3. Add renderer coverage for the macOS chrome marker and interactive no-drag behavior where the existing test setup supports DOM assertions.

Generated image files, Electron Builder configuration, and lockfile-only security resolution changes are not meaningfully unit-testable. Verify them through artifact inspection and these commands:

- root `npm audit`;
- desktop `npm audit`;
- root tests and build;
- desktop tests, typecheck, build, and directory packaging;
- macOS smoke launch or packaged-app inspection confirming the bundle icon and window startup.

## Scope Boundaries

- Do not redesign the application navigation, session layout, or general theme.
- Do not replace native macOS traffic lights with custom buttons.
- Do not add a tray/menu-bar application mode; the request concerns application/launcher branding.
- Do not perform unrelated dependency upgrades or refactors.

## Acceptance Criteria

1. macOS traffic lights never overlap the 9rh logo or other renderer content.
2. Dragging the dedicated top strip moves the application window.
3. All visible interactive controls remain clickable and do not initiate window dragging.
4. Development and packaged app surfaces use the new 9rh icon instead of Electron's generic icon.
5. macOS, Windows, and Linux package configuration points at valid icon assets.
6. Root and desktop audits report zero known vulnerabilities.
7. Root and desktop builds and automated tests pass.
