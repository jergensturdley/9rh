# 9rh desktop

An Electron app that hosts 9rh agent sessions and a console for the local 9router in one window. The engine is the `9rh` package from the repository root; this folder is UI and wiring. It adds no second agent loop, ledger, or router client, and it changes nothing about agent behavior, tool sandboxing, or the CLI.

## What it does

| Page | Shortcut | Contents |
|------|----------|----------|
| Agent | Cmd/Ctrl+1 | Sessions sidebar, streaming transcript (thinking, tool cards, markers, team sections, receipts), composer, HUD, ask-user and approval modals, Stop and Abort, Brief, Skills, Rewind, Diff, run report viewer |
| Router | Cmd/Ctrl+2 | 9router status with Start, Stop, and Restart; tabs for Providers, Combos, Keys, Models, Usage, Settings (read-only), and the embedded Dashboard |
| Replays | Cmd/Ctrl+3 | Plays a flight-recorder log from `~/.9rh/runs` into a read-only transcript at 1x to 10x |
| Settings | Cmd/Ctrl+4 | CLI defaults (`~/.9rh/config.json`), app preferences (`~/.9rh/desktop.json`), a backend detection check, About |

Cmd/Ctrl+K opens the command palette (sessions, session actions, router process control, page navigation). The user-facing walkthrough lives in the [Desktop app](../docs/full-documentation.md#desktop-app) section of the full documentation.

## Prerequisites

- Node 22.12 or newer. Electron 44 and Vite 7 both require it; the CLI alone still runs on Node 18.
- The root package built. `package.json` depends on `"9rh": "file:.."`, so `node_modules/9rh` links to the repository root and resolves to `../dist/main.js` (typings at `../dist/main.d.ts`). Run `npm install && npm run build` at the root first; without `dist/` neither the build nor the typecheck works here.
- 9router at `http://127.0.0.1:20128` for router-mode sessions and the Router page. Direct-mode sessions (any OpenAI-compatible endpoint) work without it. `NINE_ROUTER_URL` moves the router base; the embedded dashboard only allows the default local address.

## Commands

All inside `desktop/`.

| Command | Effect |
|---------|--------|
| `npm install` | Installs Electron, React, electron-vite, Vitest, electron-builder, and the `9rh` link |
| `npm run dev` | Electron against the Vite dev server: renderer hot reload, main and preload rebuild on change |
| `npm run build` | Builds main (ESM), preload, and renderer into `out/` |
| `npm run preview` | Builds, then launches the built app |
| `npm run typecheck` | `tsc --noEmit` for `tsconfig.node.json` (main, preload, shared, configs) and `tsconfig.web.json` (renderer, shared) |
| `npm test` | Vitest over `src/**/*.test.ts` in a Node environment |
| `NINERH_SMOKE=1 ./node_modules/.bin/electron out/main/index.js` | Headless smoke check over the built app (run `npm run build` first); prints `SMOKE OK` or `SMOKE FAIL: <reason>` and exits |
| `npm run package` | Builds, then `electron-builder --dir` into `release/` |

Run a single test file with `npx vitest run src/main/diff.test.ts`.

If `node_modules/electron/dist` is missing after `npm install` (seen with npm 11), run `node node_modules/electron/install.js` in this folder to download the Electron binary. `npm run dev`, `npm run preview`, and the smoke check all need it.

### Smoke check

With `NINERH_SMOKE=1` the main process points `NINE_RH_HOME` at a fresh temporary directory, opens the window hidden, waits for the renderer to load, checks that `window.ninerh` exists (the preload bridge came up), and calls the `sessions:list` handler. Exit code 0 on `SMOKE OK`, 1 on failure or after a 20 s timeout. The real `~/.9rh` is never touched.

## Layout

```
electron.vite.config.ts   main (ESM), preload, renderer; aliases @shared and @renderer
electron-builder.yml      packaging stub (dir targets, no signing)
vitest.config.ts          node environment, src/**/*.test.ts
src/
  shared/
    ipc.ts                channel names (CH), request/response/push shapes, IpcResult, the window.ninerh type
    routerTypes.ts        9router /api/* record shapes and the request-log line parser
  main/
    index.ts              app lifecycle, single instance, window bounds, webview allowlist, smoke mode
    ipc.ts                one handler per channel; argument checks; every handler resolves to an IpcResult
    sessionHost.ts        one session: Agent or Orchestrator, SessionLedger, event ring buffer, HITL slot
    sessionRegistry.ts    create/list/remove sessions; backend resolution and default model
    routerClient.ts       fetch wrapper over 9router /api/*; the only module that knows router URLs
    routerProcess.ts      start (ensureRouter), stop (POST /api/shutdown), restart
    backendService.ts     BackendChoice to 9rh DetectOptions, plus a health probe
    replayService.ts      lists ~/.9rh/runs and plays a log through renderEventLog
    appState.ts           ~/.9rh/desktop.json read/write
    diff.ts               line diff over the ledger's before/after records
    shell.ts              folder picker, open path or URL, read a run report
  preload/index.ts        contextBridge: builds window.ninerh from CH
  renderer/
    app/                  App shell, left rail, keyboard shortcuts, palette actions
    pages/                AgentPage, RouterPage, ReplaysPage, SettingsPage
    components/           transcript blocks, HUD, composer, modals, dialogs, router/ panels
    state/                sessionsStore, pure reducers (transcript, hud, teamLanes), routerStore, replayStore, useAsync
    styles/theme.css      CSS variables; dark by default, light under prefers-color-scheme
```

## Conventions

- TypeScript strict, ESM, bundler resolution. Relative imports carry no `.js` suffix (the root package is the opposite). Aliases: `@shared/*` to `src/shared`, `@renderer/*` to `src/renderer`.
- `src/shared/ipc.ts`, `src/shared/routerTypes.ts`, and `src/renderer/state/types.ts` are the contracts. Preload and the IPC handlers both derive from `CH`, so a channel added on one side only is a typecheck error.
- The renderer never imports `9rh` or Node built-ins at runtime. It is a browser bundle behind `contextIsolation`; `import type` from `9rh` or `@shared/ipc` is fine, and everything else arrives as data over `window.ninerh`.
- Every IPC handler resolves to `{ ok: true, value } | { ok: false, error }`. Nothing throws across the bridge.
- React 19 function components and hooks, no state library, no CSS framework, no new dependencies. Each component imports a co-located `.css` file and uses the variables from `theme.css`.
- Tests sit next to the module they cover and stay DOM-free: reducers, services with injected fakes, formatters. Nothing renders a component.
- Deliberate shortcuts carry a `// ponytail:` comment that names the ceiling and the upgrade path.
- Engine additions the app needs go into the root `src/main.ts` as additive re-exports.

## Where state lives

| Path | Contents |
|------|----------|
| `~/.9rh/desktop.json` | Recent workdirs (last 10), last model, last backend choice (never the API key), window bounds, preferences |
| `~/.9rh/config.json` | Defaults shared with the CLI: model, provider, backend, report path, `keepReports` |
| `~/.9rh/runs/` | Flight-recorder logs written by agent turns; the Replays page reads them |
| `~/.9rh/last-run.html`, `~/.9rh/reports/` | Run reports; the in-app viewer only opens `.html` files under the 9rh home |

`NINE_RH_HOME` relocates the whole tree. Direct-mode API keys stay in memory for the life of a session.

## Packaging

`electron-builder.yml` is a stub: app id `dev.9rh.desktop`, product name `9rh`, `dir` targets for macOS, Linux, and Windows, output under `release/`, and an `asarUnpack` rule so the engine's `dist/` ships alongside its runtime dependencies. No signing, notarization, installer, or auto-update. `out/`, `release/`, and `node_modules/` are gitignored.
